/**
 * The Montra page, driven in a real browser against a fork of Elysium MAINNET: a wallet injected into the page, a
 * stand-in for Cloak's relay, Montra's real contracts. Clicks through a private launch, a fee claim, a private buy and
 * a sale, as a creator and a holder would.
 *
 *   npm run test:ui:montra        (needs anvil on PATH, Playwright's Chromium, and network access to the Elysium RPC and jsDelivr)
 */
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysium } from "@cloakely/sdk";
import { ELYSIUM_MAINNET, ELYSIUM_RPC } from "../projects/eloscape/src/index.js";
import { ABI, builderSuffix, montraAddresses, tokenInfo } from "../projects/montra/src/index.js";
import { parseEther, toHex } from "viem";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as typeof import("playwright");

const FORK = 8592, RELAY = 8788, SITE = 4175, UPLOAD = 8789, STORE = 8790;
const RPC = `http://127.0.0.1:${FORK}`;
const ALICE = "0x70997970C51812dc3A010C7d01b50e0d17dc79C8"; // anvil #1 (an unlocked dev account on the fork)
const RELAYER_KEY = "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97" as Hex; // anvil #8
const OUT = process.env.SHOTS ?? "test/shots";
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const log = (...a: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
let failures = 0;
const check = (ok: boolean, what: string) => (console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`), ok || failures++);
const rpc = async (method: string, params: unknown[] = []) => {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
};

const procs: { kill(): void }[] = [];
process.on("exit", () => procs.forEach((p) => p.kill()));

// ── fork, relay, oracle ─────────────────────────────────────────────────────
procs.push(spawn("anvil", ["--fork-url", process.env.FORK_URL ?? ELYSIUM_RPC, "--chain-id", String(ELYSIUM_MAINNET), "--port", String(FORK), "--block-time", "1", "--silent"], { stdio: "ignore" }));
for (let i = 0; ; i++) {
  try { await rpc("eth_chainId"); break; } catch { if (i > 300) throw new Error("anvil did not start"); await sleep(100); }
}
const chain = { ...elysium, rpcUrls: { default: { http: [RPC] } } };
const T = http(RPC, { timeout: 300_000 });
const pub = createPublicClient({ chain, transport: T, pollingInterval: 250 }) as PublicClient;
const relayer = createWalletClient({ chain, account: privateKeyToAccount(RELAYER_KEY), transport: T });

const relayed: Hex[] = [];
const relay = createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.end();
  let body = "";
  for await (const c of req) body += c;
  try {
    const call = JSON.parse(body) as { kind: string; to: `0x${string}`; data: Hex };
    const hash = await relayer.sendTransaction({ to: call.to, data: call.data });
    const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
    if (rc.status !== "success") throw new Error("reverted");
    relayed.push(hash);
    res.setHeader("content-type", "application/json");
    res.end(JSON.stringify({ txHash: hash }));
  } catch (e) {
    res.statusCode = 400;
    res.end(JSON.stringify({ error: String(e).slice(0, 300) }));
  }
});
relay.listen(RELAY);

// ── Montra's image and metadata store: a stand-in behind this site's real /api/montra-upload ─────────
const stored: { image?: number; doc?: Record<string, string> } = {};
const images: Buffer[] = [];
const imageUri = (n: number) => `http://127.0.0.1:${STORE}/img/${n}.png`; // served back, so the browser loads it
const IMAGE_URI = imageUri(0);
const METADATA_URI = "ipfs://bafkreitestmetadatadocument";
createServer(async (req, res) => {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const img = req.url?.match(/^\/img\/(\d+)\.png$/);
  if (img && images[+img[1]]) return res.setHeader("content-type", "image/png"), res.end(images[+img[1]]);
  res.setHeader("content-type", "application/json");
  if (req.url === "/api/metadata/image") return images.push(Buffer.concat(chunks)), (stored.image = images.at(-1)!.length), res.end(JSON.stringify({ uri: imageUri(images.length - 1) }));
  if (req.url === "/api/metadata") return (stored.doc = JSON.parse(Buffer.concat(chunks).toString())), res.end(JSON.stringify({ uri: METADATA_URI }));
  res.statusCode = 404;
  res.end("{}");
}).listen(STORE);
process.env.MONTRA_API = `http://127.0.0.1:${STORE}`;
const { POST: uploadFn } = await import("../api/montra-upload.js");
createServer(async (req, res) => {
  res.setHeader("access-control-allow-origin", "*");
  res.setHeader("access-control-allow-headers", "content-type");
  if (req.method === "OPTIONS") return res.end();
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const r: Response = await uploadFn(new Request(`http://127.0.0.1:${UPLOAD}${req.url}`, { method: "POST", headers: req.headers as Record<string, string>, body: Buffer.concat(chunks) }));
  res.statusCode = r.status;
  res.setHeader("content-type", "application/json");
  res.end(await r.text());
}).listen(UPLOAD);

let stop = false;
const oracle = Promise.resolve();

// ── the site, built against the fork ────────────────────────────────────────
log("Building the site against the fork");
execSync(`npx vite build --outDir dist-ui-montra`, { cwd: "apps/web", env: { ...process.env, VITE_RPC_URL: RPC, VITE_RELAY_URL: `http://127.0.0.1:${RELAY}`, VITE_MONTRA_UPLOAD: `http://127.0.0.1:${UPLOAD}/api/montra-upload` }, stdio: "ignore" });
procs.push(spawn("npx", ["vite", "preview", "--outDir", "dist-ui-montra", "--port", String(SITE), "--strictPort"], { cwd: "apps/web", stdio: "ignore" }));
await sleep(3000);

// an EIP-1193 wallet in the page: Alice's dev account on the fork (anvil signs for it)
const wallet = `(() => {
  const RPC = ${JSON.stringify(RPC)}, ME = ${JSON.stringify(ALICE)};
  let id = 0;
  const call = async (method, params) => {
    const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: ++id, method, params }) }).then((x) => x.json());
    if (r.error) throw Object.assign(new Error(r.error.message), { code: r.error.code });
    return r.result;
  };
  window.ethereum = {
    isTestWallet: true,
    on() {}, removeListener() {},
    async request({ method, params = [] }) {
      if (method === "eth_requestAccounts" || method === "eth_accounts") return [ME];
      if (method === "wallet_switchEthereumChain" || method === "wallet_addEthereumChain") return null;
      return call(method, params);
    },
  };
})();`;

const proxy = process.env.HTTPS_PROXY ? { server: process.env.HTTPS_PROXY, bypass: "127.0.0.1,localhost" } : undefined;
const browser = await chromium.launch({ proxy });
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 }, deviceScaleFactor: 2 });
await page.addInitScript(wallet);
page.on("pageerror", (e) => console.log("  pageerror:", e.message));
page.on("console", (m) => { if (/sweep|fallback|montra|error/i.test(m.text())) console.log("  console:", m.text().slice(0, 400)); });
const statusText = () => page.locator(".status").innerText();
async function waitStatus(re: RegExp, ms: number) {
  const end = Date.now() + ms;
  for (;;) {
    const s = await statusText();
    if (re.test(s)) return s;
    if (/err/.test((await page.locator(".status").innerHTML()) ?? "")) throw new Error(`site error: ${s}`);
    if (Date.now() > end) throw new Error(`timed out waiting for ${re} (status: ${s})`);
    await sleep(1000);
  }
}
const balance = async () => {
  const t = await page.getByTestId("private-balance").innerText();
  return /HYPE/.test(t) ? Number(t.replace(/[^0-9.]/g, "")) : 0;
};

// warm the fork: its first read of each Montra contract fetches from mainnet, slower than the site's 10 s timeout
log("Warming the fork with Montra's menu");
const { launchRows } = await import("../projects/montra/src/index.js");
check((await launchRows(pub)).length > 0, "Montra's menu reads on the fork");

try {
  await page.goto(`http://127.0.0.1:${SITE}/montra`);
  check(await page.getByText("Not run by Montra.").isVisible(), "the Montra page renders, with the notice");
  await page.locator("select option").first().waitFor({ state: "attached", timeout: 60_000 });
  check((await page.locator("select option").count()) > 0, "fee tiers read live from Montra's factory");

  log("Connect & go private");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await page.locator(".wallet-btn").waitFor({ timeout: 600_000 });
  check(true, "private account unlocked with one signature");
  await page.getByRole("button", { name: "Shield", exact: true }).first().click();
  await page.getByPlaceholder("HYPE to shield").fill("3");
  await page.locator(".sheet").getByRole("button", { name: "Shield", exact: true }).click();
  for (let i = 0; i < 600 && (await balance()) < 3; i++) await sleep(1000);
  check((await balance()) >= 3, `private balance shows ${await balance()} HYPE`);

  log("Launch UITST privately: dev buy 0.1, 25% of creator fees to holders");
  await page.getByPlaceholder("My Token").fill("UI Test");
  await page.getByPlaceholder("TICKER").fill("UITST");
  await page.getByLabel("Dev buy").fill("0.1");
  await page.getByRole("button", { name: "25%", exact: true }).click();
  await page.getByPlaceholder("One line about it").fill("A test token launched privately.");
  await page.getByPlaceholder("Website").fill("https://example.com");

  log("The image is checked before launch");
  await page.getByRole("button", { name: "Use a link instead" }).click();
  await page.getByPlaceholder("https://… or ipfs://…").fill(`http://127.0.0.1:${SITE}/montra`); // a web page, like a share link
  await page.getByText("doesn't open as an image").waitFor({ timeout: 30_000 });
  check(await page.getByRole("button", { name: "Launch UITST privately" }).isDisabled(), "a link that isn't an image is refused, and Launch stays off");
  await page.getByRole("button", { name: "Upload a file instead" }).click();
  await page.locator('input[type="file"][accept^="image/"]').setInputFiles({ name: "notes.txt", mimeType: "text/plain", buffer: Buffer.from("hello") });
  await page.getByText("Use a PNG, JPEG, WebP or GIF").waitFor({ timeout: 30_000 });
  check(true, "a file that isn't an image is refused");
  // two square token images, drawn in the page
  const draw = (bg: string, fg: string, text: string) =>
    page.evaluate(([bg, fg, text]) => {
      const c = document.createElement("canvas");
      c.width = c.height = 512;
      const g = c.getContext("2d")!;
      const grad = g.createLinearGradient(0, 0, 512, 512);
      grad.addColorStop(0, bg);
      grad.addColorStop(1, "#10161a");
      g.fillStyle = grad;
      g.fillRect(0, 0, 512, 512);
      g.fillStyle = fg;
      g.beginPath();
      g.arc(256, 256, 150, 0, Math.PI * 2);
      g.fill();
      g.fillStyle = bg;
      g.font = "800 120px sans-serif";
      g.textAlign = "center";
      g.textBaseline = "middle";
      g.fillText(text, 256, 266);
      return c.toDataURL("image/png").split(",")[1];
    }, [bg, fg, text]).then((b) => Buffer.from(b, "base64"));
  const imgA = await draw("#2d7388", "#f8f7f4", "UI");
  const imgB = await draw("#c9852e", "#f8f7f4", "2");
  await page.locator('input[type="file"][accept^="image/"]').setInputFiles({ name: "uitst.png", mimeType: "image/png", buffer: imgA });
  await page.getByText("uitst.png").waitFor({ timeout: 30_000 });
  check(/\d+×\d+/.test(await page.locator(".picker").innerText()), `a real image is accepted: ${(await page.locator(".picker .what").innerText()).replace(/\n/g, " ")}`);

  await page.getByRole("button", { name: "Launch UITST privately" }).click({ timeout: 600_000 });
  const card = page.getByTestId("launched");
  await card.waitFor({ timeout: 900_000 });
  check(true, "the launch opens its result card");
  check(!!stored.image && stored.doc?.name === "UI Test" && stored.doc?.symbol === "UITST" && stored.doc?.image === IMAGE_URI && stored.doc?.website === "https://example.com", `the image (${stored.image} bytes) and the details went to Montra's store first: ${JSON.stringify(stored.doc)}`);
  await card.getByText("Market cap").waitFor();
  for (let i = 0; i < 60 && /—|^\s*$/.test(await card.locator(".tok-stats .v").first().innerText()); i++) await sleep(1000);
  const statsText = (await card.locator(".tok-stats").innerText()).replace(/\n/g, " ");
  check(/Price .*HYPE/.test(statsText) && /Market cap .*HYPE/.test(statsText) && /Liquidity .*HYPE/.test(statsText), `the card shows price, market cap and liquidity: ${statsText}`);
  check((await card.innerText()).includes("UI Test") && (await card.innerText()).includes("$UITST") && (await card.innerText()).includes("A test token launched privately."), "with the name, ticker and description");
  const logoLoaded = await card.locator(".tok-logo img").first().evaluate((i: HTMLImageElement) => i.complete && i.naturalWidth > 0).catch(() => false);
  check(logoLoaded, "and its image, loaded");
  check((await card.innerText()).includes("Appears nowhere in it."), "and what the chain sees");
  await page.screenshot({ path: `${OUT}/montra-launched.png`, fullPage: false });
  await card.screenshot({ path: `${OUT}/montra-launched-card.png` });
  const raw = (await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("pfe.montra.v1")).map(([, v]) => v).join(""))) as string;
  const token = raw.match(/"token":"(0x[0-9a-fA-F]{40})"/)?.[1] as `0x${string}`;
  const mineSeat = raw.match(/"account":"(0x[0-9a-fA-F]{40})"/)?.[1] as `0x${string}`;
  check(!!token && !!mineSeat, `the mine is recorded: token ${token?.slice(0, 10)}…, mine ${mineSeat?.slice(0, 10)}…`);
  const creator = (await pub.readContract({ address: token, abi: ABI.token, functionName: "creator" })) as string;
  check(creator.toLowerCase() === mineSeat.toLowerCase(), "on chain, the token's creator is the mine, not Alice");
  const onchain = (await pub.readContract({ address: token, abi: ABI.token, functionName: "getTokenInfo" })) as [string, string, string];
  const meta = (await pub.readContract({ address: token, abi: ABI.token, functionName: "metaURI" })) as string;
  check(onchain[1] === IMAGE_URI && meta === METADATA_URI, "on chain, the token carries the stored image and metadata document");
  await page.getByText("UITST").first().waitFor();

  log("Someone trades UITST");
  const addrs = await montraAddresses(pub);
  const info = await tokenInfo(pub, token);
  const BOB = "0x00000000000000000000000000000000000b0b01";
  await rpc("anvil_impersonateAccount", [BOB]);
  await rpc("anvil_setBalance", [BOB, toHex(parseEther("100"))]);
  const buy = encodeFunctionData({ abi: ABI.router, functionName: "swapExactIn", args: [{ key: info.key, zeroForOne: true, amountIn: parseEther("30"), minAmountOut: 0n, recipient: BOB, deadline: 2n ** 40n }] });
  await pub.waitForTransactionReceipt({ hash: await rpc("eth_sendTransaction", [{ from: BOB, to: addrs.router, data: buy, value: toHex(parseEther("30")), gas: "0x1c9c380" }]) });
  check(true, "a trader bought UITST with 30 HYPE");

  log("Launch a second token, SECND, with its own image");
  await page.getByPlaceholder("My Token").fill("Second Test");
  await page.getByPlaceholder("TICKER").fill("SECND");
  await page.getByPlaceholder("One line about it").fill("The second private launch, for the screenshots.");
  await page.getByLabel("Dev buy").fill("0.2");
  await page.locator('input[type="file"][accept^="image/"]').setInputFiles({ name: "secnd.png", mimeType: "image/png", buffer: imgB });
  await page.getByText("secnd.png").waitFor({ timeout: 30_000 });
  await page.getByRole("button", { name: "Launch SECND privately" }).click({ timeout: 600_000 });
  await page.getByTestId("launched").filter({ hasText: "$SECND" }).waitFor({ timeout: 900_000 });
  check(true, "the second launch opens its own result card");
  for (let i = 0; i < 60 && (await page.locator(".panel .tok-card").count()) < 2; i++) await sleep(1000);
  check((await page.locator(".panel .tok-card").count()) === 2, "Your launches lists both tokens");
  for (let i = 0; i < 60 && (await page.locator(".panel .tok-card .tok-logo img").count()) < 2; i++) await sleep(1000);
  const loadedLogos = await page.locator(".panel .tok-card .tok-logo img").evaluateAll((xs) => xs.filter((i) => (i as HTMLImageElement).naturalWidth > 0).length);
  check(loadedLogos === 2, `each with its own image (${loadedLogos} loaded)`);
  await page.waitForTimeout(1500);
  await page.screenshot({ path: `${OUT}/montra-launched-2.png`, fullPage: false });
  await page.getByTestId("launched").screenshot({ path: `${OUT}/montra-launched-card.png` });
  await page.locator(".panel", { has: page.getByRole("tab") }).screenshot({ path: `${OUT}/montra-launches-tab.png` });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.waitForTimeout(800);
  await page.locator(".panel", { has: page.getByRole("tab") }).screenshot({ path: `${OUT}/montra-launches-phone.png` });
  await page.setViewportSize({ width: 1280, height: 1000 });

  log("Buy more UITST from its own mine, from the private balance");
  const mineHeld = async () => (await pub.readContract({ address: token, abi: ABI.token, functionName: "balanceOf", args: [mineSeat] })) as bigint;
  const heldBefore = await mineHeld();
  await page.locator(".panel .tok-card", { hasText: "$UITST" }).getByRole("button", { name: "Buy more" }).click();
  await page.getByLabel("HYPE to spend on more UITST").fill("0.1");
  await page.locator(".panel .tok-card", { hasText: "$UITST" }).getByRole("button", { name: /^Buy · / }).click();
  const more1 = await waitStatus(/more UITST with/, 900_000);
  check((await mineHeld()) > heldBefore, `${more1} (mine held ${heldBefore} → ${await mineHeld()})`);

  log("Claim the creator fees from the page");
  const before = await balance();
  const uitstCard = page.locator(".panel .tok-card", { hasText: "$UITST" });
  const claimBtn = uitstCard.getByRole("button", { name: "Claim fees", exact: true });
  for (let i = 0; i < 90 && !(await claimBtn.isEnabled().catch(() => false)); i++) await sleep(1000);
  check(await claimBtn.isEnabled(), "Claim fees is open once the fees cover their own gas");
  await claimBtn.click();
  const claimed = await waitStatus(/fees are in your private balance/, 900_000);
  check(/gas [0-9.<]+ HYPE, paid from them/.test(claimed), `"${claimed}"`);
  for (let i = 0; i < 120 && (await balance()) <= before; i++) await sleep(1000);
  check((await balance()) > before, `private balance ${before} → ${await balance()}`);

  log("Hold UITST privately, then sell");
  await page.getByPlaceholder("0x…").last().fill(token);
  await page.getByLabel("HYPE to spend", { exact: true }).fill("0.2");
  await page.getByRole("button", { name: /Buy privately/ }).click();
  const bought = await waitStatus(/Bought UITST from a fresh seat/, 900_000);
  check(true, bought);
  const holdCard = page.locator(".panel .tok-card", { hasText: "$UITST" });
  await holdCard.getByRole("button", { name: "Buy more" }).click();
  await page.getByLabel("HYPE to spend on more UITST").fill("0.1");
  await holdCard.getByRole("button", { name: /^Buy · / }).click();
  const more2 = await waitStatus(/more UITST with/, 900_000);
  check(true, `the holding bought more into the same seat: ${more2}`);
  await page.waitForTimeout(1500);
  await page.locator(".panel", { has: page.getByRole("tab") }).screenshot({ path: `${OUT}/montra-holdings-tab.png` });
  const sellBtn = page.getByRole("button", { name: "Sell", exact: true });
  await sellBtn.waitFor({ timeout: 120_000 });
  await sellBtn.click();
  const sold = await waitStatus(/Sold: about/, 900_000);
  check(true, sold);
  await page.screenshot({ path: `${OUT}/montra-1.png`, fullPage: true });

  const txs = await Promise.all(relayed.map((h) => pub.getTransaction({ hash: h })));
  check(txs.every((t) => t.from.toLowerCase() === relayer.account.address.toLowerCase()), `all ${txs.length} private transactions went through the relay`);
  check(txs.every((t) => !t.input.toLowerCase().includes(ALICE.slice(2).toLowerCase())), "the wallet's address is in none of their calldata");
  check(txs.some((t) => t.input.toLowerCase().includes(builderSuffix().slice(2))), "the launch carried our Montra Builders code");
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: `${OUT}/montra-failure.png`, fullPage: true }).catch(() => {});
} finally {
  stop = true;
  await oracle.catch(() => {});
  await browser.close();
  relay.close();
  procs.forEach((p) => p.kill());
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}
