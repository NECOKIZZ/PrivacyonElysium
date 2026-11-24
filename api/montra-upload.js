/**
 * Passes a token's image and metadata to Montra's own upload API (the routes montramarkets.xyz uses), checked first.
 *
 * Montra's API only accepts browser uploads from montramarkets.xyz, so the launch page sends them here and this
 * forwards them unchanged. A side effect worth keeping: Montra sees this server, never the creator's IP address.
 *
 *   POST /api/montra-upload?kind=image     body: the raw image (PNG, JPEG, WebP or GIF, 2 MB at most)
 *   POST /api/montra-upload?kind=metadata  body: { name, symbol, description, image, website, twitter, telegram, discord }
 *
 * Both answer Montra's own reply: { uri } on success, { error } otherwise. Only requests from this site are taken,
 * so it is not an open proxy.
 */
const MONTRA = process.env.MONTRA_API || "https://api.montramarkets.xyz";
const MAX = 2 * 1024 * 1024;
const TYPES = { "image/png": [0x89, 0x50, 0x4e, 0x47], "image/jpeg": [0xff, 0xd8, 0xff], "image/gif": [0x47, 0x49, 0x46, 0x38], "image/webp": [0x52, 0x49, 0x46, 0x46] };
const ALLOWED_ORIGINS = [/^https:\/\/elysium\.oncloak\.xyz$/, /^https:\/\/[a-z0-9-]+\.vercel\.app$/, /^http:\/\/(localhost|127\.0\.0\.1)(:\d+)?$/];

const reply = (status, body) => new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json", "cache-control": "no-store" } });
const link = (v) => typeof v === "string" && v.length <= 300 && /^(https?|ipfs):\/\/[^\s"'<>]+$/i.test(v);
const text = (v, max) => typeof v === "string" && v.length <= max;

export async function POST(request) {
  const origin = request.headers.get("origin") ?? "";
  if (!ALLOWED_ORIGINS.some((r) => r.test(origin))) return reply(403, { error: "Uploads are only taken from this site." });
  const kind = new URL(request.url).searchParams.get("kind");

  if (kind === "image") {
    const type = (request.headers.get("content-type") ?? "").split(";")[0].trim().toLowerCase();
    if (!TYPES[type]) return reply(415, { error: "The image must be a PNG, JPEG, WebP or GIF." });
    const body = new Uint8Array(await request.arrayBuffer());
    if (!body.length) return reply(400, { error: "The image is empty." });
    if (body.length > MAX) return reply(413, { error: "The image is over 2 MB." });
    const magic = TYPES[type];
    if (!magic.every((b, i) => body[i] === b) || (type === "image/webp" && String.fromCharCode(...body.slice(8, 12)) !== "WEBP"))
      return reply(415, { error: "That file isn't the image type it says it is." });
    const r = await fetch(`${MONTRA}/api/metadata/image`, { method: "POST", headers: { "content-type": type }, body });
    return reply(r.status, await r.json().catch(() => ({ error: `Montra answered ${r.status}.` })));
  }

  if (kind === "metadata") {
    const j = await request.json().catch(() => null);
    if (!j || !text(j.name, 64) || !j.name.trim() || !text(j.symbol, 16) || !j.symbol.trim()) return reply(400, { error: "A name and a ticker are needed." });
    const doc = { name: j.name.trim(), symbol: j.symbol.trim() };
    if (text(j.description, 1000) && j.description.trim()) doc.description = j.description.trim();
    for (const k of ["image", "website", "twitter", "telegram", "discord"]) if (link(j[k])) doc[k] = j[k];
    const r = await fetch(`${MONTRA}/api/metadata`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(doc) });
    return reply(r.status, await r.json().catch(() => ({ error: `Montra answered ${r.status}.` })));
  }

  return reply(400, { error: "Unknown upload." });
}
