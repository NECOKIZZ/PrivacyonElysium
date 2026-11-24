/**
 * Private launches and private holding on Montra, end to end, on a fork of Elysium MAINNET (99901): Montra's real
 * factory, hook, router, lens and splitters (read from its registry), Gloam's real shielded vault and Cloak's real
 * escrow (CloakGloamBids), with real zero-knowledge proofs. Nothing is deployed.
 *
 *   npm run test:montra       (needs anvil on PATH, and network access to the Elysium RPC and jsDelivr)
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, parseEther, toHex, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { GloamPrivate, elysium, gloamProvers, type GloamCore } from "@cloakely/sdk";
import { ELYSIUM_MAINNET, ELYSIUM_RPC, HYPE, PRIVACY, type ReceiveRoute } from "../projects/eloscape/src/index.js";
import {
  ABI, BUILDER_CODE, builderSuffix, buyPrivately, claimHoldingRewards, claimMineFees, holdingView, launchFromMine, launchRows, mineOwed, montraAddresses, quote, sellPrivately, tokenInfo,
  type Holding, type Mine,
} from "../projects/montra/src/index.js";

const PORT = 8595;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = { alice: generatePrivateKey(), bob: generatePrivateKey(), relayer: generatePrivateKey() };
const BUILDER_FEE_TO = privateKeyToAccount(generatePrivateKey()).address; // stands in for our fee wallet
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const t0 = performance.now();
const log = (...a: unknown[]) => console.log(`[${((performance.now() - t0) / 1000).toFixed(0).padStart(4)}s]`, ...a);
let failures = 0;
function check(ok: boolean, what: string) {
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${what}`);
  if (!ok) failures++;
}
async function rpc(method: string, params: unknown[] = []) {
  const r = await fetch(RPC, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) }).then((x) => x.json());
  if (r.error) throw new Error(`${method}: ${r.error.message}`);
  return r.result;
}

// ── fork ────────────────────────────────────────────────────────────────────
const anvil = spawn("anvil", ["--fork-url", process.env.FORK_URL ?? ELYSIUM_RPC, "--chain-id", String(ELYSIUM_MAINNET), "--port", String(PORT), "--block-time", "1", "--silent", "--fork-header", "User-Agent: curl/8.5.0"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
for (let i = 0; ; i++) {
  try { await rpc("eth_chainId"); break; } catch { if (i > 300) throw new Error("anvil did not start"); await sleep(100); }
}
const chain = { ...elysium, rpcUrls: { default: { http: [RPC] } } };
const T = http(RPC, { timeout: 300_000, retryCount: 3 });
const pub = createPublicClient({ chain, transport: T, pollingInterval: 250 }) as PublicClient;
const wallet = (k: Hex) => createWalletClient({ chain, account: privateKeyToAccount(k), transport: T });
const alice = wallet(KEYS.alice), bob = wallet(KEYS.bob), relayer = wallet(KEYS.relayer);
for (const a of [alice, bob, relayer]) await rpc("anvil_setBalance", [a.account.address, toHex(parseEther("500"))]);

/** Stand-in for Cloak's relay: sends the exact call it is given, from its own wallet. */
const sent: Hex[] = [];
async function submit(call: { kind: string; to: Address; data: Hex }): Promise<Hex> {
  const hash = await relayer.sendTransaction({ to: call.to, data: call.data });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`relayed ${call.kind} reverted (${hash})`);
  sent.push(hash);
  return hash;
}
const warp = async (s: number) => { await rpc("evm_increaseTime", [s]); await rpc("evm_mine", []); };

try {
  const addrs = await montraAddresses(pub);
  log(`Fork of Elysium mainnet at block ${await pub.getBlockNumber()}; Montra factory ${addrs.factory}, router ${addrs.router}`);
  const rows = await launchRows(pub);
  check(rows.length > 0, `Montra's menu has ${rows.length} HYPE rows; using row ${rows[0]?.id} (${(rows[0]?.totalFeePips ?? 0) / 10_000}% fee)`);
  const row = rows.find((r) => r.earlyBuyFeeWindow === 0) ?? rows[0];

  // ── Alice's private balance ───────────────────────────────────────────────
  let saved: unknown[] = [];
  const A = await GloamPrivate.unlock(alice, {
    publicClient: pub, chainId: ELYSIUM_MAINNET,
    gloamVault: { pool: PRIVACY.gloamVault, poolBlock: PRIVACY.gloamVaultBlock },
    payMemo: PRIVACY.memoBoard, whype: PRIVACY.whype, bids: PRIVACY.bids, receive: PRIVACY.receive,
    provers: gloamProvers(), submit, logChunk: 50_000n,
    records: { load: () => saved as never, save: (x: unknown[]) => (saved = x) },
  } as never);
  const core = A.cores[0] as GloamCore;
  const privateHype = async () => (await core.sync(), core.ownNotes(HYPE).reduce((a, n) => a + n.amount, 0n));
  log("Alice shields 10 HYPE (the one public step)");
  await A.shieldHype(alice, parseEther("10"));
  check((await privateHype()) === parseEther("10"), "Alice holds 10 HYPE privately");
  let nextIdx = 1000;
  const fallbackTo = async () => A.receiveAddress(nextIdx++);
  const viaReceive = async (): Promise<ReceiveRoute> => { const n = nextIdx++; return { address: await A.receiveAddress(n), collect: () => A.collectReceived(n) }; };
  const plan = { fallbackTo };
  const step = (s: string) => log("   ", s);

  const bobTrade = async (info: Awaited<ReturnType<typeof tokenInfo>>, buyHype: bigint, sellShare: bigint) => {
    await bob.writeContract({ address: addrs.router, abi: ABI.router, functionName: "swapExactIn", args: [{ key: info.key, zeroForOne: true, amountIn: buyHype, minAmountOut: 0n, recipient: bob.account.address, deadline: 2n ** 40n }], value: buyHype });
    await sleep(1500);
    const bal = (await pub.readContract({ address: info.token, abi: ABI.token, functionName: "balanceOf", args: [bob.account.address] })) as bigint;
    const sell = (bal * sellShare) / 100n;
    await bob.writeContract({ address: info.token, abi: ABI.token, functionName: "approve", args: [addrs.router, sell] });
    await sleep(1500);
    await bob.writeContract({ address: addrs.router, abi: ABI.router, functionName: "swapExactIn", args: [{ key: info.key, zeroForOne: false, amountIn: sell, minAmountOut: 0n, recipient: bob.account.address, deadline: 2n ** 40n }] });
    await sleep(1500);
  };

  // ── 1. A private launch: the mine is the creator and takes all the creator fees ──
  log("1 · Alice launches PRIV from a mine funded in pieces 0.2 + 0.2 + 0.1 (dev buy 0.5 HYPE)");
  const launchFee = (await pub.readContract({ address: addrs.factory, abi: ABI.factory, functionName: "launchFee" })) as bigint;
  const m1: Mine = await launchFromMine(core, { name: "Private Test", symbol: "PRIV", configId: row.id, devBuy: parseEther("0.5") - launchFee, split: { creator: 10_000, holders: 0 }, pieces: [parseEther("0.2"), parseEther("0.2"), parseEther("0.1")] }, plan, step);
  const info1 = await tokenInfo(pub, m1.token);
  const creator1 = (await pub.readContract({ address: m1.token, abi: ABI.token, functionName: "creator" })) as Address;
  check(creator1.toLowerCase() === m1.seat.account.toLowerCase(), `the mine ${m1.seat.account.slice(0, 10)}… is PRIV's creator on chain`);
  check(m1.recipient.toLowerCase() === m1.seat.account.toLowerCase(), "the mine is the fee recipient");
  const devTokens = (await pub.readContract({ address: m1.token, abi: ABI.token, functionName: "balanceOf", args: [m1.seat.account] })) as bigint;
  check(devTokens > 0n, `the mine holds the dev buy: ${formatEther(devTokens)} PRIV`);
  const launchTx = await pub.getTransaction({ hash: m1.launchTx });
  check(launchTx.input.toLowerCase().includes(builderSuffix().slice(2)), `the launch transaction carries our builder code "${BUILDER_CODE}" (ERC-8021)`);
  check(launchTx.from.toLowerCase() === relayer.account.address.toLowerCase(), "the launch was sent by the relay");

  log("   Bob trades PRIV: buys with 20 HYPE, sells half back");
  await bobTrade(info1, parseEther("20"), 50n);
  const owed1 = await mineOwed(pub, m1);
  check(owed1 > 0n, `creator fees owed to the mine: ${formatEther(owed1)} HYPE`);
  const before1 = await privateHype();
  const c1 = await claimMineFees(core, m1, viaReceive, step);
  const after1 = await privateHype();
  check(after1 - before1 === c1.paid && c1.paid > 0n, `creator fees reached Alice's private balance: +${formatEther(c1.paid)} HYPE (gas ${formatEther(c1.gas)} paid from them)`);
  const paidRelay = (await Promise.all(sent.slice(-6).map((h) => pub.getTransaction({ hash: h })))).some((t) => t.input.toLowerCase().includes(relayer.account.address.slice(2).toLowerCase()));
  check(paidRelay, "the mine paid the relay its claim's gas");

  // ── 2. A split: mine 60%, holders 30%, our builder slot 10% ────────────
  log("2 · Alice launches SPLT: creator 60% to the mine, 30% to holders, 10% to our builder slot");
  const m2 = await launchFromMine(core, { name: "Split Test", symbol: "SPLT", configId: row.id, devBuy: parseEther("0.3") - launchFee, split: { creator: 6_000, holders: 3_000, builder: { to: BUILDER_FEE_TO, bps: 1_000 } } }, plan, step);
  check(!!m2.splitter && m2.recipient.toLowerCase() === m2.splitter.toLowerCase(), `a FeeSplitter ${m2.splitter?.slice(0, 10)}… receives SPLT's creator fees`);
  const [rec, shares] = await Promise.all([
    pub.readContract({ address: m2.splitter!, abi: ABI.splitter, functionName: "recipients" }) as Promise<Address[]>,
    pub.readContract({ address: m2.splitter!, abi: ABI.splitter, functionName: "shares" }) as Promise<readonly number[]>,
  ]);
  check(rec.length === 3 && rec[0].toLowerCase() === m2.seat.account.toLowerCase() && rec[2].toLowerCase() === BUILDER_FEE_TO.toLowerCase() && shares.join() === "6000,3000,1000", `split recipients: mine 60%, holders 30%, builder 10%`);
  const info2 = await tokenInfo(pub, m2.token);

  // ── 3. Private holding: buy SPLT from a seat, earn holder rewards, claim, sell ──
  log("3 · Alice buys SPLT privately: 2 HYPE in pieces 1 + 1");
  const h: Holding = await buyPrivately(core, m2.token, parseEther("2"), plan, { pieces: [parseEther("1"), parseEther("1")] }, step);
  const hv = await holdingView(pub, h);
  check(hv.balance > 0n, `the holding seat ${h.seat.account.slice(0, 10)}… holds ${formatEther(hv.balance)} SPLT`);
  const aliceSplt = (await pub.readContract({ address: m2.token, abi: ABI.token, functionName: "balanceOf", args: [alice.account.address] })) as bigint;
  check(aliceSplt === 0n, "Alice's wallet holds no SPLT");
  log("   Bob trades SPLT heavily; the fees stream to holders over the hour");
  for (let i = 0; i < 3; i++) await bobTrade(info2, parseEther("30"), 100n);
  await bob.writeContract({ address: m2.token, abi: ABI.token, functionName: "distribute" });
  await sleep(1500);
  await warp(3700);
  const hv2 = await holdingView(pub, h);
  check(hv2.earned > 0n, `the holding earned ${formatEther(hv2.earned)} HYPE in holder rewards`);
  const before3 = await privateHype();
  const c3 = await claimHoldingRewards(core, h, viaReceive, step);
  const after3 = await privateHype();
  check(after3 - before3 === c3.paid && c3.paid > 0n, `rewards reached Alice's private balance: +${formatEther(c3.paid)} HYPE (gas ${formatEther(c3.gas)} paid from them)`);
  const owed2 = await mineOwed(pub, m2);
  check(owed2 > 0n, `the mine's 60% of SPLT's fees: ${formatEther(owed2)} HYPE`);
  const before2 = await privateHype();
  const c2 = await claimMineFees(core, m2, viaReceive, step);
  check((await privateHype()) - before2 === c2.paid && c2.paid > 0n, `split creator fees reached Alice's private balance: +${formatEther(c2.paid)} HYPE`);
  const builderOwed = (await pub.readContract({ address: m2.splitter!, abi: ABI.splitter, functionName: "owed", args: [BUILDER_FEE_TO] })) as bigint;
  check(builderOwed > 0n, `our builder slot has ${formatEther(builderOwed)} HYPE to collect`);

  log("   Alice sells the holding privately");
  const expected = await quote(pub, info2, false, hv2.balance);
  const before4 = await privateHype();
  await sellPrivately(core, h, viaReceive, {}, step);
  const after4 = await privateHype();
  check(after4 > before4, `the sale's HYPE is back in Alice's private balance: +${formatEther(after4 - before4)} (quoted ${formatEther(expected)})`);
  check(((await holdingView(pub, h)).balance) === 0n, "the holding seat holds no SPLT any more");

  log("4 · The mine sells its dev buy privately");
  const before5 = await privateHype();
  await sellPrivately(core, { seat: m1.seat, token: m1.token, symbol: "PRIV", name: "Private Test", spent: 0n }, viaReceive, {}, step);
  check((await privateHype()) > before5, `the dev buy's HYPE is back in Alice's private balance (+${formatEther((await privateHype()) - before5)})`);

  // ── privacy ───────────────────────────────────────────────────────────────
  const txs = await Promise.all(sent.map((h) => pub.getTransaction({ hash: h })));
  check(txs.every((t) => t.from.toLowerCase() === relayer.account.address.toLowerCase()), `all ${txs.length} private transactions were sent by the relay`);
  check(txs.every((t) => !t.input.toLowerCase().includes(alice.account.address.slice(2).toLowerCase())), "Alice's wallet address is in none of their calldata");
  const aliceSent = Number(await pub.getTransactionCount({ address: alice.account.address }));
  check(aliceSent === 1, `Alice's wallet sent ${aliceSent} transaction (the shield)`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  anvil.kill();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}
