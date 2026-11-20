import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { formatEther, isAddress, parseEther, type Address, type WalletClient } from "viem";
import {
  ELOSCAPE, GRID, MIN_DEPLOY, SEAL_LEAD_SECONDS, collect, liveRound, owed, privateAuto, privatePlay, sealedPlay, sendSeatElo, splitPlay, splitSizes,
  type LiveRound, type Seat,
} from "@privacy-for-elysium/eloscape";
import { Footer, TopBar } from "../../pages/chrome";
import { connectWallet, publicClient } from "../../wallet";
import { fallbackFor, privateHype, seatBook, sweepFallbacks, unlockPrivate, type Private } from "../../privacy";

const EXPLORER = "https://elysium.kinetiq.xyz/explorer/address/";
const fmt = (v: bigint, d = 4) => {
  const s = Number(formatEther(v));
  return s === 0 ? "0" : s < 10 ** -d ? `<${10 ** -d}` : s.toLocaleString(undefined, { maximumFractionDigits: d });
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
type BookSeat = Seat & { label: string; done?: boolean };

function useRound() {
  const [round, setRound] = useState<LiveRound | null>(null);
  const [now, setNow] = useState(() => Math.floor(Date.now() / 1000));
  const skew = useRef(0); // chain clock minus device clock
  useEffect(() => {
    let live = true;
    const tick = async () => {
      try {
        const [r, b] = await Promise.all([liveRound(publicClient), publicClient.getBlock()]);
        skew.current = Number(b.timestamp) - Math.floor(Date.now() / 1000);
        if (live) setRound(r);
      } catch {}
    };
    tick();
    const a = setInterval(tick, 2500);
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

  const book = useMemo(() => (p ? seatBook(p.address) : null), [p]);
  const refresh = useCallback(async () => {
    if (!p || !book) return;
    setBal(await privateHype(p.core));
    const list = book.load();
    setSeats(list);
    const out: typeof owedBy = {};
    for (const s of list.filter((x) => !x.done)) {
      const [o, held] = await Promise.all([owed(publicClient, s.account), publicClient.getBalance({ address: s.account })]);
      out[s.account] = { ...o, held };
    }
    setOwedBy(out);
  }, [p, book]);
  useEffect(() => {
    refresh();
    const t = setInterval(refresh, 15000);
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
        const label = `Auto · blocks ${blocks.map((b) => b + 1).join(", ")} · ${perBlock}/block`;
        const r = await privateAuto(p.core, { amount: stake, blocks, perBlock: parseEther(perBlock), fallbackTo, onSeat: (s) => remember([s], label) }, on);
        setStatus(`Auto is running from seat ${short(r.seat.account)}.`);
      });
    }
    const label = `${split ? "Split" : "Play"}${sealed ? " · sealed" : ""} · blocks ${blocks.map((b) => b + 1).join(", ")} · ${amount} HYPE`;
    const onSeat = (s: Seat) => remember([s], label);
    return run("Preparing your private play", async () => {
      if (split) {
        const r = await splitPlay(p.core, { amount: stake, blocks, sealed, fallbackTo, onSeat }, on);
        setStatus(`Played as ${r.seats.length} separate seats in round ${"roundId" in r ? r.roundId : round?.id}.`);
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

  const ready = !!p;
  const canPlay = ready && !busy && blocks.length > 0 && stake > 0n && (mode === "once" ? (bal ?? 0n) >= stake : (bal ?? 0n) >= stake);

  return (
    <div className="wrap">
      <TopBar
        right={
          ready ? (
            <span className="pill live">● Private · {short(p!.address)}</span>
          ) : (
            <button className="btn primary" onClick={connect} disabled={busy}>
              Connect & go private
            </button>
          )
        }
      />
      <a className="back" href="#/">
        ← All projects
      </a>
      <section className="hero" style={{ paddingTop: 22 }}>
        <div className="row" style={{ justifyContent: "flex-start", gap: 14 }}>
          <div className="logo" style={{ width: 52, height: 52, borderRadius: 14, background: "#0d0d0f", display: "grid", placeItems: "center" }}>
            <img src="/projects/eloscape/logo.svg" alt="Eloscape logo" style={{ width: 32 }} />
          </div>
          <div>
            <div className="eyebrow">Eloscape · private mode</div>
            <div className="muted small">Unofficial · by Cloak</div>
          </div>
        </div>
        <h1 style={{ fontSize: "clamp(30px, 5vw, 46px)" }}>Stay HYPE on any block, privately.</h1>
        <p className="lede">
          Mine Eloscape's 5×5 grid from a private balance. Eloscape sees a fresh seat play, never your wallet. Seal your block until the last
          seconds, and split your stake so its size says nothing.
        </p>
      </section>

      <div className="notice">
        <b>Not run by Eloscape.</b> This page is an independent initiative by Cloak to show privacy on Elysium. Eloscape doesn't operate, review
        or endorse it. Plays go to Eloscape's own live contract (<a href={EXPLORER + ELOSCAPE.game} target="_blank" rel="noreferrer">{short(ELOSCAPE.game)}</a>)
        under its rules and fees, plus Gloam's 0.5% when a note leaves the vault. Cloak's escrow isn't externally audited yet.
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
              <div style={{ textAlign: "right" }}>
                <div className="muted small">Deployed</div>
                <div className="stat">{round ? fmt(round.totalDeployed, 2) : "…"}</div>
              </div>
            </div>
            <div className="timer">
              <i style={{ width: `${progress}%` }} />
            </div>
            <div className="board">
              {Array.from({ length: GRID }, (_, b) => (
                <button key={b} className={`cell ${blocks.includes(b) ? "on" : ""}`} onClick={() => toggleBlock(b)} aria-pressed={blocks.includes(b)}>
                  <span className="id">#{b + 1}</span>
                  <span className="amt">{round ? fmt(round.deployed[b] ?? 0n, 3) : ""}</span>
                </button>
              ))}
            </div>
            <p className="muted small" style={{ marginBottom: 0 }}>
              Live from Eloscape's contract. Pick your blocks; with Sealed on, nobody sees them until {SEAL_LEAD_SECONDS}s before close.
            </p>
          </div>

        </div>

        <div>
          <div className="panel">
            <div className="row">
              <h2 style={{ margin: 0 }}>Private balance</h2>
              <span className="stat" data-testid="private-balance">{bal === null ? (ready ? "Syncing…" : "—") : `${fmt(bal)} HYPE`}</span>
            </div>
            {!ready ? (
              <p className="muted small">Connect and sign once to open your private account. The same wallet always restores it.</p>
            ) : (
              <>
                <label className="field">
                  Add HYPE privately (the one public step: do it ahead of time)
                  <div className="row" style={{ marginTop: 6 }}>
                    <input className="input" style={{ marginTop: 0 }} value={shieldAmt} onChange={(e) => setShieldAmt(e.target.value)} inputMode="decimal" />
                    <button className="btn" disabled={busy} onClick={() => run("Adding HYPE to your private balance", () => p!.priv.shieldHype(wallet!, parseEther(shieldAmt || "0"), setStatus))}>
                      Add
                    </button>
                  </div>
                </label>
                <details style={{ marginTop: 12 }}>
                  <summary className="muted small" style={{ cursor: "pointer" }}>Withdraw to any address</summary>
                  <input className="input" placeholder="0x… destination" value={outTo} onChange={(e) => setOutTo(e.target.value.trim())} />
                  <div className="row" style={{ marginTop: 6 }}>
                    <input className="input" style={{ marginTop: 0 }} placeholder="Amount" value={outAmt} onChange={(e) => setOutAmt(e.target.value)} inputMode="decimal" />
                    <button
                      className="btn"
                      disabled={busy || !isAddress(outTo)}
                      onClick={() => run("Withdrawing", () => p!.priv.unshieldHype(outTo as Address, parseEther(outAmt || "0"), setStatus))}
                    >
                      Withdraw
                    </button>
                  </div>
                </details>
              </>
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
                    <em>Signed now, kept on this device, sent {SEAL_LEAD_SECONDS}s before the round closes. Keep this tab open until it lands.</em>
                  </span>
                </label>
                <label className="toggle">
                  <input type="checkbox" checked={split} onChange={(e) => setSplit(e.target.checked)} />
                  <span>
                    <b>Also hide my amount</b>
                    <em>
                      Plays as standard pieces, each from its own seat
                      {pieces && pieces.pieces.length ? `: ${pieces.pieces.map((x) => formatEther(x)).join(" + ")}` : ""}
                      {pieces && pieces.left > 0n ? ` (${formatEther(pieces.left)} stays private)` : ""}.
                    </em>
                  </span>
                </label>
              </>
            )}
            <p className="muted small" style={{ marginBottom: 0 }}>
              Min {formatEther(MIN_DEPLOY)} HYPE per block. Gloam keeps 0.5% when a note leaves the vault; Eloscape's own fees apply as for anyone.
            </p>
            <div style={{ marginTop: 14 }}>
              {ready ? (
                <button className="btn primary" style={{ width: "100%" }} disabled={!canPlay} onClick={play}>
                  {busy ? "Working…" : mode === "auto" ? "Start Auto privately" : `Play ${blocks.length ? `block${blocks.length > 1 ? "s" : ""} ${blocks.map((b) => b + 1).join(", ")}` : ""} privately`}
                </button>
              ) : (
                <button className="btn primary" style={{ width: "100%" }} onClick={connect} disabled={busy}>
                  Connect & go private
                </button>
              )}
            </div>
            <div className="status">
              {error ? <span className="err">{error}</span> : status}
            </div>
          </div>
        </div>
      </div>
      <div className="panel" style={{ marginBottom: 40 }}>
            <h2>Your seats</h2>
            <p className="muted small" style={{ marginTop: 0 }}>
              Each seat is a one-time address that played for you. Collect sends its HYPE back into your private balance.
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
