/**
 * The site itself, driven in a real browser (Playwright's Chromium) against a fork of Elysium MAINNET: a wallet injected
 * into the page that forwards to the fork, a stand-in for Cloak's relay, and Eloscape's oracle played by this script.
 * Clicks through what a player does: connect, add HYPE privately, play (plain, then sealed + split), collect.
 *
 *   npm run test:ui        (needs anvil on PATH, Playwright's Chromium, and network access to the Elysium RPC and jsDelivr)
 */
import { spawn, execSync } from "node:child_process";
import { createServer } from "node:http";
import { createRequire } from "node:module";
import { createPublicClient, createWalletClient, encodeFunctionData, http, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { elysium } from "@cloakely/sdk";
import { ELOSCAPE, ELYSIUM_MAINNET, ELYSIUM_RPC, GAME_ABI, liveRound } from "../projects/eloscape/src/index.js";

const require = createRequire(import.meta.url);
const { chromium } = require("playwright") as typeof import("playwright");

const FORK = 8591, RELAY = 8787, SITE = 4174;
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

let forcedBlock: number | null = null;
let stop = false;
await rpc("anvil_impersonateAccount", [ELOSCAPE.randomnessOracle]);
await rpc("anvil_setBalance", [ELOSCAPE.randomnessOracle, "0x3635c9adc5dea00000"]);
const oracle = (async () => {
  while (!stop) {
    try {
      const r = await liveRound(pub);
      if (Number((await pub.getBlock()).timestamp) >= r.endTime) {
        const b = forcedBlock ?? Math.floor(Math.random() * 25);
        const data = encodeFunctionData({ abi: GAME_ABI, functionName: "onRandomnessSettled", args: [r.id, b, BigInt(Math.floor(Math.random() * 2 ** 40)) * 25n + BigInt(b)] });
        await pub.waitForTransactionReceipt({ hash: await rpc("eth_sendTransaction", [{ from: ELOSCAPE.randomnessOracle, to: ELOSCAPE.game, data, gas: "0x1c9c380" }]), timeout: 300_000 });
      }
    } catch {}
    await sleep(500);
  }
})();

// ── the site, built against the fork ────────────────────────────────────────
log("Building the site against the fork");
execSync(`npx vite build --outDir dist-ui-test`, { cwd: "apps/web", env: { ...process.env, VITE_RPC_URL: RPC, VITE_RELAY_URL: `http://127.0.0.1:${RELAY}` }, stdio: "ignore" });
procs.push(spawn("npx", ["vite", "preview", "--outDir", "dist-ui-test", "--port", String(SITE), "--strictPort"], { cwd: "apps/web", stdio: "ignore" }));
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
page.on("console", (m) => { if (/sweep|fallback/i.test(m.text())) console.log("  console:", m.text()); });
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

try {
  await page.goto(`http://127.0.0.1:${SITE}/#/`);
  check(await page.getByText("Privacy on Elysium").first().isVisible(), "hub page renders");
  await page.locator('a.pcard[href="/eloscape"]').click();
  await page.getByText("Not run by Eloscape.").waitFor();
  check(true, "Eloscape card opens the Eloscape page, with the notice");
  await page.locator(".stat").first().filter({ hasText: "#" }).waitFor({ timeout: 30_000 });
  check(true, "live round from the forked contract");

  log("Connect & go private");
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await page.locator(".wallet-btn").waitFor({ timeout: 600_000 });
  check(true, "private account unlocked with one signature");

  log("Shield 2 HYPE");
  await page.getByRole("button", { name: "Shield", exact: true }).first().click();
  await page.getByPlaceholder("HYPE to shield").fill("2");
  await page.locator(".sheet").getByRole("button", { name: "Shield", exact: true }).click();
  for (let i = 0; i < 600 && (await balance()) < 2; i++) await sleep(1000);
  check((await balance()) >= 2, `private balance shows ${await balance()} HYPE`);
  await page.screenshot({ path: `${OUT}/ui-1-funded.png`, fullPage: true });

  log("Play 0.5 on block 8, not sealed, forced win");
  await page.locator(".cell").nth(7).click();
  await page.locator('.switch input').first().uncheck();
  await page.getByLabel("Amount per block").fill("0.5");
  forcedBlock = 7;
  await page.getByRole("button", { name: "Play block 8", exact: true }).click({ timeout: 600_000 }); // after the shield finishes
  await waitStatus(/Played from seat/, 900_000);
  check(true, "played from a fresh seat");
  await page.locator(".seat").first().waitFor();
  check((await page.locator(".seat").count()) >= 1, "the seat is listed under Your seats");
  // wait for settlement, then for the page to show winnings
  const won = page.locator(".seat").first().locator(".num");
  for (let i = 0; i < 120; i++) {
    await page.waitForTimeout(5000);
    const t = await won.innerText().catch(() => "");
    if (/^[1-9]|0\.[0-9]*[1-9]/.test(t) && Number(t.split(" ")[0]) > 0.5) break;
  }
  forcedBlock = null;
  const wonText = await won.innerText();
  check(Number(wonText.split(" ")[0]) > 0.5, `the page shows the win: "${wonText}"`);
  await page.screenshot({ path: `${OUT}/ui-2-won.png`, fullPage: true });
  const before = await balance();
  await page.getByRole("button", { name: "Collect", exact: true }).first().click();
  const collected = await waitStatus(/Back in your private balance/, 900_000);
  check(/ELO swapped to HYPE/.test(collected), `the seat's ELO was swapped on collect: "${collected}"`);
  for (let i = 0; i < 60 && (await balance()) <= before; i++) await sleep(2000);
  check((await balance()) > before, `collected: private balance ${before} → ${await balance()}`);

  log("Sealed + split: 0.35 on block 21");
  await page.locator(".cell").nth(7).click(); // unselect 8
  await page.locator(".cell").nth(20).click();
  await page.locator('.switch input').first().check();
  await page.locator('.switch input').nth(1).check();
  await page.getByLabel("Amount per block").fill("0.35");
  check(/0\.2 \+ 0\.1 \+ 0\.05/.test(await page.getByText("one address each").innerText()), "the page shows the pieces 0.2 + 0.1 + 0.05");
  await page.getByRole("button", { name: "Play block 21", exact: true }).click();
  const s = await waitStatus(/Played as 3 separate seats/, 1_200_000);
  check(true, s);
  await page.screenshot({ path: `${OUT}/ui-3-split.png`, fullPage: true });

  log("Random Auto: 3 random blocks each round, 0.01 per block, 3 rounds");
  await page.getByRole("button", { name: "Auto", exact: true }).click();
  await page.getByRole("button", { name: "Random each round" }).click();
  await page.locator(".chips button", { hasText: /^3$/ }).click();
  await page.getByLabel("Amount per block").fill("0.01");
  await page.getByLabel("Number of rounds").fill("3");
  check(/Eloscape picks 3 blocks each round/.test(await page.locator(".board-actions .muted").innerText()), "the grid says Eloscape picks 3 blocks each round");
  check(/3, random each round/.test(await page.locator(".summary").innerText()), "the summary shows 3 random blocks per round");
  await page.getByRole("button", { name: "Start Auto for 3 rounds" }).click();
  await waitStatus(/Auto is running from seat/, 900_000);
  const autoRow = page.locator(".seat", { hasText: "random block" }).first();
  await autoRow.waitFor({ timeout: 60_000 });
  const autoSeat = ((await autoRow.locator("a").getAttribute("href")) ?? "").split("/").pop() as `0x${string}`;
  const cfg = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "standing", args: [autoSeat] });
  // standing(): active, isRandom, mask, phase, width, numBlocks, amountPerBlock, perRoundSpend, balance, startRound, endRound, lastClaimedRound
  check(cfg[0] && cfg[1] && cfg[4] === 3 && cfg[6] === 10n ** 16n, `on chain: seat ${autoSeat.slice(0, 10)}… runs random Auto, width 3, 0.01 per block, phase ${cfg[3]}`);
  check(cfg[10] - cfg[9] + 1n === 3n || cfg[10] - cfg[9] === 3n, `on chain: Auto covers 3 rounds (${cfg[9]} to ${cfg[10]})`);
  // let two rounds settle, then stop and collect what's left
  const r0 = (await liveRound(pub)).id;
  for (let i = 0; i < 300 && (await liveRound(pub)).id < r0 + 2n; i++) await sleep(1000);
  const beforeStop = await balance();
  await autoRow.getByRole("button", { name: /Stop & collect|Collect/ }).click();
  await waitStatus(/Back in your private balance/, 900_000);
  const after = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "standing", args: [autoSeat] });
  check(!after[0], "Auto stopped on chain");
  for (let i = 0; i < 60 && (await balance()) <= beforeStop; i++) await sleep(2000);
  check((await balance()) > beforeStop, `what was left came back privately: ${beforeStop} → ${await balance()}`);
  await page.screenshot({ path: `${OUT}/ui-4-random-auto.png`, fullPage: true });

  log("Fresh device: a timed-out seat's fallback comes back with no local records");
  // a seat's fallback is a receive address of the private account (index 1000 up), fixed in its key. After the
  // seat's timeout anyone can push its funds there; simulate that push, then wipe the browser's storage (a new device)
  const raw = (await page.evaluate(() => Object.entries(localStorage).filter(([k]) => k.startsWith("pfe.eloscape.seats.v1")).map(([, v]) => v).join(""))) as string;
  const fbs = [...raw.matchAll(/"fallbackTo":"(0x[0-9a-fA-F]{40})"/g)].map((m) => m[1]);
  check(fbs.length > 0, `the seats' fallbacks are receive addresses of the private account (${fbs.length} seats)`);
  const fb = fbs[fbs.length - 1];
  await rpc("eth_sendTransaction", [{ from: ALICE, to: fb, value: "0x429d069189e0000" }]); // 0.3 HYPE, as a timeout push would
  const beforeWipe = await balance();
  await page.evaluate(() => localStorage.clear());
  await page.goto(`http://127.0.0.1:${SITE}/eloscape`);
  await page.getByRole("button", { name: "Connect", exact: true }).first().click();
  await page.locator(".wallet-btn").waitFor({ timeout: 600_000 });
  for (let i = 0; i < 900 && (await balance()) < beforeWipe + 0.29; i++) await sleep(1000);
  check((await balance()) >= beforeWipe + 0.29, `swept on a fresh device: private balance ${beforeWipe} → ${await balance()}`);
  const counter = Number(await page.evaluate(() => Object.entries(localStorage).find(([k]) => k.startsWith("pfe.fallback.v1"))?.[1] ?? "0"));
  check(counter > 1000 + fbs.length - 1, `new seats start past the fallbacks already used (next index ${counter})`);

  const froms = await Promise.all(relayed.map((h) => pub.getTransaction({ hash: h }).then((t) => t.from.toLowerCase())));
  check(froms.every((f) => f === relayer.account.address.toLowerCase()), `all ${relayed.length} private transactions went through the relay`);
  const inputs = await Promise.all(relayed.map((h) => pub.getTransaction({ hash: h }).then((t) => t.input.toLowerCase())));
  check(inputs.every((d) => !d.includes(ALICE.slice(2).toLowerCase())), "the wallet's address is in none of their calldata");
} catch (e) {
  failures++;
  console.error(e);
  await page.screenshot({ path: `${OUT}/ui-failure.png`, fullPage: true }).catch(() => {});
} finally {
  stop = true;
  await oracle.catch(() => {});
  await browser.close();
  relay.close();
  procs.forEach((p) => p.kill());
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}
