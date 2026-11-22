import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Address, type WalletClient } from "viem";
import {
  ELOSCAPE, GRID, MIN_DEPLOY, SEAL_LEAD_SECONDS, ELO_MIN_SWAP, GLOAM_EXIT_FEE_BPS, collect, grossFor, liveRound, owed, privateAuto, privatePlay, sealedPlay, sendSeatElo, splitPlay, splitSizes,
  type LiveRound, type Seat,
} from "@privacy-for-elysium/eloscape";
import { Footer, REPO, SDK_DOCS, TopBar, go } from "../../pages/chrome";
import { connectWallet, publicClient, visible } from "../../wallet";
import { GAME_ABI } from "@privacy-for-elysium/eloscape";
import { fallbackFor, privateHype, receiveRoute, seatBook, sweepFallbacks, unlockPrivate, type Private } from "../../privacy";

const EXPLORER = "https://elysium.kinetiq.xyz/explorer/address/";
const fmt = (v: bigint, d = 4) => {
  const s = Number(formatEther(v));
  return s === 0 ? "0" : s < 10 ** -d ? `<${10 ** -d}` : s.toLocaleString(undefined, { maximumFractionDigits: d });
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
type BookSeat = Seat & { label: string; done?: boolean };

/** Small per-device cache, so the page shows the last known values at once instead of an empty "loading" state. */
const cache = {
  get<T>(k: string): T | null {
    try {
      const v = localStorage.getItem(`pfe.cache.${k}`);
      return v ? (JSON.parse(v) as T) : null;
    } catch {
      return null;
    }
  },
  set(k: string, v: unknown) {
    try {
      localStorage.setItem(`pfe.cache.${k}`, JSON.stringify(v));
    } catch {}
  },
};

function WalletChip({ address, onDisconnect }: { address: string; onDisconnect: () => void }) {
  const [open, setOpen] = useState(false);
  const [copied, setCopied] = useState(false);
  return (
    <div className="wallet-menu">
      <button className="btn wallet-btn" onClick={() => setOpen(!open)} aria-expanded={open}>
        <span className="dot" />
        {short(address)}
        <span className="chev">▾</span>
      </button>
      {open && (
        <>
          <div className="menu-scrim" onClick={() => setOpen(false)} />
          <div className="menu">
            <button
              onClick={() => {
                navigator.clipboard?.writeText(address).catch(() => {});
                setCopied(true);
                setTimeout(() => setCopied(false), 1200);
              }}
            >
              {copied ? "Copied" : "Copy address"}
            </button>
            <a href={EXPLORER + address} target="_blank" rel="noreferrer">
              View on explorer
            </a>
            <button onClick={() => (setOpen(false), onDisconnect())}>Disconnect</button>
          </div>
        </>
      )}
    </div>
  );
}
const blockWord = (bs: number[]) => `block${bs.length > 1 ? "s" : ""} ${bs.map((b) => b + 1).join(", ")}`;

type LastRound = { id: string; winningBlock: number; settled: boolean };

function useRound() {
  const [round, setRound] = useState<LiveRound | null>(() => {
    const c = cache.get<{ id: string; startTime: number; endTime: number }>("round");
    return c ? { id: BigInt(c.id), startTime: c.startTime, endTime: c.endTime, totalDeployed: 0n, minerCount: 0n, deployed: [] } : null;
  });
  const [last, setLast] = useState<LastRound | null>(() => cache.get<LastRound>("lastRound"));
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const skew = useRef(0); // chain clock minus device clock
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (!visible()) return;
      try {
        const [r, b] = await Promise.all([liveRound(publicClient), publicClient.getBlock()]);
        skew.current = Number(b.timestamp) - Math.floor(Date.now() / 1000);
        if (!live) return;
        setRound(r);
        cache.set("round", { id: r.id.toString(), startTime: r.startTime, endTime: r.endTime });
        const prev = r.id - 1n;
        const [, , winningBlock, settled] = await publicClient.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "roundTotals", args: [prev] });
        const l = { id: prev.toString(), winningBlock: Number(winningBlock), settled };
        setLast(l);
        cache.set("lastRound", l);
      } catch {}
    };
    tick();
    const a = setInterval(tick, 5000);
    const c = setInterval(() => setNow(Math.floor(Date.now() / 1000) + skew.current), 500);
    return () => ((live = false), clearInterval(a), clearInterval(c));
  }, []);
  return { round, now, last };
}

export function EloscapePage() {
  const { round, now, last } = useRound();
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [p, setP] = useState<Private | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [blocks, setBlocks] = useState<number[]>([]);
  const [mode, setMode] = useState<"once" | "auto">("once");
  const [perBlock, setPerBlock] = useState("0.01");
  const [rounds, setRounds] = useState(10);
  const [sealed, setSealed] = useState(true);
  const [split, setSplit] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [seats, setSeats] = useState<BookSeat[]>([]);
  const [owedBy, setOwedBy] = useState<Record<string, Awaited<ReturnType<typeof owed>> & { held: bigint }>>({});
  const [shieldAmt, setShieldAmt] = useState("1");
  const [outTo, setOutTo] = useState("");
  const [outAmt, setOutAmt] = useState("");
  const [eloTo, setEloTo] = useState("");
  const [sheet, setSheet] = useState<"" | "shield" | "withdraw">("");
  const [eloMode, setEloMode] = useState<"swap" | "keep">(() => (cache.get<string>("eloMode") === "keep" ? "keep" : "swap"));
  const setEloModeSaved = (m: "swap" | "keep") => (setEloMode(m), cache.set("eloMode", m));
  const [showAll, setShowAll] = useState(false);
  const [syncErr, setSyncErr] = useState("");
  const [lastMine, setLastMine] = useState<{ round: string; won: number; lost: number } | null>(null);

  const book = useMemo(() => (p ? seatBook(p.address) : null), [p]);
  const cachedBal = useMemo(() => {
    const v = p ? cache.get<string>(`bal.${p.address}`) : null;
    return v ? BigInt(v) : null;
  }, [p]);
  const refresh = useCallback(async () => {
    if (!p || !book || !visible()) return;
    try {
      const b = await privateHype(p.core);
      setBal(b);
      cache.set(`bal.${p.address}`, b.toString());
      setSyncErr("");
    } catch (e) {
      const why = e instanceof Error ? (e as { shortMessage?: string }).shortMessage ?? e.message.split("\n")[0] : String(e);
      console.error("balance read failed:", e);
      setSyncErr(
        /429|too many/i.test(why) ? "The public RPC is busy (rate limit). Retrying shortly…" : `Couldn't read your balance (${why.slice(0, 160)}). Retrying…`,
      );
      return;
    }
    const list = book.load();
    setSeats(list);
    const out: typeof owedBy = {};
    for (const s of list.filter((x) => !x.done)) {
      const o = await owed(publicClient, s.account); // includes the seat's own balance (held)
      out[s.account] = o;
    }
    setOwedBy(out);
  }, [p, book]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 30000);
    return () => clearInterval(t);
  }, [refresh]);

  useEffect(() => {
    if (!book || !last?.settled) return;
    let live = true;
    (async () => {
      const recent = book.load().slice(-30);
      const masks = await Promise.all(
        recent.map((s) =>
          publicClient
            .readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "getMiner", args: [BigInt(last.id), s.account] })
            .then((m) => m.deployedMask)
            .catch(() => 0n),
        ),
      );
      const played = masks.filter((m) => m !== 0n);
      const won = played.filter((m) => (m >> BigInt(last.winningBlock)) & 1n).length;
      if (live) setLastMine({ round: last.id, won, lost: played.length - won });
    })();
    return () => {
      live = false;
    };
  }, [book, last?.id, last?.settled]);

  const run = async (label: string, f: () => Promise<unknown>) => {
    setBusy(true);
    setError("");
    setStatus(label);
    try {
      await f();
      await refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message.split("\n")[0] : String(e));
    } finally {
      setBusy(false);
    }
  };
  const remember = (made: Seat[], label: string) => {
    if (!book) return;
    book.save([...book.load(), ...made.map((s) => ({ ...s, label }))]);
  };

  const connect = () =>
    run("Connecting wallet", async () => {
      const w = wallet ?? (await connectWallet());
      setWallet(w);
      setStatus("Sign once to open your private account (no transaction, no gas)");
      const u = await unlockPrivate(w);
      setP(u);
      setStatus("");
      sweepFallbacks(u.priv, u.address).catch(() => {}); // a timed-out seat's funds, back into the private balance
    });

  const disconnect = () => {
    setP(null);
    setWallet(null);
    setBal(null);
    setSeats([]);
    setOwedBy({});
    setLastMine(null);
    setSheet("");
  };

  /** A seat has something to collect: HYPE, a running Auto, or (when swapping) enough ELO to be worth it. */
  const due = (s: BookSeat) => {
    const o = owedBy[s.account];
    return !!o && (o.hype + o.held > 0n || o.autoActive || (eloMode === "swap" && o.elo >= ELO_MIN_SWAP));
  };
  const markCollected = (s: BookSeat, swapped: boolean) => {
    if (!book) return;
    const keepsElo = eloMode === "keep" && (owedBy[s.account]?.elo ?? 0n) > 0n;
    book.save(book.load().map((x) => (x.account === s.account ? { ...x, done: swapped || !keepsElo } : x)));
  };
  const relayLimited = (e: unknown) => /429|your share|budget|too many/i.test(e instanceof Error ? e.message : String(e));

  /** Every seat with something due, one after another; a failing seat is skipped, a relay limit pauses the run. */
  const collectAll = () =>
    run("Collecting all seats", async () => {
      const list = seats.filter((s) => !s.done && due(s));
      let ok = 0;
      let failed = 0;
      for (let i = 0; i < list.length; i++) {
        setStatus(`Collecting seat ${i + 1} of ${list.length}${eloMode === "swap" ? " (with its ELO)" : ""}`);
        try {
          const r = await collect(p!.core, list[i], () => {}, receiveRoute(p!.priv, p!.address), { swapElo: eloMode === "swap" });
          markCollected(list[i], r.eloSwapped > 0n);
          ok++;
        } catch (e) {
          if (relayLimited(e)) {
            setStatus(`Collected ${ok} of ${list.length}. The relay's hourly limit is reached; press Collect all again later for the rest.`);
            return;
          }
          failed++;
        }
      }
      setStatus(list.length ? `Collected ${ok} seat${ok === 1 ? "" : "s"}${failed ? `; ${failed} failed and stay listed` : ""}.` : "Nothing to collect.");
    });

  /** Keep mode: every seat's ELO to one address (that links those seats to each other on chain). */
  const sendAllElo = () =>
    run("Sending ELO", async () => {
      if (!isAddress(eloTo)) throw new Error("Enter the address to send ELO to.");
      const list = seats.filter((s) => !s.done && (owedBy[s.account]?.elo ?? 0n) > 0n);
      let ok = 0;
      for (let i = 0; i < list.length; i++) {
        setStatus(`Sending ELO from seat ${i + 1} of ${list.length}`);
        try {
          await sendSeatElo(p!.core, list[i], eloTo as Address);
          ok++;
          const o = owedBy[list[i].account];
          if (book && o && o.hype + o.held === 0n && !o.autoActive) book.save(book.load().map((x) => (x.account === list[i].account ? { ...x, done: true } : x)));
        } catch (e) {
          if (relayLimited(e)) {
            setStatus(`Sent from ${ok} of ${list.length} seats. The relay's hourly limit is reached; try again later for the rest.`);
            return;
          }
        }
      }
      setStatus(`ELO sent from ${ok} seat${ok === 1 ? "" : "s"}.`);
    });

  const toggleBlock = (b: number) => setBlocks((x) => (x.includes(b) ? x.filter((y) => y !== b) : [...x, b].sort((a, c) => a - c)));
  const left = round ? Math.max(0, round.endTime - now) : 0;
  const progress = round ? Math.min(100, ((now - round.startTime) / Math.max(1, round.endTime - round.startTime)) * 100) : 0;

  let per = 0n;
  try {
    per = parseEther(perBlock || "0");
  } catch {}
  const nBlocks = BigInt(blocks.length);
  const perRound = per * nBlocks;
  const net = mode === "auto" ? perRound * BigInt(Math.max(1, rounds)) : perRound; // what Eloscape receives
  const pieces = mode === "once" && split ? splitSizes(net) : null;
  // what leaves the private balance: the play plus Gloam's exit fee (per piece when split)
  const stake = pieces ? pieces.pieces.reduce((a, x) => a + x, 0n) : net > 0n ? grossFor(net) : 0n;
  const exitFee = pieces ? (stake * GLOAM_EXIT_FEE_BPS) / 10_000n : stake - net;
  const tooSmall = per > 0n && per < MIN_DEPLOY;

  const play = () => {
    if (!p || !wallet) return;
    if (!blocks.length) return setError("Pick at least one block.");
    const fallbackTo = fallbackFor(p.priv, p.address); // a fresh receive address per seat: never the wallet
    const on = (s: string) => setStatus(s);
    if (mode === "auto") {
      return run("Starting Private Auto", async () => {
        const label = `Auto · ${blockWord(blocks)} · ${perBlock}/block · ${rounds} rounds`;
        const r = await privateAuto(p.core, { amount: stake, blocks, perBlock: per, fallbackTo, onSeat: (s) => remember([s], label) }, on);
        setStatus(`Auto is running from seat ${short(r.seat.account)}.`);
      });
    }
    const label = `${split ? "Split" : "Play"}${sealed ? " · sealed" : ""} · ${blockWord(blocks)} · ${perBlock}/block`;
    const onSeat = (s: Seat) => remember([s], label);
    return run("Preparing your private play", async () => {
      if (split) {
        const r = await splitPlay(p.core, { amount: stake, blocks, sealed, fallbackTo, onSeat }, on);
        const sent = r.txs.length;
        setStatus(
          sent === r.seats.length
            ? `Played as ${sent} separate seats in round ${"roundId" in r ? r.roundId : round?.id}.`
            : `${sent} of ${r.seats.length} pieces played; the rest are in Your seats, ready to collect.`,
        );
      } else if (sealed) {
        const r = await sealedPlay(p.core, { amount: stake, blocks, fallbackTo, onSeat }, on);
        setStatus(`Sealed play landed in round ${r.roundId}.`);
      } else {
        const r = await privatePlay(p.core, { amount: stake, blocks, fallbackTo, onSeat }, on);
        setStatus(`Played from seat ${short(r.seat.account)}.`);
      }
    });
  };

  const collectSeat = (s: BookSeat) =>
    run("Bringing it back to your private balance", async () => {
      const r = await collect(p!.core, s, setStatus, receiveRoute(p!.priv, p!.address), { swapElo: eloMode === "swap" });
      markCollected(s, r.eloSwapped > 0n);
      setStatus(r.eloSwapped > 0n ? `Back in your private balance, with ${fmt(r.eloSwapped)} ELO swapped to HYPE.` : "Back in your private balance.");
    });

  const lastSecs = `in the last ${SEAL_LEAD_SECONDS}s of the round`;
  const view =
    mode === "auto"
      ? { seen: "A fresh address running Auto: its blocks, amount per block and rounds.", hidden: "Your wallet." }
      : {
          seen: `${split ? "Separate fresh addresses, each a standard piece," : "A fresh address"} on your blocks${sealed ? `, only ${lastSecs}` : ""}${split ? "." : ", with its amount."}`,
          hidden: ["Your wallet", sealed && `your blocks until ${SEAL_LEAD_SECONDS}s before close`, split && "your total amount"].filter(Boolean).join(", ") + ".",
        };
  const openSeats = seats.filter((s) => !s.done);
  const totals = openSeats.reduce(
    (t, s) => {
      const o = owedBy[s.account];
      return o ? { hype: t.hype + o.hype + o.held, elo: t.elo + o.elo } : t;
    },
    { hype: 0n, elo: 0n },
  );
  const ready = !!p;
  const canPlay = ready && !busy && blocks.length > 0 && stake > 0n && !tooSmall && (bal ?? 0n) >= stake;

  return (
    <div className="wrap">
      <TopBar
        right={
          ready ? (
            <WalletChip address={p!.address} onDisconnect={disconnect} />
          ) : (
            <button className="btn primary" onClick={connect} disabled={busy}>
              Connect
            </button>
          )
        }
      />
      <a className="back" href="/" onClick={(e) => go(e, "/")}>
        ← All projects
      </a>
      <section className="hero" style={{ paddingTop: 22 }}>
        <div className="row" style={{ justifyContent: "flex-start", gap: 14 }}>
          <div className="logo" style={{ width: 52, height: 52, borderRadius: 14, background: "#0d0d0f", display: "grid", placeItems: "center" }}>
            <img src="/projects/eloscape/logo.svg" alt="Eloscape logo" style={{ width: 32 }} />
          </div>
          <div>
            <div className="eyebrow">Eloscape · private mode</div>
            <div className="muted small">Unofficial</div>
          </div>
        </div>
        <div className="links">
          <span>
            Eloscape: <a href="https://eloscape.com" target="_blank" rel="noreferrer">eloscape.com</a> ·{" "}
            <a href="https://x.com/eloscapeHQ" target="_blank" rel="noreferrer">@eloscapeHQ</a>
          </span>
          <span>
            Cloak: <a href="https://oncloak.xyz" target="_blank" rel="noreferrer">oncloak.xyz</a> ·{" "}
            <a href="https://oncloak.xyz/docs" target="_blank" rel="noreferrer">docs</a>
          </span>
        </div>
        <h1 style={{ fontSize: "clamp(30px, 5vw, 46px)" }}>Stake HYPE on any block, privately.</h1>
        <p className="lede">
          Mine Eloscape's grid from your private balance. Eloscape sees a fresh address, never your wallet.
        </p>
      </section>

      <div className="notice">
        <b>Not run by Eloscape.</b> Independent and unofficial. Plays go to Eloscape's own contract (
        <a href={EXPLORER + ELOSCAPE.game} target="_blank" rel="noreferrer">{short(ELOSCAPE.game)}</a>) under its rules and fees. Your HYPE sits in
        Gloam's shielded vault; Gloam keeps 0.5% when it leaves. Verify the code:{" "}
        <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>.
      </div>

      <div className="layout">
        <div>
          <div className="panel">
            <div className="row">
              <div>
                <div className="muted small">Round</div>
                <div className="stat">{round ? `#${round.id}` : <span className="shimmer" style={{ width: 90, height: 26 }} />}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="muted small">{round && left === 0 ? "Next round in" : "Closes in"}</div>
                <div className="stat">
                  {!round ? <span className="shimmer" style={{ width: 50, height: 26 }} /> : left > 0 ? `${left}s` : `${Math.max(0, round.endTime + 12 - now)}s`}
                </div>
              </div>
            </div>
            <div className="timer">
              <i style={{ width: `${progress}%` }} />
            </div>
            <div className="board-actions">
              <span className="muted small">{blocks.length ? `${blocks.length} selected` : "Select blocks"}</span>
              <span>
                <button onClick={() => setBlocks([Math.floor(Math.random() * GRID)])}>Random</button>
                <button onClick={() => setBlocks(Array.from({ length: GRID }, (_, i) => i))}>All</button>
                <button onClick={() => setBlocks([])} disabled={!blocks.length}>Clear</button>
              </span>
            </div>
            <div className="board">
              {Array.from({ length: GRID }, (_, b) => (
                <button key={b} className={`cell ${blocks.includes(b) ? "on" : ""}`} onClick={() => toggleBlock(b)} aria-pressed={blocks.includes(b)}>
                  <span className="id">{b + 1}</span>
                </button>
              ))}
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Pick your blocks. Round and countdown are live from Eloscape's contract.
            </p>
            {last && (
              <div className="lastround">
                <span>
                  Last round <b>#{last.id}</b>: {last.settled ? <>block <b>{last.winningBlock + 1}</b> won</> : "settling…"}
                </span>
                {lastMine && lastMine.round === last.id && lastMine.won + lastMine.lost > 0 && (
                  <span className={lastMine.won ? "won" : "lost"}>
                    {lastMine.won ? `You won${lastMine.won + lastMine.lost > 1 ? ` (${lastMine.won} of ${lastMine.won + lastMine.lost} seats)` : ""}` : "You lost"}
                  </span>
                )}
              </div>
            )}
          </div>

        </div>

        <div>
          <div className="panel">
            <div className="muted small">Private balance</div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="stat" data-testid="private-balance">
                {!ready ? "—" : bal !== null ? `${fmt(bal)} HYPE` : cachedBal !== null ? <span className="stale">{fmt(cachedBal)} HYPE</span> : <span className="shimmer" style={{ width: 120, height: 26 }} />}
              </span>
              <span style={{ display: "flex", gap: 8 }}>
                <button className={`btn ${sheet === "shield" ? "primary" : ""}`} disabled={busy} onClick={() => (ready ? setSheet(sheet === "shield" ? "" : "shield") : connect())}>
                  Shield
                </button>
                <button className={`btn ${sheet === "withdraw" ? "primary" : ""}`} disabled={busy} onClick={() => (ready ? setSheet(sheet === "withdraw" ? "" : "withdraw") : connect())}>
                  Withdraw
                </button>
              </span>
            </div>
            {syncErr && <p className="small err">{syncErr}</p>}
            {ready && sheet === "shield" && (
              <div className="sheet">
                <input className="input" placeholder="HYPE to shield" value={shieldAmt} onChange={(e) => setShieldAmt(e.target.value)} inputMode="decimal" />
                <button
                  className="btn primary"
                  disabled={busy || !shieldAmt}
                  onClick={() => run("Shielding", async () => (await p!.priv.shieldHype(wallet!, parseEther(shieldAmt || "0"), setStatus), setSheet(""), setStatus("Shielded.")))}
                >
                  Shield
                </button>
              </div>
            )}
            {ready && sheet === "withdraw" && (
              <div className="sheet col">
                <input className="input" placeholder="0x… destination address" value={outTo} onChange={(e) => setOutTo(e.target.value.trim())} />
                <div className="sheet" style={{ marginTop: 0 }}>
                  <input className="input" placeholder="HYPE to withdraw" value={outAmt} onChange={(e) => setOutAmt(e.target.value)} inputMode="decimal" />
                  <button
                    className="btn primary"
                    disabled={busy || !isAddress(outTo) || !outAmt}
                    onClick={() => run("Withdrawing", async () => (await p!.priv.unshieldHype(outTo as Address, parseEther(outAmt || "0"), setStatus), setSheet(""), setStatus("Withdrawn.")))}
                  >
                    Withdraw
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="panel play">
            <div className="row">
              <h2 style={{ margin: 0 }}>Play privately</h2>
              <div className="seg">
                <button className={mode === "once" ? "on" : ""} onClick={() => setMode("once")}>
                  This round
                </button>
                <button className={mode === "auto" ? "on" : ""} onClick={() => setMode("auto")}>
                  Auto
                </button>
              </div>
            </div>

            <div className="swap-box">
              <div className="k">
                <span>Amount per block</span>
                <span>{ready && bal !== null ? `Private ${fmt(bal)} HYPE` : ""}</span>
              </div>
              <div className="amt">
                <input value={perBlock} onChange={(e) => setPerBlock(e.target.value)} inputMode="decimal" placeholder="0" aria-label="Amount per block" />
                <span className="token-sel">
                  <img src="/tokens/hype.svg" alt="" width={26} height={26} />
                  HYPE
                </span>
              </div>
            </div>

            {mode === "auto" && (
              <div className="stepper">
                <span>Rounds</span>
                <span className="ctl">
                  <button onClick={() => setRounds(Math.max(1, rounds - 1))} aria-label="Fewer rounds">−</button>
                  <input value={rounds} onChange={(e) => setRounds(Math.max(1, Math.floor(Number(e.target.value.replace(/\D/g, "")) || 1)))} inputMode="numeric" aria-label="Number of rounds" />
                  <button onClick={() => setRounds(rounds + 1)} aria-label="More rounds">+</button>
                </span>
              </div>
            )}

            {mode === "once" && (
              <div className="switches">
                <label className="switch">
                  <span>
                    <b>Seal my blocks</b>
                    <em>Sent {SEAL_LEAD_SECONDS}s before close. Keep this tab open.</em>
                  </span>
                  <input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
                </label>
                <label className="switch">
                  <span>
                    <b>Hide my amount</b>
                    <em>
                      {pieces && pieces.pieces.length
                        ? `Plays as ${pieces.pieces.map((x) => formatEther(x)).join(" + ")}, one address each.`
                        : "Plays as standard pieces, one address each (from 0.001 HYPE)."}
                    </em>
                  </span>
                  <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                </label>
              </div>
            )}

            <div className="summary">
              <div className="kv"><span>Blocks</span><span>{blocks.length || "—"}</span></div>
              <div className="kv"><span>Total per round</span><span>{perRound > 0n ? `${fmt(perRound)} HYPE` : "—"}</span></div>
              {mode === "auto" && <div className="kv"><span>Rounds</span><span>{rounds}</span></div>}
              <div className="kv"><span>Gloam exit fee (0.5%)</span><span>{stake > 0n ? `${fmt(exitFee, 6)} HYPE` : "—"}</span></div>
              <div className="kv total"><span>From your private balance</span><span>{stake > 0n ? `${fmt(stake)} HYPE` : "—"}</span></div>
            </div>

            {ready ? (
              <button className="btn primary big" disabled={!canPlay} onClick={play}>
                {busy
                  ? "Working…"
                  : !blocks.length
                    ? "Select blocks"
                    : tooSmall
                      ? `Min ${formatEther(MIN_DEPLOY)} HYPE per block`
                      : (bal ?? 0n) < stake
                        ? "Not enough private HYPE"
                        : mode === "auto"
                          ? `Start Auto for ${rounds} rounds`
                          : `Play ${blockWord(blocks)}`}
              </button>
            ) : (
              <button className="btn primary big" onClick={connect} disabled={busy}>
                Connect
              </button>
            )}
            <div className="status">{error ? <span className="err">{error}</span> : status}</div>
            <div className="seen-below">
              <div className="kv seen-row"><span>Others see</span><span>{view.seen}</span></div>
              <div className="kv seen-row"><span>Hidden</span><span>{view.hidden}</span></div>
            </div>
          </div>
        </div>
      </div>
      <div className="sdkstrip">
        <span>
          <b>Built on the Cloak SDK.</b> This whole page is a thin layer on it. Bring private mode to your own Elysium dApp.
        </span>
        <a className="btn small" href={SDK_DOCS} target="_blank" rel="noreferrer">
          SDK docs →
        </a>
      </div>
      <div className="panel" style={{ marginBottom: 40 }}>
        <div className="row" style={{ flexWrap: "wrap", gap: 10 }}>
          <h2 style={{ margin: 0 }}>Your seats</h2>
          <span style={{ display: "flex", gap: 8, flexWrap: "wrap", alignItems: "center" }}>
            <span className="seg small" title="What happens to the ELO your seats earn">
              <button className={eloMode === "swap" ? "on" : ""} onClick={() => setEloModeSaved("swap")}>ELO → private HYPE</button>
              <button className={eloMode === "keep" ? "on" : ""} onClick={() => setEloModeSaved("keep")}>Keep ELO</button>
            </span>
            {ready && openSeats.some(due) && (
              <button className="btn small primary" disabled={busy} onClick={collectAll}>
                Collect all ({openSeats.filter(due).length})
              </button>
            )}
          </span>
        </div>
        <p className="muted small" style={{ marginTop: 6 }}>
          One-time addresses that played for you. Collect returns their HYPE to your private balance
          {eloMode === "swap" ? ", and swaps their ELO to HYPE on the way (about 4% in pool and Eloscape fees; amounts under 0.02 ELO stay)." : ". Their ELO stays in them until you send it."}
        </p>
        {!openSeats.length && <p className="muted small">No open seats yet.</p>}
        {openSeats.length > 0 && (
          <div className="seats-sum muted small">
            {openSeats.length} seat{openSeats.length > 1 ? "s" : ""} · {fmt(totals.hype)} HYPE to collect{totals.elo > 0n ? ` · ${fmt(totals.elo)} ELO` : ""}
          </div>
        )}
        {openSeats.slice(0, showAll ? openSeats.length : 8).map((s) => {
          const o = owedBy[s.account];
          return (
            <div key={s.account} className="seat">
              <div className="row">
                <span>{s.label}</span>
                <a href={EXPLORER + s.account} target="_blank" rel="noreferrer">
                  <code>{short(s.account)}</code>
                </a>
              </div>
              <div className="row muted">
                <span className="num">
                  {o ? `${fmt(o.hype + o.held)} HYPE${o.autoActive ? ` · Auto ${fmt(o.autoBalance)} left` : ""}${o.elo > 0n ? ` · ${fmt(o.elo)} ELO` : ""}` : <span className="shimmer" style={{ width: 160, height: 14 }} />}
                </span>
                <button className="btn small" onClick={() => collectSeat(s)} disabled={busy || !due(s)}>
                  {o?.autoActive ? "Stop & collect" : "Collect"}
                </button>
              </div>
            </div>
          );
        })}
        {openSeats.length > 8 && (
          <button className="btn small" style={{ marginTop: 8 }} onClick={() => setShowAll(!showAll)}>
            {showAll ? "Show fewer" : `Show all ${openSeats.length} seats`}
          </button>
        )}
        {eloMode === "keep" && totals.elo > 0n && (
          <div className="field">
            <span>Send all your seats' ELO to one address. Sending from several seats to one address links those seats to each other on chain.</span>
            <div className="sheet">
              <input className="input" placeholder="0x… (a fresh address stays unlinked from your wallet)" value={eloTo} onChange={(e) => setEloTo(e.target.value.trim())} />
              <button className="btn primary" disabled={busy || !isAddress(eloTo)} onClick={sendAllElo}>
                Send all ELO
              </button>
            </div>
          </div>
        )}
      </div>
      <section className="panel howto">
        <h2>How to play</h2>
        <ol>
          <li><b>Connect</b> and sign once. It opens your private account; no transaction, no gas.</li>
          <li><b>Shield</b> HYPE into your private balance. This is the one public step, so do it ahead of time.</li>
          <li><b>Pick blocks</b> on the grid (or Random / All), set the amount per block (and rounds, for Auto), and choose your privacy: <i>Seal</i> hides your blocks until the last seconds, <i>Hide my amount</i> splits your stake into standard pieces.</li>
          <li><b>Play.</b> A fresh address plays for you; your wallet never appears. Too close to the end of a round? It goes into the next one.</li>
          <li><b>Collect</b> after the round: winnings go back into your private balance.</li>
          <li>
            <b>ELO</b> can't enter the vault. Pick once, above your seats: <i>ELO → private HYPE</i> swaps it as you collect (about 4% in pool
            and Eloscape fees), or <i>Keep ELO</i> leaves it in the seats until you send it all to one address.
          </li>
          <li><b>Withdraw</b> to any address whenever you like.</li>
        </ol>
        <h3 style={{ marginTop: 18 }}>Solo and split blocks</h3>
        <p className="muted" style={{ margin: "4px 0 0", fontSize: 14.5 }}>
          Each round, Eloscape makes some blocks <b>solo</b> and the rest <b>split</b>. Everyone on the winning block shares the HYPE pot either
          way; the round's ELO is what differs. On a <b>split</b> block, ELO is shared by everyone on it, in proportion to their stake. On a{" "}
          <b>solo</b> block, all of it goes to <b>one</b> miner, drawn by stake: a bigger stake means better odds, not a guaranteed share. A
          solo-block ELO prize is paid with a signature from Eloscape's server.
        </p>
      </section>
      <Footer />
    </div>
  );
}
