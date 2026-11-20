/**
 * Private play on Eloscape, end to end, on a fork of Elysium MAINNET (99901), against Eloscape's real game, Gloam's
 * real shielded vault and Cloak's real escrow (CloakGloamBids). Real zero-knowledge proofs on Gloam's final keys.
 * Nothing is deployed: everything runs on contracts that are live on mainnet today.
 *
 * The fork runs 1-second blocks, and a loop here plays Eloscape's randomness oracle: it settles each round when it
 * closes (on mainnet a drand beacon does), choosing the winning block so the test can force a win.
 *
 *   npm run test:fork           (needs anvil on PATH, and network access to the Elysium RPC and jsDelivr)
 */
import { spawn } from "node:child_process";
import { createPublicClient, createWalletClient, encodeFunctionData, formatEther, http, parseAbiItem, parseEther, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount, generatePrivateKey } from "viem/accounts";
import { GloamPrivate, elysium, gloamProvers, type GloamCore } from "@cloakely/sdk";
import {
  ELOSCAPE, ELYSIUM_MAINNET, ELYSIUM_RPC, GAME_ABI, HYPE, PRIVACY,
  autoFixedCall, collect, deployCall, liveRound, openSeat, owed, playValue, sealAndSend, seatCall, splitSizes, type Seat,
} from "../projects/eloscape/src/index.js";

const PORT = 8590;
const RPC = `http://127.0.0.1:${PORT}`;
const KEYS = {
  alice: "0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d" as Hex, // anvil #1
  relayer: "0xdbda1821b80551c9d65939329250298aa3472ba22feea921c0cf5d620ea67b97" as Hex, // anvil #8
};
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
const anvil = spawn("anvil", ["--fork-url", process.env.FORK_URL ?? ELYSIUM_RPC, "--chain-id", String(ELYSIUM_MAINNET), "--port", String(PORT), "--block-time", "1", "--silent"], { stdio: "ignore" });
process.on("exit", () => anvil.kill());
for (let i = 0; ; i++) {
  try { await rpc("eth_chainId"); break; } catch { if (i > 300) throw new Error("anvil did not start"); await sleep(100); }
}
const chain = { ...elysium, rpcUrls: { default: { http: [RPC] } } };
const T = http(RPC, { timeout: 300_000, retryCount: 3 });
const pub = createPublicClient({ chain, transport: T, pollingInterval: 250 }) as PublicClient;
const alice = createWalletClient({ chain, account: privateKeyToAccount(KEYS.alice), transport: T });
const relayer = createWalletClient({ chain, account: privateKeyToAccount(KEYS.relayer), transport: T });

/** Stand-in for Cloak's relay: sends the exact call it is given, from its own wallet. */
const sent: Hex[] = [];
async function submit(call: { kind: string; to: Address; data: Hex }): Promise<Hex> {
  const hash = await relayer.sendTransaction({ to: call.to, data: call.data });
  const r = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
  if (r.status !== "success") throw new Error(`relayed ${call.kind} reverted (${hash})`);
  sent.push(hash);
  return hash;
}

// ── Eloscape's oracle, played by the test ───────────────────────────────────
let forcedBlock: number | null = null;
let settledRounds = 0;
let stopOracle = false;
await rpc("anvil_impersonateAccount", [ELOSCAPE.randomnessOracle]);
await rpc("anvil_setBalance", [ELOSCAPE.randomnessOracle, "0x3635c9adc5dea00000"]);
const oracleLoop = (async () => {
  while (!stopOracle) {
    try {
      const r = await liveRound(pub);
      const now = Number((await pub.getBlock()).timestamp);
      if (now >= r.endTime) {
        const block = forcedBlock ?? Math.floor(Math.random() * 25);
        const data = encodeFunctionData({ abi: GAME_ABI, functionName: "onRandomnessSettled", args: [r.id, block, BigInt(Math.floor(Math.random() * 2 ** 48))] });
        const hash = (await rpc("eth_sendTransaction", [{ from: ELOSCAPE.randomnessOracle, to: ELOSCAPE.game, data, gas: "0x1c9c380" }])) as Hex;
        const rc = await pub.waitForTransactionReceipt({ hash, timeout: 300_000 });
        if (rc.status === "success") settledRounds++;
      }
    } catch (e) {
      // a round already settled by a racing tick, or one not ended yet: try again next tick
    }
    await sleep(500);
  }
})();

async function waitRoundWithAtLeast(seconds: number) {
  for (;;) {
    const r = await liveRound(pub);
    const now = Number((await pub.getBlock()).timestamp);
    if (now >= r.startTime && r.endTime - now >= seconds) return r;
    await sleep(500);
  }
}
async function waitSettled(roundId: bigint) {
  for (;;) {
    const [, , , settled] = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "roundTotals", args: [roundId] });
    if (settled) return;
    await sleep(500);
  }
}

try {
  log(`Fork of Elysium mainnet at block ${await pub.getBlockNumber()}, Eloscape round ${(await liveRound(pub)).id}`);

  // ── Alice's private balance ───────────────────────────────────────────────
  let saved: unknown[] = [];
  const A = await GloamPrivate.unlock(alice, {
    publicClient: pub,
    chainId: ELYSIUM_MAINNET,
    gloamVault: { pool: PRIVACY.gloamVault, poolBlock: PRIVACY.gloamVaultBlock },
    payMemo: PRIVACY.memoBoard,
    whype: PRIVACY.whype,
    bids: PRIVACY.bids,
    provers: gloamProvers(),
    submit,
    logChunk: 50_000n,
    records: { load: () => saved as never, save: (x: unknown[]) => (saved = x) },
  } as never);
  const core = A.cores[0] as GloamCore;
  const privateHype = async () => (await core.sync(), core.ownNotes(HYPE).reduce((a, n) => a + n.amount, 0n));
  log("Alice shields 3 HYPE into Gloam's vault (the one public step, done well before playing)");
  await A.shieldHype(alice, parseEther("3"));
  const start = await privateHype();
  check(start === parseEther("3"), `Alice holds 3 HYPE privately (${formatEther(start)})`);
  const fallbackTo = privateKeyToAccount(generatePrivateKey()).address;
  const exitAfter = BigInt(Math.floor(Date.now() / 1000) + 7 * 86400);

  // ── Phase 1: Private Play, forced win on block 7 ──────────────────────────
  log("Phase 1 · Private Play: 0.5 HYPE on block 7");
  const seat1 = await openSeat(core, { amount: parseEther("0.5"), fallbackTo, exitAfter }, (s) => log("   ", s));
  const r1 = await waitRoundWithAtLeast(15);
  forcedBlock = 7;
  await seatCall(core, seat1, { target: ELOSCAPE.game, value: playValue(seat1.arrived, [7]), data: deployCall([7]) });
  const m1 = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "getMiner", args: [r1.id, seat1.account] });
  check(m1.deployedMask === 1n << 7n, `the seat ${seat1.account.slice(0, 10)}… is the miner on block 7 in round ${r1.id}`);
  const aliceInRound = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "getMiner", args: [r1.id, alice.account.address] });
  check(aliceInRound.deployedMask === 0n, "Alice's wallet does not appear in the round");
  await waitSettled(r1.id);
  forcedBlock = null;
  const won = await owed(pub, seat1.account);
  check(won.hype > seat1.arrived - 1n, `the seat won: ${formatEther(won.hype)} HYPE claimable, ${formatEther(won.elo)} ELO`);
  const before1 = await privateHype();
  await collect(core, seat1, (s) => log("   ", s));
  const after1 = await privateHype();
  check(after1 - before1 === won.hype, `winnings are back in Alice's private balance (+${formatEther(after1 - before1)} HYPE)`);
  check((await pub.getBalance({ address: seat1.account })) === 0n, "the seat is empty");

  // ── Phase 1: Private Auto over a few rounds, then stop and collect ────────
  log("Phase 1 · Private Auto: 0.3 HYPE, 0.01 per block on blocks 3 and 4");
  const seat2 = await openSeat(core, { amount: parseEther("0.3"), fallbackTo, exitAfter }, (s) => log("   ", s));
  await waitRoundWithAtLeast(10);
  const perBlock = parseEther("0.01");
  const rounds = seat2.arrived / (perBlock * 2n);
  await seatCall(core, seat2, { target: ELOSCAPE.game, value: rounds * perBlock * 2n, data: autoFixedCall([3, 4], perBlock) });
  const st = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "standing", args: [seat2.account] });
  check(st[0] && st[2] === (1n << 3n) | (1n << 4n), `the seat runs Auto on blocks 3 and 4 for up to ${rounds} rounds`);
  const settledAtStart = settledRounds;
  while (settledRounds < settledAtStart + 2) await sleep(1000);
  await waitRoundWithAtLeast(5);
  const before2 = await privateHype();
  await collect(core, seat2, (s) => log("   ", s));
  const after2 = await privateHype();
  const st2 = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "standing", args: [seat2.account] });
  check(!st2[0], "Auto stopped");
  check(after2 > before2, `what was left came back privately (+${formatEther(after2 - before2)} HYPE)`);

  // ── Phase 2: Sealed Play ──────────────────────────────────────────────────
  log("Phase 2 · Sealed Play: 0.2 HYPE on block 12, sent 6 s before close");
  const seat3 = await openSeat(core, { amount: parseEther("0.2"), fallbackTo, exitAfter }, (s) => log("   ", s));
  let sealedFor = 0n;
  let sendAt = 0;
  const sealed = await sealAndSend(core, [seat3], [12], { onSealed: (_c, at, rid) => ((sendAt = at), (sealedFor = rid)) }, (s) => log("   ", s));
  const rc3 = await pub.getTransactionReceipt({ hash: sealed.txs[0] });
  const landed = Number((await pub.getBlock({ blockNumber: rc3.blockNumber })).timestamp);
  const r3 = await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "getRoundDeployed", args: [sealedFor] });
  const end3 = Number((await pub.readContract({ address: ELOSCAPE.game, abi: GAME_ABI, functionName: "settlementTime", args: [sealedFor] })));
  check(landed >= sendAt && landed < end3, `the play landed ${end3 - landed}s before round ${sealedFor} closed (sealed until then)`);
  check(r3[12] >= playValue(seat3.arrived, [12]), "and it's on block 12");
  await waitSettled(sealedFor);
  await collect(core, seat3, (s) => log("   ", s));

  // ── Phase 3A: Split Play, sealed ──────────────────────────────────────────
  log("Phase 3A · Split Play: 0.35 HYPE as standard pieces, sealed, on block 20");
  const { pieces } = splitSizes(parseEther("0.35"));
  check(pieces.map((p) => formatEther(p)).join("+") === "0.2+0.1+0.05", `0.35 splits into ${pieces.map((p) => formatEther(p)).join(" + ")}`);
  const seats: Seat[] = [];
  const used = new Set<bigint>();
  for (const p of pieces) seats.push(await openSeat(core, { amount: p, fallbackTo, exitAfter, exclude: used }, (s) => log("   ", s)));
  const split = await sealAndSend(core, seats, [20], { jitterSeconds: 3 }, (s) => log("   ", s));
  const distinct = new Set(seats.map((s) => s.account.toLowerCase()));
  check(distinct.size === pieces.length, `${pieces.length} separate seats played round ${split.roundId}`);
  const evs = await pub.getLogs({ address: ELOSCAPE.game, event: parseAbiItem("event Deployed(uint64 indexed roundId, address indexed user, uint256 amountPerBlock, uint256 blockMask, uint256 totalAmount)"), args: { roundId: split.roundId }, fromBlock: (await pub.getBlockNumber()) - 200n });
  const ours = evs.filter((e) => distinct.has((e.args.user as string).toLowerCase()));
  check(ours.length === pieces.length, `Eloscape recorded ${ours.length} independent plays, none from Alice's wallet`);
  await waitSettled(split.roundId);
  for (const s of seats) await collect(core, s);

  // ── privacy checks over everything ────────────────────────────────────────
  const froms = await Promise.all(sent.map((h) => pub.getTransaction({ hash: h }).then((t) => t.from.toLowerCase())));
  const relayerAddr = relayer.account.address.toLowerCase();
  check(froms.every((f) => f === relayerAddr), `all ${sent.length} private transactions were sent by the relay; Alice's wallet sent only the shield`);
  const end = await privateHype();
  log(`Alice's private HYPE: ${formatEther(start)} → ${formatEther(end)}`);
} catch (e) {
  failures++;
  console.error(e);
} finally {
  stopOracle = true;
  await oracleLoop.catch(() => {});
  anvil.kill();
  console.log(failures ? `\n${failures} check(s) failed` : "\nAll checks passed");
  process.exit(failures ? 1 : 0);
}
