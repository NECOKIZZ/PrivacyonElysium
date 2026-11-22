import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Address, type WalletClient } from "viem";
import {
  ELOSCAPE, GRID, MIN_DEPLOY, SEAL_LEAD_SECONDS, collect, liveRound, owed, privateAuto, privatePlay, sealedPlay, sendSeatElo, splitPlay, splitSizes,
  type LiveRound, type Seat,
} from "@privacy-for-elysium/eloscape";
import { Footer, REPO, SDK_DOCS, TopBar, go } from "../../pages/chrome";
import { connectWallet, publicClient, visible } from "../../wallet";
import { fallbackFor, privateHype, seatBook, sweepFallbacks, unlockPrivate, type Private } from "../../privacy";

const EXPLORER = "https://elysium.kinetiq.xyz/explorer/address/";
const fmt = (v: bigint, d = 4) => {
  const s = Number(formatEther(v));
  return s === 0 ? "0" : s < 10 ** -d ? `<${10 ** -d}` : s.toLocaleString(undefined, { maximumFractionDigits: d });
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
type BookSeat = Seat & { label: string; done?: boolean };
const blockWord = (bs: number[]) => `block${bs.length > 1 ? "s" : ""} ${bs.map((b) => b + 1).join(", ")}`;

function useRound() {
  const [round, setRound] = useState<LiveRound | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const skew = useRef(0); // chain clock minus device clock
  useEffect(() => {
    let live = true;
    const tick = async () => {
      if (!visible()) return;
      try {
        const [r, b] = await Promise.all([liveRound(publicClient), publicClient.getBlock()]);
        skew.current = Number(b.timestamp) - Math.floor(Date.now() / 1000);
        if (live) setRound(r);
      } catch {}
    };
    tick();
    const a = setInterval(tick, 5000);
    const c = setInterval(() => setNow(Math.floor(Date.now() / 1000) + skew.current), 500);
    return () => ((live = false), clearInterval(a), clearInterval(c));
  }, []);
  return { round, now };
}

export function EloscapePage() {
  const { round, now } = useRound();
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

  const book = useMemo(() => (p ? seatBook(p.address) : null), [p]);
  const refresh = useCallback(async () => {
    if (!p || !book || !visible()) return;
    try {
      setBal(await privateHype(p.core));
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
            <span className="pill live" title={`Wallet ${short(p!.address)} (shown only on this device)`}>● Private mode on</span>
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
                <div className="stat">{round ? `#${round.id}` : "…"}</div>
              </div>
              <div style={{ textAlign: "right" }}>
                <div className="muted small">Closes in</div>
                <div className="stat">{round ? `${left}s` : "…"}</div>
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
          </div>

        </div>

        <div>
          <div className="panel">
            <div className="muted small">Private balance</div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="stat" data-testid="private-balance">{!ready ? "—" : bal === null ? "Syncing…" : `${fmt(bal)} HYPE`}</span>
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
                      {pieces && pieces.left > 0n ? ` (${formatEther(pieces.left)} stays in your balance)` : ""}.
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
            <h2>Your seats</h2>
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
                        {o ? `${fmt(o.hype + o.held)} HYPE to collect${o.autoActive ? ` · Auto ${fmt(o.autoBalance)} left` : ""}${o.elo > 0n ? ` · ${fmt(o.elo)} ELO` : ""}` : "…"}
                      </span>
                      <span style={{ display: "flex", gap: 6 }}>
                        {o && o.elo > 0n && (
                          <button className="btn small" onClick={() => eloOut(s)} disabled={busy}>
                            Send ELO
                          </button>
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
                ELO can't enter the private vault. Send it to:
                <input className="input" placeholder="0x… (a fresh address keeps it unlinked)" value={eloTo} onChange={(e) => setEloTo(e.target.value.trim())} />
              </label>
            )}
          </div>
      <Footer />
    </div>
  );
}
