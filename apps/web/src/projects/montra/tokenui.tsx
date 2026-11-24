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
const usd = (x: number) => `$${num(x)}`;

/** A token's image, or its first letter on a disc when there's none or it doesn't load. */
export function TokenLogo({ uri, symbol, size = 44, src }: { uri?: string; symbol: string; size?: number; src?: string }) {
  const url = src ?? imageSrc(uri ?? "");
  const [broken, setBroken] = useState(false);
  useEffect(() => setBroken(false), [url]);
  return (
    <span className="tok-logo" style={{ width: size, height: size, fontSize: size * 0.4 }} aria-hidden>
      {url && !broken ? <img src={url} alt="" referrerPolicy="no-referrer" loading="lazy" onError={() => setBroken(true)} /> : (symbol || "?").slice(0, 1).toUpperCase()}
    </span>
  );
}

const STAGES: Record<number, string> = { 0: "New", 1: "Rising", 2: "Rising", 3: "Graduating", 4: "Graduated" };

/** Name, ticker, price, market cap and liquidity: the card every launch and holding shows. */
export function TokenCard({
  profile, market, fallback, usdPerHype, badge, children, links,
}: {
  profile?: TokenProfile;
  market?: TokenMarket;
  fallback: { name: string; symbol: string };
  usdPerHype: number | null;
  badge?: ReactNode;
  children?: ReactNode;
  links?: ReactNode;
}) {
  const name = profile?.name || fallback.name;
  const symbol = profile?.symbol || fallback.symbol;
  const stat = (k: string, hype: number | undefined, extra?: string) => (
    <div>
      <div className="k">{k}</div>
      <div className="v">{hype === undefined ? <span className="shimmer" style={{ width: 60, height: 14 }} /> : `${num(hype)} HYPE`}</div>
      <div className="s">{hype !== undefined && usdPerHype ? usd(hype * usdPerHype) : extra ?? " "}</div>
    </div>
  );
  return (
    <div className="tok-card">
      <div className="tok-foot">
        <div className="tok-head">
          <TokenLogo uri={profile?.logo} symbol={symbol} />
          <div style={{ minWidth: 0 }}>
            <div className="tok-name">{name}</div>
            <div className="tok-ticker">${symbol}</div>
          </div>
        </div>
        {badge}
      </div>
      {profile?.description ? <div className="tok-desc">{profile.description}</div> : null}
      <div className="tok-stats">
        {stat("Price", market?.priceHype)}
        {stat("Market cap", market?.marketCapHype)}
        {stat("Liquidity", market?.liquidityHype)}
        <div>
          <div className="k">Stage</div>
          <div className="v">{market ? STAGES[market.stage] ?? `Stage ${market.stage}` : <span className="shimmer" style={{ width: 60, height: 14 }} />}</div>
          <div className="s">{market && market.stage < 4 ? `${(market.graduationBps / 100).toFixed(0)}% to graduate` : " "}</div>
        </div>
      </div>
      {links ? <div className="tok-links">{links}</div> : null}
      {children}
    </div>
  );
}

/** Profile links, rendered only when they are real http(s) links (a profile is whatever the launcher sent). */
export function socialLinks(p?: TokenProfile): ReactNode[] {
  if (!p) return [];
  const out: ReactNode[] = [];
  const add = (label: string, v: string, base?: string) => {
    let href = v.trim();
    if (!href) return;
    if (base && !/^https?:\/\//i.test(href)) href = base + href.replace(/^@/, "");
    if (!/^https?:\/\/[^\s"'<>]+$/i.test(href)) return;
    out.push(<a key={label} href={href} target="_blank" rel="noreferrer noopener">{label}</a>);
  };
  add("Website", p.socials.website);
  add("X", p.socials.twitter, "https://x.com/");
  add("Telegram", p.socials.telegram, "https://t.me/");
  add("Discord", p.socials.discord);
  return out;
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
