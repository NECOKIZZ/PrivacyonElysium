import { useEffect, useRef, useState, type ReactNode } from "react";
import { IMAGE_MAX_BYTES, IMAGE_TYPES, imageSrc, type TokenMarket, type TokenProfile } from "@privacy-for-elysium/montra";

/** HYPE in dollars, from Hyperliquid's public mids (one global price: it says nothing about who is looking). */
let usdCache: { at: number; p: Promise<number | null> } | null = null;
export function hypeUsd(): Promise<number | null> {
  if (usdCache && Date.now() - usdCache.at < 60_000) return usdCache.p;
  const p = fetch("https://api.hyperliquid.xyz/info", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ type: "allMids" }) })
    .then((r) => r.json())
    .then((m: Record<string, string>) => (m?.HYPE ? Number(m.HYPE) : null))
    .catch(() => null);
  usdCache = { at: Date.now(), p };
  return p;
}
export function useHypeUsd(): number | null {
  const [v, setV] = useState<number | null>(null);
  useEffect(() => {
    let live = true;
    const get = () => hypeUsd().then((x) => live && x !== null && setV(x));
    get();
    const t = setInterval(get, 60_000);
    return () => {
      live = false;
      clearInterval(t);
    };
  }, []);
  return v;
}

/** A number in a few significant digits, small prices included (0.0000000423 → 0.0₇423). */
export function num(x: number, sig = 3): string {
  if (!Number.isFinite(x)) return "—";
  if (x === 0) return "0";
  const a = Math.abs(x);
  if (a >= 1_000_000_000) return `${(x / 1e9).toFixed(2)}B`;
  if (a >= 1_000_000) return `${(x / 1e6).toFixed(2)}M`;
  if (a >= 10_000) return `${(x / 1e3).toFixed(1)}K`;
  if (a >= 1) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  // round first (0.9996 is 1.00, not 0.1), then count the zeros after the point
  const [m, e] = a.toExponential(sig - 1).split("e");
  const zeros = -Number(e) - 1;
  if (zeros < 0) return x.toLocaleString(undefined, { maximumFractionDigits: 2 });
  const digits = m.replace(".", "").replace(/0+$/, "") || "0";
  const sign = x < 0 ? "-" : "";
  if (zeros >= 4) return `${sign}0.0${String(zeros).split("").map((d) => "₀₁₂₃₄₅₆₇₈₉"[+d]).join("")}${digits}`;
  return `${sign}0.${"0".repeat(zeros)}${digits}`;
}

/** A token's image, or its first letter when there's none or it doesn't load. `square` is the token-page shape. */
export function TokenLogo({ uri, symbol, size = 44, src, square }: { uri?: string; symbol: string; size?: number; src?: string; square?: boolean }) {
  const url = src ?? imageSrc(uri ?? "");
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <span className={`tok-logo${square ? " sq" : ""}`} style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {url && !broken ? <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} /> : (symbol || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

// ── small icons (lucide shapes, drawn in the text colour) ─────────────────────────────────────────────────
const I = ({ children, s = 13 }: { children: ReactNode; s?: number }) => (
  <svg width={s} height={s} viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden>
    {children}
  </svg>
);
export const Icon = {
  copy: <I s={12}><rect width="14" height="14" x="8" y="8" rx="2" /><path d="M4 16c-1.1 0-2-.9-2-2V4c0-1.1.9-2 2-2h10c1.1 0 2 .9 2 2" /></I>,
  check: <I s={12}><path d="M20 6 9 17l-5-5" /></I>,
  globe: <I><circle cx="12" cy="12" r="10" /><path d="M12 2a14.5 14.5 0 0 0 0 20 14.5 14.5 0 0 0 0-20" /><path d="M2 12h20" /></I>,
  x: (
    <svg width={11} height={11} viewBox="0 0 24 24" fill="currentColor" aria-hidden>
      <path d="M18.9 1.2h3.7l-8 9.2 9.4 12.4h-7.4l-5.8-7.6-6.6 7.6H.5l8.6-9.8L0 1.2h7.6l5.2 6.9 6.1-6.9Zm-1.3 19.4h2L6.5 3.3H4.3l13.3 17.3Z" />
    </svg>
  ),
  send: <I><path d="m22 2-7 20-4-9-9-4Z" /><path d="M22 2 11 13" /></I>,
  chat: <I><path d="M7.9 20A9 9 0 1 0 4 16.1L2 22Z" /></I>,
  out: <I s={12}><path d="M15 3h6v6" /><path d="M10 14 21 3" /><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6" /></I>,
  flame: <I><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.07-2.14-.22-4.05 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.15.43-2.29 1-3a2.5 2.5 0 0 0 2.5 2.5z" /></I>,
  lock: <I s={11}><rect width="18" height="11" x="3" y="11" rx="2" /><path d="M7 11V7a5 5 0 0 1 10 0v4" /></I>,
  more: <I s={16}><circle cx="12" cy="12" r="1" /><circle cx="19" cy="12" r="1" /><circle cx="5" cy="12" r="1" /></I>,
};

export const shortAddr = (a: string) => `${a.slice(0, 8)}…${a.slice(-4)}`;

/** An address, shortened, with a copy button: the way token pages show it. */
export function Addr({ addr, href, title }: { addr: string; href?: string; title?: string }) {
  const [done, setDone] = useState(false);
  const copy = () => navigator.clipboard?.writeText(addr).then(() => (setDone(true), setTimeout(() => setDone(false), 1400)));
  return (
    <span className="addr" title={title ?? addr}>
      {href ? (
        <a href={href} target="_blank" rel="noreferrer">
          {shortAddr(addr)}
        </a>
      ) : (
        <span>{shortAddr(addr)}</span>
      )}
      <button type="button" className="icon-btn" aria-label={done ? "Copied" : "Copy address"} title={done ? "Copied" : "Copy"} onClick={copy}>
        {done ? Icon.check : Icon.copy}
      </button>
    </span>
  );
}

export function ago(secs: number): string {
  if (!secs) return "";
  const d = Math.max(0, Date.now() / 1000 - secs);
  if (d < 60) return "just now";
  if (d < 3600) return `${Math.floor(d / 60)}m ago`;
  if (d < 86_400) return `${Math.floor(d / 3600)}h ago`;
  return `${Math.floor(d / 86_400)}d ago`;
}

/** Profile links as a small icon and a word, real http(s) links only (a profile is whatever the launcher sent). */
export function socialLinks(p?: TokenProfile): ReactNode[] {
  if (!p) return [];
  const out: ReactNode[] = [];
  const add = (label: string, icon: ReactNode, v: string, base?: string) => {
    let href = v.trim();
    if (!href) return;
    if (base && !/^https?:\/\//i.test(href)) href = base + href.replace(/^@/, "");
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(href)) return;
    let host = "";
    try {
      host = new URL(href).host.replace(/^www\./, "");
    } catch {}
    out.push(
      <a key={label} className="ilink" href={href} target="_blank" rel="noreferrer noopener" title={href}>
        {icon}
        {label}
        {host && label === "website" ? <em>{host}</em> : null}
      </a>,
    );
  };
  add("website", Icon.globe, p.socials.website);
  add("x", Icon.x, p.socials.twitter, "https://x.com/");
  add("telegram", Icon.send, p.socials.telegram, "https://t.me/");
  add("discord", Icon.chat, p.socials.discord);
  return out;
}

const STAGES: Record<number, string> = { 0: "New", 1: "Rising", 2: "Rising", 3: "Graduating", 4: "Graduated" };
const usdOr = (hype: number, usdPerHype: number | null) => (usdPerHype ? `$${num(hype * usdPerHype)}` : `${num(hype)} HYPE`);

/**
 * A token as a token page shows it: the picture and name, a line of facts (address, age, maker, links), the
 * description, then the numbers on hairlines, dollars first and HYPE beneath.
 */
export function TokenSheet({
  token, profile, market, fallback, usdPerHype, launchedAt, maker, extraLinks, badge, children,
}: {
  token: string;
  profile?: TokenProfile;
  market?: TokenMarket;
  fallback: { name: string; symbol: string };
  usdPerHype: number | null;
  launchedAt?: number;
  maker?: { label: string; addr: string; href: string; title: string };
  extraLinks?: ReactNode;
  badge?: ReactNode;
  children?: ReactNode;
}) {
  const name = profile?.name || fallback.name;
  const symbol = profile?.symbol || fallback.symbol;
  const wait = <span className="shimmer" style={{ width: 70, height: 16 }} />;
  const cell = (k: string, hype: number | undefined) => (
    <div>
      <dt>{k}</dt>
      <dd className="big">{hype === undefined ? wait : usdOr(hype, usdPerHype)}</dd>
      <dd>{hype !== undefined && usdPerHype ? `${num(hype)} HYPE` : " "}</dd>
    </div>
  );
  return (
    <article className="tk">
      <header className="tk-head">
        <TokenLogo uri={profile?.logo} symbol={symbol} size={60} square />
        <div className="tk-title">
          <h3>{name}</h3>
          <p>
            ${symbol} <span className="dim">/</span> <img src="/tokens/hype.svg" alt="" width={14} height={14} /> HYPE
            {badge ? (
              <>
                {" "}
                <span className="dim">·</span> {badge}
              </>
            ) : null}
          </p>
        </div>
      </header>
      <div className="tk-meta">
        <Addr addr={token} title="Token address" />
        {launchedAt ? <span>Launched {ago(launchedAt)}</span> : null}
        {maker ? (
          <span className="tk-by" title={maker.title}>
            {maker.label} <Addr addr={maker.addr} href={maker.href} title={maker.title} />
          </span>
        ) : null}
        {socialLinks(profile)}
        {extraLinks}
      </div>
      {profile?.description ? <p className="tk-desc">{profile.description}</p> : null}
      <dl className="tk-stats">
        {cell("Price", market?.priceHype)}
        {cell("Market cap", market?.marketCapHype)}
        {cell("Liquidity", market?.liquidityHype)}
        <div>
          <dt>Stage</dt>
          <dd className="big">{market ? STAGES[market.stage] ?? `Stage ${market.stage}` : wait}</dd>
          <dd>
            {market && market.stage < 4 ? (
              <span className="grad" title={`${(market.graduationBps / 100).toFixed(0)}% of the way to graduating`}>
                <i>
                  <b style={{ width: `${Math.min(100, market.graduationBps / 100)}%` }} />
                </i>
                {(market.graduationBps / 100).toFixed(0)}%
              </span>
            ) : market ? (
              "for good"
            ) : (
              " "
            )}
          </dd>
        </div>
      </dl>
      {children}
    </article>
  );
}

/** One line of a wallet-style token list: picture, name and ticker with a copy button, price, what you hold. */
export function TokenRow({
  token, profile, market, fallback, usdPerHype, balance, open, onToggle, warn, children,
}: {
  token: string;
  profile?: TokenProfile;
  market?: TokenMarket;
  fallback: { name: string; symbol: string };
  usdPerHype: number | null;
  /** Tokens held, whole units. */
  balance?: number;
  open: boolean;
  onToggle: () => void;
  /** A short warning shown on the line itself (a seat near its end). */
  warn?: string;
  children?: ReactNode;
}) {
  const name = profile?.name || fallback.name;
  const symbol = profile?.symbol || fallback.symbol;
  const valueHype = balance !== undefined && market ? balance * market.priceHype : undefined;
  const wait = <span className="shimmer" style={{ width: 50, height: 14 }} />;
  return (
    <div className={`trow${open ? " open" : ""}`}>
      <div className="trow-line">
        <TokenLogo uri={profile?.logo} symbol={symbol} size={36} />
        <div className="trow-name">
          <b>{name}</b>
          <span>
            {symbol} <Addr addr={token} title="Copy the token address" />
            {warn ? <em className="err">{warn}</em> : null}
          </span>
        </div>
        <div className="trow-num trow-price">
          <b>{market ? usdOr(market.priceHype, usdPerHype) : wait}</b>
          <span>price</span>
        </div>
        <div className="trow-num">
          <b>{valueHype === undefined ? wait : usdOr(valueHype, usdPerHype)}</b>
          <span>{balance === undefined ? " " : `${num(balance)} ${symbol}`}</span>
        </div>
        <button type="button" className="icon-btn trow-more" aria-expanded={open} aria-label={`Manage ${symbol}`} title="Buy more, claim, sell" onClick={onToggle}>
          {Icon.more}
        </button>
      </div>
      {open ? <div className="trow-body">{children}</div> : null}
    </div>
  );
}

export function Copy({ text, label }: { text: string; label: string }) {
  const [done, setDone] = useState(false);
  return (
    <button className="copy" onClick={() => navigator.clipboard?.writeText(text).then(() => (setDone(true), setTimeout(() => setDone(false), 1500)))}>
      {done ? "Copied" : label}
    </button>
  );
}

// ── the launch form's image ────────────────────────────────────────────────────────────────────────────────

export type PickedImage =
  | { kind: "none" }
  | { kind: "checking" }
  | { kind: "file"; file: File; preview: string; width: number; height: number; warn?: string }
  | { kind: "link"; uri: string; preview: string; width: number; height: number; warn?: string }
  | { kind: "bad"; error: string };

const loads = (src: string) =>
  new Promise<{ width: number; height: number }>((ok, no) => {
    const img = new Image();
    img.referrerPolicy = "no-referrer";
    const t = setTimeout(() => no(new Error("timeout")), 12_000);
    img.onload = () => (clearTimeout(t), img.naturalWidth > 0 ? ok({ width: img.naturalWidth, height: img.naturalHeight }) : no(new Error("empty")));
    img.onerror = () => (clearTimeout(t), no(new Error("not an image")));
    img.src = src;
  });
const shapeWarning = (w: number, h: number) =>
  Math.abs(w - h) / Math.max(w, h) > 0.05 ? `It's ${w}×${h}: Montra shows it in a circle, so a square image looks best.` : w < 200 ? `It's only ${w}×${h}: it may look blurry. 400×400 or more is best.` : undefined;

/** Checks a file is a real PNG, JPEG, WebP or GIF of at most 2 MB that a browser can draw (what Montra stores). */
export async function checkFile(file: File): Promise<PickedImage> {
  if (!(IMAGE_TYPES as readonly string[]).includes(file.type)) return { kind: "bad", error: `${file.name} is ${file.type || "not an image"}. Use a PNG, JPEG, WebP or GIF.` };
  if (file.size > IMAGE_MAX_BYTES) return { kind: "bad", error: `${file.name} is ${(file.size / 1024 / 1024).toFixed(1)} MB. Montra takes 2 MB at most.` };
  const preview = URL.createObjectURL(file);
  try {
    const { width, height } = await loads(preview);
    return { kind: "file", file, preview, width, height, warn: shapeWarning(width, height) };
  } catch {
    URL.revokeObjectURL(preview);
    return { kind: "bad", error: `${file.name} doesn't open as an image. It may be damaged.` };
  }
}

/** Checks a link opens as an image itself, not a web page about one (a share link, a Drive page). */
export async function checkLink(uri: string): Promise<PickedImage> {
  const src = imageSrc(uri);
  if (!src) return { kind: "bad", error: "Use an https:// or ipfs:// link." };
  try {
    const { width, height } = await loads(src);
    return { kind: "link", uri: uri.trim(), preview: src, width, height, warn: shapeWarning(width, height) };
  } catch {
    return { kind: "bad", error: "That link doesn't open as an image. Share links (Google, Drive, X) open a web page instead: upload the file here." };
  }
}

export function ImagePicker({ value, onChange, symbol, disabled }: { value: PickedImage; onChange: (v: PickedImage) => void; symbol: string; disabled?: boolean }) {
  const [drag, setDrag] = useState(false);
  const [linkMode, setLinkMode] = useState(false);
  const [link, setLink] = useState("");
  const input = useRef<HTMLInputElement>(null);
  const take = async (f?: File | null) => {
    if (!f) return;
    onChange({ kind: "checking" });
    onChange(await checkFile(f));
  };
  useEffect(() => {
    if (!linkMode) return;
    const v = link.trim();
    if (!v) return onChange({ kind: "none" });
    onChange({ kind: "checking" });
    const t = setTimeout(async () => onChange(await checkLink(v)), 500);
    return () => clearTimeout(t);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [link, linkMode]);
  const ok = value.kind === "file" || value.kind === "link";
  return (
    <div className="field">
      <span>Image</span>
      <div
        className={`picker${drag ? " drag" : ""}${value.kind === "bad" ? " bad" : ""}`}
        onDragOver={(e) => (e.preventDefault(), setDrag(true))}
        onDragLeave={() => setDrag(false)}
        onDrop={(e) => (e.preventDefault(), setDrag(false), setLinkMode(false), take(e.dataTransfer.files?.[0]))}
      >
        <TokenLogo symbol={symbol || "?"} src={ok ? value.preview : ""} size={56} />
        <div className="what">
          {value.kind === "checking" && "Checking the image…"}
          {value.kind === "none" && (linkMode ? "Paste a direct link to the image." : <>Drop an image here, or choose one. <b>PNG, JPEG, WebP or GIF</b>, up to 2 MB, square is best.</>)}
          {value.kind === "file" && <><b>{value.file.name}</b> · {value.width}×{value.height} · {(value.file.size / 1024).toFixed(0)} KB{value.warn ? <div style={{ color: "var(--seal)" }}>{value.warn}</div> : <div>Looks good.</div>}</>}
          {value.kind === "link" && <><b>Image found</b> · {value.width}×{value.height}{value.warn ? <div style={{ color: "var(--seal)" }}>{value.warn}</div> : <div>Looks good.</div>}</>}
          {value.kind === "bad" && <span className="err">{value.error}</span>}
        </div>
        {!linkMode && (
          <button type="button" className="btn small" disabled={disabled} onClick={() => input.current?.click()}>
            {ok ? "Change" : "Choose"}
          </button>
        )}
        <input ref={input} type="file" accept={IMAGE_TYPES.join(",")} style={{ display: "none" }} onChange={(e) => (take(e.target.files?.[0]), (e.target.value = ""))} />
      </div>
      {linkMode && <input className="input" value={link} onChange={(e) => setLink(e.target.value)} placeholder="https://… or ipfs://…" />}
      <div className="muted small" style={{ marginTop: 4 }}>
        The image is fixed forever at launch.{" "}
        <button type="button" className="linkbtn" onClick={() => (setLinkMode(!linkMode), setLink(""), onChange({ kind: "none" }))}>
          {linkMode ? "Upload a file instead" : "Use a link instead"}
        </button>
      </div>
    </div>
  );
}

/** Uploads through this site's /api/montra-upload to Montra's own image and metadata store. */
export const UPLOAD_URL = (import.meta.env.VITE_MONTRA_UPLOAD as string | undefined) ?? "/api/montra-upload";
async function posted(r: Response): Promise<{ uri: string }> {
  const body = await r.json().catch(() => ({}));
  if (!r.ok || !body.uri) throw new Error(`Couldn't store the ${r.url.includes("image") ? "image" : "token details"}: ${body.error ?? r.statusText}`);
  return body;
}
export async function uploadImage(file: File): Promise<string> {
  return (await posted(await fetch(`${UPLOAD_URL}?kind=image`, { method: "POST", headers: { "content-type": file.type }, body: file }))).uri;
}
export async function uploadMetadata(doc: Record<string, string>): Promise<string> {
  return (await posted(await fetch(`${UPLOAD_URL}?kind=metadata`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) }))).uri;
}
