import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Address, type WalletClient } from "viem";
import {
  ELOSCAPE, GRID, MIN_DEPLOY, SEAL_LEAD_SECONDS, collect, liveRound, owed, privateAuto, privatePlay, sealedPlay, sendSeatElo, splitPlay, splitSizes, swapSeatEloToHype,
  type LiveRound, type Seat,
} from "@privacy-for-elysium/eloscape";
import { Footer, REPO, SDK_DOCS, TopBar, go } from "../../pages/chrome";
import { connectWallet, publicClient, visible } from "../../wallet";
import { GAME_ABI } from "@privacy-for-elysium/eloscape";
import { fallbackFor, privateHype, seatBook, sweepFallbacks, unlockPrivate, type Private } from "../../privacy";

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
  const [amount, setAmount] = useState("0.5");
  const [perBlock, setPerBlock] = useState("0.01");
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

  const collectAll = () =>
    run("Collecting all seats", async () => {
      const due = seats.filter((s) => !s.done && owedBy[s.account] && (owedBy[s.account].hype + owedBy[s.account].held > 0n || owedBy[s.account].autoActive));
      for (let i = 0; i < due.length; i++) {
        setStatus(`Collecting seat ${i + 1} of ${due.length}`);
        await collect(p!.core, due[i]);
        if (book) book.save(book.load().map((x) => (x.account === due[i].account ? { ...x, done: (owedBy[x.account]?.elo ?? 0n) === 0n } : x)));
      }
      setStatus(due.length ? `Collected ${due.length} seat${due.length > 1 ? "s" : ""} into your private balance.` : "Nothing to collect.");
    });

  const toggleBlock = (b: number) => setBlocks((x) => (x.includes(b) ? x.filter((y) => y !== b) : [...x, b].sort((a, c) => a - c)));
  const left = round ? Math.max(0, round.endTime - now) : 0;
  const progress = round ? Math.min(100, ((now - round.startTime) / Math.max(1, round.endTime - round.startTime)) * 100) : 0;

  let stake = 0n;
  try {
    stake = parseEther(amount || "0");
  } catch {}
  const pieces = split ? splitSizes(stake) : null;

  const play = () => {
    if (!p || !wallet) return;
    if (!blocks.length) return setError("Pick at least one block.");
    const fallbackTo = fallbackFor(p.priv, p.address); // a fresh receive address per seat: never the wallet
    const on = (s: string) => setStatus(s);
    if (mode === "auto") {
      return run("Starting Private Auto", async () => {
        const label = `Auto · ${blockWord(blocks)} · ${perBlock}/block`;
        const r = await privateAuto(p.core, { amount: stake, blocks, perBlock: parseEther(perBlock), fallbackTo, onSeat: (s) => remember([s], label) }, on);
        setStatus(`Auto is running from seat ${short(r.seat.account)}.`);
      });
    }
    const label = `${split ? "Split" : "Play"}${sealed ? " · sealed" : ""} · ${blockWord(blocks)} · ${amount} HYPE`;
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
      await collect(p!.core, s, setStatus);
      if (book) book.save(book.load().map((x) => (x.account === s.account ? { ...x, done: (owedBy[s.account]?.elo ?? 0n) === 0n } : x)));
      setStatus("Back in your private balance.");
    });

  const eloSwap = (s: BookSeat) =>
    run("Swapping ELO to HYPE", async () => {
      const r = await swapSeatEloToHype(p!.core, s, setStatus);
      if (book) book.save(book.load().map((x) => (x.account === s.account ? { ...x, done: true } : x)));
      setStatus(`Swapped ${fmt(r.eloIn)} ELO; the HYPE is in your private balance.`);
    });

  const eloOut = (s: BookSeat) =>
    run("Sending ELO", async () => {
      if (!isAddress(eloTo)) throw new Error("Enter the address to send ELO to.");
      await sendSeatElo(p!.core, s, eloTo as Address);
      setStatus("ELO sent.");
    });

  const lastSecs = `in the last ${SEAL_LEAD_SECONDS}s of the round`;
  const view =
    mode === "auto"
      ? { seen: "A fresh address running Auto: its blocks, amount per block and rounds.", hidden: "Your wallet." }
      : {
          seen: `${split ? "Separate fresh addresses, each a standard piece," : "A fresh address"} on your blocks${sealed ? `, only ${lastSecs}` : ""}${split ? "." : ", with its amount."}`,
          hidden: ["Your wallet", sealed && `your blocks until ${SEAL_LEAD_SECONDS}s before close`, split && "your total amount"].filter(Boolean).join(", ") + ".",
        };
  const ready = !!p;
  const canPlay = ready && !busy && blocks.length > 0 && stake > 0n && (mode === "once" ? (bal ?? 0n) >= stake : (bal ?? 0n) >= stake);

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

          <div className="panel">
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
            <label className="field">
              {mode === "auto" ? "Fund Auto with (HYPE)" : "Stake (HYPE)"}
              <input className="input" value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" />
            </label>
            {mode === "auto" && (
              <label className="field">
                Per block, per round (HYPE)
                <input className="input" value={perBlock} onChange={(e) => setPerBlock(e.target.value)} inputMode="decimal" />
              </label>
            )}
            {mode === "once" && (
              <>
                <label className="toggle">
                  <input type="checkbox" checked={sealed} onChange={(e) => setSealed(e.target.checked)} />
                  <span>
                    <b>Seal my blocks</b>
                    <em>Sent {SEAL_LEAD_SECONDS}s before close. Keep this tab open.</em>
                  </span>
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                  <span>
                    <b>Also hide my amount</b>
                    <em>
                      Plays as {pieces && pieces.pieces.length ? pieces.pieces.map((x) => formatEther(x)).join(" + ") : "standard pieces"}, each from its own address
                      {pieces && pieces.left > 0n ? ` (${formatEther(pieces.left)} stays in your balance)` : ""}. Smallest piece: 0.001 HYPE.
                    </em>
                  </span>
                </label>
              </>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>
              Min {formatEther(MIN_DEPLOY)} HYPE per block.
            </p>
            <div className="seen">
              <div>
                <span className="muted small">Others see</span>
                <p>{view.seen}</p>
              </div>
              <div>
                <span className="muted small">Hidden</span>
                <p>{view.hidden}</p>
              </div>
            </div>
            <div style={{ marginTop: 14 }}>
              {ready ? (
                <button className="btn primary" style={{ width: "100%" }} disabled={!canPlay} onClick={play}>
                  {busy ? "Working…" : mode === "auto" ? "Start Auto privately" : `Play ${blocks.length ? `block${blocks.length > 1 ? "s" : ""} ${blocks.map((b) => b + 1).join(", ")}` : ""} privately`}
                </button>
              ) : (
                <button className="btn primary" style={{ width: "100%" }} onClick={connect} disabled={busy}>
                  Connect
                </button>
              )}
            </div>
            <div className="status">
              {error ? <span className="err">{error}</span> : status}
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
            <div className="row">
              <h2 style={{ margin: 0 }}>Your seats</h2>
              {ready && seats.filter((s) => !s.done).length > 1 && (
                <button className="btn small" disabled={busy} onClick={collectAll}>
                  Collect all
                </button>
              )}
            </div>
            <p className="muted small" style={{ marginTop: 0 }}>
              One-time addresses that played for you. Collect returns their HYPE to your private balance.
            </p>
            {!seats.filter((s) => !s.done).length && <p className="muted small">No open seats yet.</p>}
            {seats
              .filter((s) => !s.done)
              .map((s) => {
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
                        {o ? `${fmt(o.hype + o.held)} HYPE to collect${o.autoActive ? ` · Auto ${fmt(o.autoBalance)} left` : ""}${o.elo > 0n ? ` · ${fmt(o.elo)} ELO` : ""}` : <span className="shimmer" style={{ width: 160, height: 14 }} />}
                      </span>
                      <span style={{ display: "flex", gap: 6 }}>
                        {o && o.elo > 0n && (
                          <>
                            <button className="btn small" onClick={() => eloSwap(s)} disabled={busy} title="Swap in ELO's pool and keep the HYPE private">
                              ELO → private HYPE
                            </button>
                            <button className="btn small" onClick={() => eloOut(s)} disabled={busy} title="Claim the ELO and send it to an address you choose">
                              Send ELO
                            </button>
                          </>
                        )}
                        <button className="btn small" onClick={() => collectSeat(s)} disabled={busy || !o || (o.hype + o.held === 0n && !o.autoActive)}>
                          {o?.autoActive ? "Stop & collect" : "Collect"}
                        </button>
                      </span>
                    </div>
                  </div>
                );
              })}
            {seats.some((s) => !s.done && (owedBy[s.account]?.elo ?? 0n) > 0n) && (
              <label className="field">
                ELO can't enter the private vault. Swap it to private HYPE (Eloscape's pool and hook fees apply, about 4%), or send it to:
                <input className="input" placeholder="0x… (a fresh address keeps it unlinked)" value={eloTo} onChange={(e) => setEloTo(e.target.value.trim())} />
              </label>
            )}
          </div>
      <section className="panel howto">
        <h2>How to play</h2>
        <ol>
          <li><b>Connect</b> and sign once. It opens your private account; no transaction, no gas.</li>
          <li><b>Shield</b> HYPE into your private balance. This is the one public step, so do it ahead of time.</li>
          <li><b>Pick blocks</b> on the grid, set your stake, and choose your privacy: <i>Seal</i> hides your blocks until the last seconds, <i>Hide my amount</i> splits your stake into standard pieces.</li>
          <li><b>Play.</b> A fresh address plays for you; your wallet never appears. Too close to the end of a round? It goes into the next one.</li>
          <li><b>Collect</b> after the round: winnings go back into your private balance. ELO can't enter the vault, so send it to an address you choose (a fresh one stays unlinked).</li>
          <li><b>Withdraw</b> to any address whenever you like.</li>
        </ol>
      </section>
      <Footer />
    </div>
  );
}
