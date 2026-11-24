import { useCallback, useEffect, useMemo, useState } from "react";
import { formatEther, isAddress, keccak256, parseEther, type Address, type WalletClient } from "viem";
import { fromJson, toJson } from "@cloakely/sdk";
import { grossFor, returnSeat, splitSizes, type Seat } from "@privacy-for-elysium/eloscape";
import {
  BUILDER_CODE, buyPrivately, claimHoldingRewards, claimMineFees, holdingView, launchFromMine, launchRows, mineOwed, payoutCost, sellPrivately,
  type Holding, type LaunchRow, type Mine,
} from "@privacy-for-elysium/montra";
import { Footer, REPO, TopBar, go } from "../../pages/chrome";
import { connectWallet, publicClient, visible } from "../../wallet";
import { fallbackFor, privateHype, receiveRoute, sweepFallbacks, unlockPrivate, type Private } from "../../privacy";

const EXPLORER = "https://elysium.kinetiq.xyz/explorer/address/";
const MONTRA_TOKEN = "https://montramarkets.xyz/token/";
/** Our own slot in a creator's fee split (Montra allows at most 20%). Off until the payout wallet is chosen. */
const BUILDER_FEE_TO = import.meta.env.VITE_BUILDER_FEE_TO as Address | undefined;
const BUILDER_FEE_BPS = Number(import.meta.env.VITE_BUILDER_FEE_BPS ?? 0);
const fmt = (v: bigint, d = 4) => {
  const s = Number(formatEther(v));
  return s === 0 ? "0" : s < 10 ** -d ? `<${10 ** -d}` : s.toLocaleString(undefined, { maximumFractionDigits: d });
};
const short = (a: string) => `${a.slice(0, 6)}…${a.slice(-4)}`;
const msg = (e: unknown) => (e instanceof Error ? e.message.split("\n")[0] : String(e));

type Book = { mines: Mine[]; holdings: (Holding & { done?: boolean })[]; unfinished?: Seat[] };

/** This device's record of the player's mines and holdings (no secrets: each seat's key comes from the account). */
function montraBook(wallet: string) {
  const key = `pfe.montra.v1.99901.${wallet.toLowerCase()}`;
  return {
    load(): Book {
      try {
        const s = localStorage.getItem(key);
        return s ? (fromJson(s) as Book) : { mines: [], holdings: [] };
      } catch {
        return { mines: [], holdings: [] };
      }
    },
    save(b: Book) {
      try {
        localStorage.setItem(key, toJson(b));
      } catch {}
    },
  };
}

/** AES-GCM key only this private account can make: a backup of the book is unreadable to anyone else. */
async function backupKey(p: Private) {
  const material = keccak256(p.core.exitKeyFor(`0x${"ee".repeat(32)}`));
  const raw = Uint8Array.from(material.slice(2).match(/../g)!.map((h) => parseInt(h, 16)));
  return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"]);
}
const b64 = (u: Uint8Array) => btoa(String.fromCharCode(...u));
const unb64 = (s: string) => Uint8Array.from(atob(s), (c) => c.charCodeAt(0));

export function MontraPage() {
  const [wallet, setWallet] = useState<WalletClient | null>(null);
  const [p, setP] = useState<Private | null>(null);
  const [bal, setBal] = useState<bigint | null>(null);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState("");
  const [error, setError] = useState("");
  const [sheet, setSheet] = useState<"" | "shield" | "withdraw">("");
  const [shieldAmt, setShieldAmt] = useState("1");
  const [outTo, setOutTo] = useState("");
  const [outAmt, setOutAmt] = useState("");
  const [rows, setRows] = useState<LaunchRow[]>([]);
  const [book, setBook] = useState<Book>({ mines: [], holdings: [] });
  const [mineView, setMineView] = useState<Record<string, { owed: bigint; dev: bigint }>>({});
  const [holdView, setHoldView] = useState<Record<string, { balance: bigint; earned: bigint }>>({});
  const [claimFloor, setClaimFloor] = useState<bigint | null>(null);

  // launch form
  const [name, setName] = useState("");
  const [symbol, setSymbol] = useState("");
  const [description, setDescription] = useState("");
  const [logo, setLogo] = useState("");
  const [website, setWebsite] = useState("");
  const [twitter, setTwitter] = useState("");
  const [telegram, setTelegram] = useState("");
  const [rowId, setRowId] = useState<string>("");
  const [devBuy, setDevBuy] = useState("0.1");
  const [holdersPct, setHoldersPct] = useState(0);
  const [inPieces, setInPieces] = useState(true);
  // hold form
  const [holdToken, setHoldToken] = useState("");
  const [holdAmt, setHoldAmt] = useState("0.1");
  const [holdPieces, setHoldPieces] = useState(true);

  const store = useMemo(() => (p ? montraBook(p.address) : null), [p]);
  useEffect(() => {
    launchRows(publicClient)
      .then((r) => (setRows(r), setRowId((x) => x || (r[0] ? r[0].id.toString() : ""))))
      .catch((e) => console.warn("Montra rows:", e));
  }, []);

  const refresh = useCallback(async () => {
    if (!p || !store || !visible()) return;
    setBal(await privateHype(p.core).catch(() => null));
    const b = store.load();
    setBook(b);
    payoutCost(publicClient, 220_000n).then((c) => setClaimFloor((c * 3n) / 2n)).catch(() => {});
    const mv: typeof mineView = {};
    for (const m of b.mines) {
      const [owed, dev] = await Promise.all([
        mineOwed(publicClient, m).catch(() => 0n),
        holdingView(publicClient, { seat: m.seat, token: m.token }).then((v) => v.balance).catch(() => 0n),
      ]);
      mv[m.token] = { owed, dev };
    }
    setMineView(mv);
    const hv: typeof holdView = {};
    for (const h of b.holdings.filter((x) => !x.done)) hv[h.seat.account] = await holdingView(publicClient, h).catch(() => ({ balance: 0n, earned: 0n }));
    setHoldView(hv);
  }, [p, store]);
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
      setError(msg(e));
    } finally {
      setBusy(false);
    }
  };
  const connect = () =>
    run("Connecting wallet", async () => {
      const w = wallet ?? (await connectWallet());
      setWallet(w);
      setStatus("Sign once to open your private account (no transaction, no gas)");
      const u = await unlockPrivate(w);
      setP(u);
      setStatus("");
      sweepFallbacks(u.priv, u.address).catch((e) => console.warn("fallback sweep:", e));
    });
  const disconnect = () => (setP(null), setWallet(null), setBal(null), setBook({ mines: [], holdings: [] }), setSheet(""));
  const save = (f: (b: Book) => Book) => store && store.save(f(store.load()));

  // ── launch ─────────────────────────────────────────────────────────────────
  const row = rows.find((r) => r.id.toString() === rowId);
  const builderBps = BUILDER_FEE_TO && isAddress(BUILDER_FEE_TO) ? Math.min(2_000, Math.max(0, BUILDER_FEE_BPS)) : 0;
  const creatorBps = 10_000 - builderBps - holdersPct * 100;
  let devWei = 0n;
  try {
    devWei = parseEther(devBuy || "0");
  } catch {}
  const pieces = inPieces ? splitSizes(devWei) : { pieces: devWei > 0n ? [devWei] : [], left: 0n };
  const devNet = devWei - pieces.left;
  const launchCost = pieces.pieces.reduce((a, x) => a + grossFor(x), 0n);
  const canLaunch = !!p && !busy && name.trim().length > 0 && /^[A-Za-z0-9]{1,12}$/.test(symbol) && !!row && devNet > 0n && creatorBps >= 0 && (bal ?? 0n) >= launchCost;
  const launch = () =>
    run("Launching privately", async () => {
      const m = await launchFromMine(
        p!.core,
        {
          name: name.trim(),
          symbol: symbol.trim().toUpperCase(),
          logo: logo.trim(),
          description: description.trim(),
          socials: { website: website.trim(), twitter: twitter.trim(), telegram: telegram.trim() },
          configId: row!.id,
          devBuy: devNet,
          split: { creator: creatorBps, holders: holdersPct * 100, builder: builderBps ? { to: BUILDER_FEE_TO!, bps: builderBps } : undefined },
          pieces: pieces.pieces.length > 1 ? pieces.pieces : undefined,
        },
        // the mine is recorded as unfinished the moment it exists, so a launch that fails later never strands its HYPE
        { fallbackTo: fallbackFor(p!.priv, p!.address), onSeat: (s: Seat) => save((b) => ({ ...b, unfinished: [...(b.unfinished ?? []), s] })) },
        setStatus,
      );
      save((b) => ({ ...b, mines: [...b.mines, m], unfinished: (b.unfinished ?? []).filter((x) => x.account !== m.seat.account) }));
      setStatus(`Launched ${m.symbol} from a fresh mine (${short(m.seat.account)}). Your wallet appears nowhere in it.`);
    });

  // ── mines and holdings ─────────────────────────────────────────────────────
  const claimFees = (m: Mine) =>
    run(`Claiming ${m.symbol} fees`, async () => {
      const r = await claimMineFees(p!.core, m, receiveRoute(p!.priv, p!.address), setStatus);
      setStatus(`${fmt(r.paid)} HYPE of ${m.symbol} fees are in your private balance (gas ${fmt(r.gas, 6)} HYPE, paid from them).`);
    });
  const sellDev = (m: Mine) =>
    run(`Selling the ${m.symbol} dev buy`, async () => {
      const r = await sellPrivately(p!.core, { seat: m.seat, token: m.token, symbol: m.symbol, name: m.name, spent: 0n }, receiveRoute(p!.priv, p!.address), {}, setStatus);
      setStatus(`Sold: about ${fmt(r.hypeOut)} HYPE back in your private balance.`);
    });
  let holdWei = 0n;
  try {
    holdWei = parseEther(holdAmt || "0");
  } catch {}
  const holdSplit = holdPieces ? splitSizes(holdWei) : { pieces: holdWei > 0n ? [holdWei] : [], left: 0n };
  const holdNet = holdWei - holdSplit.left;
  const holdCost = holdSplit.pieces.reduce((a, x) => a + grossFor(x), 0n);
  const canHold = !!p && !busy && isAddress(holdToken) && holdNet > 0n && (bal ?? 0n) >= holdCost;
  const buy = () =>
    run("Buying privately", async () => {
      const h = await buyPrivately(
        p!.core,
        holdToken as Address,
        holdNet,
        { fallbackTo: fallbackFor(p!.priv, p!.address), onSeat: (s: Seat) => save((b) => ({ ...b, unfinished: [...(b.unfinished ?? []), s] })) },
        { pieces: holdSplit.pieces.length > 1 ? holdSplit.pieces : undefined },
        setStatus,
      );
      save((b) => ({ ...b, holdings: [...b.holdings, h], unfinished: (b.unfinished ?? []).filter((x) => x.account !== h.seat.account) }));
      setStatus(`Bought ${h.symbol} from a fresh seat (${short(h.seat.account)}).`);
    });
  const claimRewards = (h: Holding) =>
    run(`Claiming ${h.symbol} rewards`, async () => {
      const r = await claimHoldingRewards(p!.core, h, receiveRoute(p!.priv, p!.address), setStatus);
      setStatus(`${fmt(r.paid)} HYPE of ${h.symbol} rewards are in your private balance (gas ${fmt(r.gas, 6)} HYPE, paid from them).`);
    });
  const sell = (h: Holding) =>
    run(`Selling ${h.symbol}`, async () => {
      const r = await sellPrivately(p!.core, h, receiveRoute(p!.priv, p!.address), {}, setStatus);
      save((b) => ({ ...b, holdings: b.holdings.map((x) => (x.seat.account === h.seat.account ? { ...x, done: true } : x)) }));
      setStatus(`Sold: about ${fmt(r.hypeOut)} HYPE back in your private balance.`);
    });

  const returnUnfinished = (s: Seat) =>
    run("Returning it to your private balance", async () => {
      await returnSeat(p!.core, s, setStatus, receiveRoute(p!.priv, p!.address));
      save((b) => ({ ...b, unfinished: (b.unfinished ?? []).filter((x) => x.account !== s.account) }));
      setStatus("Back in your private balance.");
    });

  // ── backup ─────────────────────────────────────────────────────────────────
  const backup = () =>
    run("Making an encrypted backup", async () => {
      const key = await backupKey(p!);
      const iv = crypto.getRandomValues(new Uint8Array(12));
      const data = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(toJson(store!.load()))));
      const blob = new Blob([JSON.stringify({ v: 1, app: "privacy-on-elysium/montra", iv: b64(iv), data: b64(data) })], { type: "application/json" });
      const a = document.createElement("a");
      a.href = URL.createObjectURL(blob);
      a.download = "privacy-on-elysium-montra-backup.json";
      a.click();
      setStatus("Backup saved. Only this private account can open it.");
    });
  const restore = (file: File) =>
    run("Restoring from the backup", async () => {
      const j = JSON.parse(await file.text());
      const key = await backupKey(p!);
      const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: unb64(j.iv) }, key, unb64(j.data)).catch(() => {
        throw new Error("This backup belongs to another private account, or is damaged.");
      });
      const got = fromJson(new TextDecoder().decode(plain)) as Book;
      save((b) => ({
        ...b,
        mines: [...b.mines, ...got.mines.filter((m) => !b.mines.some((x) => x.token === m.token))],
        holdings: [...b.holdings, ...got.holdings.filter((h) => !b.holdings.some((x) => x.seat.account === h.seat.account))],
      }));
      setStatus(`Restored ${got.mines.length} mine${got.mines.length === 1 ? "" : "s"} and ${got.holdings.length} holding${got.holdings.length === 1 ? "" : "s"}.`);
    });

  const ready = !!p;
  const openHoldings = book.holdings.filter((h) => !h.done);
  return (
    <div className="wrap">
      <TopBar
        right={
          ready ? (
            <button className="btn wallet-btn" onClick={disconnect} title="Disconnect">
              <span className="dot" />
              {short(p!.address)}
            </button>
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
          <div className="logo" style={{ width: 52, height: 52, borderRadius: 14, background: "#0d0d0f", display: "grid", placeItems: "center", overflow: "hidden" }}>
            <img src="/projects/montra/logo.png" alt="Montra logo" style={{ width: 52 }} />
          </div>
          <div>
            <div className="eyebrow">Montra · private mode</div>
            <div className="muted small">Unofficial</div>
          </div>
        </div>
        <div className="links">
          <span>
            Montra: <a href="https://montramarkets.xyz" target="_blank" rel="noreferrer">montramarkets.xyz</a> ·{" "}
            <a href="https://x.com/MontraXYZ" target="_blank" rel="noreferrer">@MontraXYZ</a>
          </span>
          <span>
            Cloak: <a href="https://oncloak.xyz" target="_blank" rel="noreferrer">oncloak.xyz</a> · <a href="https://oncloak.xyz/docs" target="_blank" rel="noreferrer">docs</a>
          </span>
        </div>
        <h1 style={{ fontSize: "clamp(30px, 5vw, 46px)" }}>Launch on Montra, privately.</h1>
        <p className="lede">
          Launch a token from a fresh address paid from your private balance, so your wallet never shows as the dev. Hold any Montra token
          privately and collect its holder rewards.
        </p>
      </section>

      <div className="notice">
        <b>Not run by Montra.</b> Independent and unofficial. Launches and trades go to Montra's own contracts, read from its registry, under its
        rules and fees. Your HYPE sits in Gloam's shielded vault; Gloam keeps 0.5% when it leaves. Launches carry this site's Montra Builders code (
        <code>{BUILDER_CODE}</code>), which says a launch came through this site, never who made it. Verify the code:{" "}
        <a href={REPO} target="_blank" rel="noreferrer">GitHub</a>.
      </div>

      <div className="layout">
        <div>
          <div className="panel play">
            <div className="row">
              <h2 style={{ margin: 0 }}>Launch privately</h2>
            </div>
            <label className="field">
              <span>Name</span>
              <input className="input" value={name} onChange={(e) => setName(e.target.value)} placeholder="My Token" maxLength={40} />
            </label>
            <label className="field">
              <span>Ticker</span>
              <input className="input" value={symbol} onChange={(e) => setSymbol(e.target.value.toUpperCase())} placeholder="TICKER" maxLength={12} />
            </label>
            <label className="field">
              <span>Description</span>
              <input className="input" value={description} onChange={(e) => setDescription(e.target.value)} placeholder="One line about it" maxLength={280} />
            </label>
            <label className="field">
              <span>Image link (ipfs:// or https://, optional)</span>
              <input className="input" value={logo} onChange={(e) => setLogo(e.target.value.trim())} placeholder="ipfs://…" />
            </label>
            <div className="sheet" style={{ marginTop: 8 }}>
              <input className="input" value={website} onChange={(e) => setWebsite(e.target.value)} placeholder="Website" />
              <input className="input" value={twitter} onChange={(e) => setTwitter(e.target.value)} placeholder="X" />
              <input className="input" value={telegram} onChange={(e) => setTelegram(e.target.value)} placeholder="Telegram" />
            </div>
            <label className="field">
              <span>Fee tier</span>
              <select className="input" value={rowId} onChange={(e) => setRowId(e.target.value)}>
                {rows.map((r) => (
                  <option key={r.id.toString()} value={r.id.toString()}>
                    {r.totalFeePips / 10_000}% per trade{r.earlyBuyFeeWindow ? ` · anti-snipe ${r.earlyBuyFeeWindow}s` : ""}
                  </option>
                ))}
              </select>
            </label>
            <div className="swap-box">
              <div className="k">
                <span>Dev buy</span>
                <span>{ready && bal !== null ? `Private ${fmt(bal)} HYPE` : ""}</span>
              </div>
              <div className="amt">
                <input value={devBuy} onChange={(e) => setDevBuy(e.target.value)} inputMode="decimal" placeholder="0" aria-label="Dev buy" />
                <span className="token-sel">
                  <img src="/tokens/hype.svg" alt="" width={26} height={26} />
                  HYPE
                </span>
              </div>
            </div>
            <div className="stepper">
              <span>Creator fees to holders</span>
              <span className="chips">
                {[0, 25, 50, 100].map((v) => (
                  <button key={v} className={holdersPct === v ? "on" : ""} onClick={() => setHoldersPct(Math.min(v, Math.floor((10_000 - builderBps) / 100)))}>
                    {v}%
                  </button>
                ))}
              </span>
            </div>
            <div className="switches">
              <label className="switch">
                <span>
                  <b>Fund in pieces</b>
                  <em>{pieces.pieces.length > 1 ? `The mine is funded as ${pieces.pieces.map((x) => formatEther(x)).join(" + ")}, so no single amount matches yours.` : "The mine is funded in standard pieces, so no single amount matches yours."}</em>
                </span>
                <input type="checkbox" checked={inPieces} onChange={(e) => setInPieces(e.target.checked)} />
              </label>
            </div>
            <div className="summary">
              <div className="kv"><span>Your mine gets</span><span>{(creatorBps / 100).toFixed(0)}% of the creator fees, privately</span></div>
              <div className="kv"><span>Holders get</span><span>{holdersPct}%</span></div>
              {builderBps > 0 && <div className="kv"><span>This site's fee</span><span>{builderBps / 100}% of the creator fees</span></div>}
              <div className="kv"><span>Dev buy</span><span>{devNet > 0n ? `${fmt(devNet)} HYPE` : "—"}</span></div>
              <div className="kv total"><span>From your private balance</span><span>{launchCost > 0n ? `${fmt(launchCost, 6)} HYPE` : "—"}</span></div>
            </div>
            <button className="btn primary big" disabled={!canLaunch} onClick={ready ? launch : connect}>
              {!ready ? "Connect" : busy ? "Working…" : `Launch ${symbol || "token"} privately`}
            </button>
            <div className="seen-below">
              <div className="kv seen-row"><span>Others see</span><span>A fresh address launched {symbol || "the token"}{pieces.pieces.length > 1 ? ", funded in standard pieces" : ""}, and its dev buy.</span></div>
              <div className="kv seen-row"><span>Hidden</span><span>Your wallet, and where its fees go.</span></div>
            </div>
          </div>
        </div>

        <div>
          <div className="panel">
            <div className="muted small">Private balance</div>
            <div className="row" style={{ marginTop: 4 }}>
              <span className="stat" data-testid="private-balance">
                {!ready ? "—" : bal !== null ? `${fmt(bal)} HYPE` : <span className="shimmer" style={{ width: 120, height: 26 }} />}
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
            {ready && sheet === "shield" && (
              <div className="sheet">
                <input className="input" placeholder="HYPE to shield" value={shieldAmt} onChange={(e) => setShieldAmt(e.target.value)} inputMode="decimal" />
                <button className="btn primary" disabled={busy || !shieldAmt} onClick={() => run("Shielding", async () => (await p!.priv.shieldHype(wallet!, parseEther(shieldAmt || "0"), setStatus), setSheet(""), setStatus("Shielded.")))}>
                  Shield
                </button>
              </div>
            )}
            {ready && sheet === "withdraw" && (
              <div className="sheet col">
                <input className="input" placeholder="0x… destination address" value={outTo} onChange={(e) => setOutTo(e.target.value.trim())} />
                <div className="sheet" style={{ marginTop: 0 }}>
                  <input className="input" placeholder="HYPE to withdraw" value={outAmt} onChange={(e) => setOutAmt(e.target.value)} inputMode="decimal" />
                  <button className="btn primary" disabled={busy || !isAddress(outTo) || !outAmt} onClick={() => run("Withdrawing", async () => (await p!.priv.unshieldHype(outTo as Address, parseEther(outAmt || "0"), setStatus), setSheet(""), setStatus("Withdrawn.")))}>
                    Withdraw
                  </button>
                </div>
              </div>
            )}
          </div>

          <div className="panel play">
            <h2 style={{ margin: 0 }}>Hold privately</h2>
            <p className="muted small">Buy any Montra token from a fresh address. It earns the token's holder rewards like any holder; you claim them into your private balance.</p>
            <label className="field">
              <span>Token address</span>
              <input className="input" value={holdToken} onChange={(e) => setHoldToken(e.target.value.trim())} placeholder="0x…" />
            </label>
            <div className="swap-box">
              <div className="k"><span>Spend</span><span /></div>
              <div className="amt">
                <input value={holdAmt} onChange={(e) => setHoldAmt(e.target.value)} inputMode="decimal" placeholder="0" aria-label="HYPE to spend" />
                <span className="token-sel">
                  <img src="/tokens/hype.svg" alt="" width={26} height={26} />
                  HYPE
                </span>
              </div>
            </div>
            <div className="switches">
              <label className="switch">
                <span>
                  <b>Buy in pieces</b>
                  <em>{holdSplit.pieces.length > 1 ? `Funded as ${holdSplit.pieces.map((x) => formatEther(x)).join(" + ")}.` : "Funded in standard pieces, so the amount doesn't match yours."}</em>
                </span>
                <input type="checkbox" checked={holdPieces} onChange={(e) => setHoldPieces(e.target.checked)} />
              </label>
            </div>
            <button className="btn primary big" disabled={!canHold} onClick={ready ? buy : connect}>
              {!ready ? "Connect" : busy ? "Working…" : `Buy privately${holdCost > 0n ? ` · ${fmt(holdCost, 6)} HYPE` : ""}`}
            </button>
          </div>
        </div>
      </div>

      <div className="status" style={{ margin: "12px 0" }}>{error ? <span className="err">{error}</span> : status}</div>

      {ready && (
        <div className="panel">
          <div className="row">
            <h2 style={{ margin: 0 }}>Your mines</h2>
            <span style={{ display: "flex", gap: 8 }}>
              <button className="btn small" disabled={busy} onClick={backup}>Back up</button>
              <label className="btn small" style={{ cursor: "pointer" }}>
                Restore
                <input type="file" accept="application/json" style={{ display: "none" }} onChange={(e) => e.target.files?.[0] && restore(e.target.files[0])} />
              </label>
            </span>
          </div>
          <p className="muted small">
            Each mine is the fresh address that launched a token: Montra's creator and fee recipient. Claiming pays its own gas from the fees
            {claimFloor !== null ? `, so it opens once a mine is owed about ${fmt(claimFloor, 5)} HYPE` : ""}. Back up after every launch: a new
            device needs the backup to reach your mines.
          </p>
          {!book.mines.length && <p className="muted small">No mines yet.</p>}
          {book.mines.map((m) => {
            const v = mineView[m.token];
            const worth = !!v && claimFloor !== null && v.owed >= claimFloor;
            return (
              <div key={m.token} className="seat">
                <div className="row">
                  <span>
                    <b>{m.symbol}</b> · <a href={MONTRA_TOKEN + m.token} target="_blank" rel="noreferrer">on Montra</a>
                  </span>
                  <a href={EXPLORER + m.seat.account} target="_blank" rel="noreferrer"><code>{short(m.seat.account)}</code></a>
                </div>
                <div className="row muted">
                  <span className="num">{v ? `${fmt(v.owed, 6)} HYPE in fees${v.dev > 0n ? ` · dev buy ${fmt(v.dev)} ${m.symbol}` : ""}` : <span className="shimmer" style={{ width: 160, height: 14 }} />}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn small" disabled={busy || !worth} onClick={() => claimFees(m)}>{worth || !v ? "Claim fees" : "Not worth claiming yet"}</button>
                    {!!v && v.dev > 0n && <button className="btn small" disabled={busy} onClick={() => sellDev(m)}>Sell dev buy</button>}
                  </span>
                </div>
              </div>
            );
          })}

          {(book.unfinished ?? []).length > 0 && (
            <>
              <h2 style={{ marginTop: 18 }}>Unfinished</h2>
              <p className="muted small">Seats that were funded but didn't finish launching or buying. Return their HYPE to your private balance.</p>
              {(book.unfinished ?? []).map((s) => (
                <div key={s.account} className="seat row">
                  <a href={EXPLORER + s.account} target="_blank" rel="noreferrer"><code>{short(s.account)}</code></a>
                  <button className="btn small" disabled={busy} onClick={() => returnUnfinished(s)}>Return to private balance</button>
                </div>
              ))}
            </>
          )}

          <h2 style={{ marginTop: 18 }}>Your private holdings</h2>
          {!openHoldings.length && <p className="muted small">No holdings yet.</p>}
          {openHoldings.map((h) => {
            const v = holdView[h.seat.account];
            const worth = !!v && claimFloor !== null && v.earned >= claimFloor;
            return (
              <div key={h.seat.account} className="seat">
                <div className="row">
                  <span>
                    <b>{h.symbol}</b> · <a href={MONTRA_TOKEN + h.token} target="_blank" rel="noreferrer">on Montra</a>
                  </span>
                  <a href={EXPLORER + h.seat.account} target="_blank" rel="noreferrer"><code>{short(h.seat.account)}</code></a>
                </div>
                <div className="row muted">
                  <span className="num">{v ? `${fmt(v.balance)} ${h.symbol} · ${fmt(v.earned, 6)} HYPE in rewards` : <span className="shimmer" style={{ width: 160, height: 14 }} />}</span>
                  <span style={{ display: "flex", gap: 6 }}>
                    <button className="btn small" disabled={busy || !worth} onClick={() => claimRewards(h)}>{worth || !v ? "Claim rewards" : "Rewards too small yet"}</button>
                    <button className="btn small" disabled={busy} onClick={() => sell(h)}>Sell</button>
                  </span>
                </div>
              </div>
            );
          })}
        </div>
      )}

      <div className="panel howto">
        <h2>How it works</h2>
        <ol>
          <li><b>Connect</b> and sign once. It opens your private account; no transaction, no gas.</li>
          <li><b>Shield</b> HYPE into your private balance, ideally well before you launch. This is the one public step.</li>
          <li><b>Launch.</b> A fresh address, your mine, is paid from your private balance (in standard pieces) and calls Montra's factory. Montra makes it the creator and fee recipient. Your wallet never appears.</li>
          <li><b>Claim fees</b> from your mines into your private balance. Each claim pays its own gas from the fees.</li>
          <li><b>Hold privately:</b> buy any Montra token from a fresh address, claim its holder rewards privately, and sell back into your private balance.</li>
          <li><b>Back up</b> your mines. The backup is encrypted so only your private account can open it; a new device needs it to reach them.</li>
        </ol>
      </div>
      <Footer />
    </div>
  );
}
