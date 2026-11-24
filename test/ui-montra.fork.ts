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

const FORK = 8592, RELAY = 8788, SITE = 4175;
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

let stop = false;
const oracle = Promise.resolve();

// ── the site, built against the fork ────────────────────────────────────────
log("Building the site against the fork");
execSync(`npx vite build --outDir dist-ui-montra`, { cwd: "apps/web", env: { ...process.env, VITE_RPC_URL: RPC, VITE_RELAY_URL: `http://127.0.0.1:${RELAY}` }, stdio: "ignore" });
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
const page = await browser.newPage({ viewport: { width: 1280, height: 1000 } });
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
  await page.getByRole("button", { name: "Launch UITST privately" }).click({ timeout: 600_000 });
  const launched = await waitStatus(/Launched UITST/, 900_000);
  check(true, launched);
  const raw = (await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("pfe.montra.v1")).map(([, v]) => v).join(""))) as string;
  const token = raw.match(/"token":"(0x[0-9a-fA-F]{40})"/)?.[1] as `0x${string}`;
  const mineSeat = raw.match(/"account":"(0x[0-9a-fA-F]{40})"/)?.[1] as `0x${string}`;
  check(!!token && !!mineSeat, `the mine is recorded: token ${token?.slice(0, 10)}…, mine ${mineSeat?.slice(0, 10)}…`);
  const creator = (await pub.readContract({ address: token, abi: ABI.token, functionName: "creator" })) as string;
  check(creator.toLowerCase() === mineSeat.toLowerCase(), "on chain, the token's creator is the mine, not Alice");
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

  log("Claim the creator fees from the page");
  const before = await balance();
  const claimBtn = page.getByRole("button", { name: "Claim fees", exact: true });
  for (let i = 0; i < 90 && !(await claimBtn.isEnabled().catch(() => false)); i++) await sleep(1000);
  check(await claimBtn.isEnabled(), "Claim fees is open once the fees cover their own gas");
  await claimBtn.click();
  const claimed = await waitStatus(/fees are in your private balance/, 900_000);
  check(/gas [0-9.<]+ HYPE, paid from them/.test(claimed), `"${claimed}"`);
  for (let i = 0; i < 120 && (await balance()) <= before; i++) await sleep(1000);
  check((await balance()) > before, `private balance ${before} → ${await balance()}`);

  log("Hold UITST privately, then sell");
  await page.getByPlaceholder("0x…").last().fill(token);
  await page.getByLabel("HYPE to spend").fill("0.2");
  await page.getByRole("button", { name: /Buy privately/ }).click();
  const bought = await waitStatus(/Bought UITST from a fresh seat/, 900_000);
  check(true, bought);
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
