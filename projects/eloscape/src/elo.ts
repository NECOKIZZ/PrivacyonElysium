/**
 * A seat's ELO, two ways out:
 *  - sendSeatElo (seat.ts): claim it and send it to an address the player chooses (public from there on);
 *  - swapSeatEloToHype (here): claim it, swap it to HYPE in ELO's canonical Uniswap v4 pool, and put the HYPE back
 *    into the player's private balance. The ELO never touches a public address of the player's.
 *
 * ELO can only trade in v4 pools with Eloscape's canonical hook (its token gates the PoolManager), so the swap goes
 * through Uniswap's Universal Router in the HYPE/ELO 1% pool with that hook. The hook charges its own fee on top of
 * the pool's 1% (about 3% at the time of writing). Checked on a fork of Elysium mainnet.
 */
import { encodeAbiParameters, encodeFunctionData, keccak256, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import type { GloamCore } from "@cloakely/sdk";
import { ELOSCAPE, HYPE } from "./config.js";
import { claimEloCall } from "./game.js";
import { returnSeat, seatCall, type ReceiveRoute, type Seat, type Status } from "./seat.js";

export const UNISWAP = {
  poolManager: "0xE2e105d3F7209A9DA11f83cCf3E7398a753823F1" as Address,
  universalRouter: "0x1B341FDD55d56F8E08409A2C25DDFad93Eb03C1a" as Address,
  permit2: "0x000000000022D473030F116dDEE9F6B43aC78BA3" as Address,
};

/** ELO's canonical pool: HYPE/ELO, 1%, tick spacing 200, Eloscape's hook (read from ELO.hook()). */
export async function eloPoolKey(pub: PublicClient) {
  const hook = await pub.readContract({ address: ELOSCAPE.elo, abi: parseAbi(["function hook() view returns (address)"]), functionName: "hook" });
  return { currency0: HYPE, currency1: ELOSCAPE.elo, fee: 10_000, tickSpacing: 200, hooks: hook };
}

const KEY = [{ type: "address" }, { type: "address" }, { type: "uint24" }, { type: "int24" }, { type: "address" }] as const;

function poolId(k: Awaited<ReturnType<typeof eloPoolKey>>): Hex {
  return keccak256(encodeAbiParameters(KEY as never, [k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks] as never));
}

/**
 * HYPE that `eloIn` is worth at the pool's current price (before fees), from the pool's slot0 in Uniswap's
 * PoolManager (extsload of _pools[id], slot 6).
 */
export async function quoteEloToHype(pub: PublicClient, eloIn: bigint): Promise<bigint> {
  const k = await eloPoolKey(pub);
  const slot = keccak256(encodeAbiParameters([{ type: "bytes32" }, { type: "uint256" }], [poolId(k), 6n]));
  const word = await pub.readContract({ address: UNISWAP.poolManager, abi: parseAbi(["function extsload(bytes32) view returns (bytes32)"]), functionName: "extsload", args: [slot] });
  const sqrtP = BigInt(word) & ((1n << 160n) - 1n);
  if (sqrtP === 0n) throw new Error("ELO's pool isn't initialized.");
  // price = (sqrtP / 2^96)^2 = ELO per HYPE; HYPE out = ELO in / price
  return (eloIn << 192n) / (sqrtP * sqrtP);
}

/** Slippage allowed below the pool price: the pool's 1%, the hook's fee (~3%), and room for the price to move. */
export const ELO_SWAP_MAX_LOSS_BPS = 1_000n;

/**
 * ELO pays for its own swap: the gas of claiming it, the two approvals, the swap and the payment to the relay comes out
 * of the HYPE the swap fetches, so the relay never pays for ELO. These are the gas estimates used to decide whether a
 * seat's ELO is worth swapping; the payment itself uses the swap steps' real receipts.
 */
export const ELO_GAS = { claim: 80_000n, approve: 60_000n, permit: 60_000n, swap: 260_000n, pay: 70_000n };
const ELO_GAS_TOTAL = Object.values(ELO_GAS).reduce((a, b) => a + b, 0n);
/** What the pool and Eloscape's hook keep on a swap (1% + about 3%), with a little room. */
const SWAP_FEES_BPS = 450n;
/** Swap only when the HYPE out is at least this many times the gas: room for the price and gas to move. */
const ELO_WORTH_MARGIN_BPS = 15_000n;
/** Never touch less than this (a dust floor, whatever gas costs). */
export const ELO_MIN_SWAP = 100_000_000_000_000n; // 0.0001 ELO

/** Is `elo` worth swapping now, paying its own gas? HYPE it should fetch (after pool fees) and the gas it costs. */
export async function eloSwapWorth(pub: PublicClient, elo: bigint): Promise<{ worth: boolean; out: bigint; cost: bigint }> {
  if (elo < ELO_MIN_SWAP) return { worth: false, out: 0n, cost: 0n };
  const [fair, gasPrice] = await Promise.all([quoteEloToHype(pub, elo), pub.getGasPrice()]);
  const out = (fair * (10_000n - SWAP_FEES_BPS)) / 10_000n;
  const cost = gasPrice * ELO_GAS_TOTAL;
  return { worth: out * 10_000n >= cost * ELO_WORTH_MARGIN_BPS, out, cost };
}

/** The smallest ELO worth swapping at today's price and gas (for the page's note). */
export async function eloSwapFloor(pub: PublicClient): Promise<bigint> {
  const one = 10n ** 18n;
  const [fair, gasPrice] = await Promise.all([quoteEloToHype(pub, one), pub.getGasPrice()]);
  const perElo = (fair * (10_000n - SWAP_FEES_BPS)) / 10_000n;
  if (perElo === 0n) return 0n;
  const need = (gasPrice * ELO_GAS_TOTAL * ELO_WORTH_MARGIN_BPS) / 10_000n;
  const floor = (need * one + perElo - 1n) / perElo;
  return floor > ELO_MIN_SWAP ? floor : ELO_MIN_SWAP;
}

/**
 * Swap all the ELO the seat holds (already claimed) to HYPE in ELO's pool, into the seat. Three seat calls: approve
 * Permit2, Permit2 approve for the Universal Router, the swap. Returns the ELO swapped (0 if below ELO_MIN_SWAP).
 */
export async function swapHeldElo(core: GloamCore, seat: Seat, onStatus: Status = () => {}): Promise<{ eloIn: bigint; txs: Hex[] }> {
  const pub = core.config.publicClient as PublicClient;
  const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const eloIn = await pub.readContract({ address: ELOSCAPE.elo, abi: ERC20, functionName: "balanceOf", args: [seat.account] });
  if (eloIn < ELO_MIN_SWAP) return { eloIn: 0n, txs: [] };
  const fair = await quoteEloToHype(pub, eloIn);
  const minOut = (fair * (10_000n - ELO_SWAP_MAX_LOSS_BPS)) / 10_000n;
  onStatus("Approving the ELO swap");
  const txs: Hex[] = [];
  txs.push(await seatCall(core, seat, { target: ELOSCAPE.elo, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [UNISWAP.permit2, eloIn] }) }));
  txs.push(await seatCall(core, seat, {
    target: UNISWAP.permit2,
    data: encodeFunctionData({
      abi: parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]),
      functionName: "approve",
      args: [ELOSCAPE.elo, UNISWAP.universalRouter, eloIn, Math.floor(Date.now() / 1000) + 1800],
    }),
  }));
  const k = await eloPoolKey(pub);
  const swap = encodeAbiParameters(
    [{ type: "tuple", components: [{ type: "tuple", components: KEY as never }, { type: "bool" }, { type: "uint128" }, { type: "uint128" }, { type: "bytes" }] }] as never,
    [[[k.currency0, k.currency1, k.fee, k.tickSpacing, k.hooks], false, eloIn, minOut, "0x"]] as never,
  );
  const settleAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [ELOSCAPE.elo, eloIn]);
  const takeAll = encodeAbiParameters([{ type: "address" }, { type: "uint256" }], [HYPE, minOut]);
  // V4_SWAP (0x10): SWAP_EXACT_IN_SINGLE (0x06), SETTLE_ALL (0x0c), TAKE_ALL (0x0f)
  const input = encodeAbiParameters([{ type: "bytes" }, { type: "bytes[]" }], ["0x060c0f", [swap, settleAll, takeAll]]);
  onStatus("Swapping ELO to HYPE");
  txs.push(await seatCall(core, seat, {
    target: UNISWAP.universalRouter,
    data: encodeFunctionData({ abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]), functionName: "execute", args: ["0x10", [input], BigInt(Math.floor(Date.now() / 1000) + 600)] }),
  }));
  return { eloIn, txs };
}

/**
 * The seat pays the relay back for its ELO steps: the real gas of `txs` (approvals and swap, from their receipts), plus
 * the estimated share of the claim and of this payment. Sent from the seat's HYPE to the relay that sent `claimTx`.
 * The relay is shared by every user, so the payment links the seat to no one. Returns the HYPE paid (0 if nothing).
 */
export async function payEloGas(core: GloamCore, seat: Seat, claimTx: Hex, txs: Hex[]): Promise<bigint> {
  const pub = core.config.publicClient as PublicClient;
  if (!txs.length) return 0n;
  const [relayTx, receipts, gasPrice] = await Promise.all([
    pub.getTransaction({ hash: claimTx }),
    Promise.all(txs.map((hash) => pub.waitForTransactionReceipt({ hash }))),
    pub.getGasPrice(),
  ]);
  const spent = receipts.reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n);
  const fee = spent + (ELO_GAS.claim + ELO_GAS.pay) * gasPrice;
  await seatCall(core, seat, { target: relayTx.from, value: fee, data: "0x" });
  return fee;
}

/** Claim the seat's ELO, swap it to HYPE, and return everything the seat holds to the private balance. */
export async function swapSeatEloToHype(core: GloamCore, seat: Seat, onStatus: Status = () => {}, viaReceive?: () => Promise<ReceiveRoute>): Promise<{ eloIn: bigint; txs: Hex[] }> {
  onStatus("Claiming ELO");
  await seatCall(core, seat, { target: ELOSCAPE.game, data: claimEloCall() }).catch(() => null);
  const { eloIn } = await swapHeldElo(core, seat, onStatus);
  if (eloIn === 0n) throw new Error("This seat has too little ELO to swap.");
  onStatus("Returning the HYPE to your private balance");
  return { eloIn, txs: await returnSeat(core, seat, onStatus, viaReceive) };
}
