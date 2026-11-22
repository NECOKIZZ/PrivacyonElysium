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

/** Below this, a seat's ELO isn't worth swapping (pool and hook fees on a few cents); it stays in the seat. */
export const ELO_MIN_SWAP = 20_000_000_000_000_000n; // 0.02 ELO

/**
 * Swap all the ELO the seat holds (already claimed) to HYPE in ELO's pool, into the seat. Three seat calls: approve
 * Permit2, Permit2 approve for the Universal Router, the swap. Returns the ELO swapped (0 if below ELO_MIN_SWAP).
 */
export async function swapHeldElo(core: GloamCore, seat: Seat, onStatus: Status = () => {}): Promise<bigint> {
  const pub = core.config.publicClient as PublicClient;
  const ERC20 = parseAbi(["function approve(address,uint256) returns (bool)", "function balanceOf(address) view returns (uint256)"]);
  const eloIn = await pub.readContract({ address: ELOSCAPE.elo, abi: ERC20, functionName: "balanceOf", args: [seat.account] });
  if (eloIn < ELO_MIN_SWAP) return 0n;
  const fair = await quoteEloToHype(pub, eloIn);
  const minOut = (fair * (10_000n - ELO_SWAP_MAX_LOSS_BPS)) / 10_000n;
  onStatus("Approving the ELO swap");
  await seatCall(core, seat, { target: ELOSCAPE.elo, data: encodeFunctionData({ abi: ERC20, functionName: "approve", args: [UNISWAP.permit2, eloIn] }) });
  await seatCall(core, seat, {
    target: UNISWAP.permit2,
    data: encodeFunctionData({
      abi: parseAbi(["function approve(address token, address spender, uint160 amount, uint48 expiration)"]),
      functionName: "approve",
      args: [ELOSCAPE.elo, UNISWAP.universalRouter, eloIn, Math.floor(Date.now() / 1000) + 1800],
    }),
  });
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
  await seatCall(core, seat, {
    target: UNISWAP.universalRouter,
    data: encodeFunctionData({ abi: parseAbi(["function execute(bytes commands, bytes[] inputs, uint256 deadline) payable"]), functionName: "execute", args: ["0x10", [input], BigInt(Math.floor(Date.now() / 1000) + 600)] }),
  });
  return eloIn;
}

/** Claim the seat's ELO, swap it to HYPE, and return everything the seat holds to the private balance. */
export async function swapSeatEloToHype(core: GloamCore, seat: Seat, onStatus: Status = () => {}, viaReceive?: () => Promise<ReceiveRoute>): Promise<{ eloIn: bigint; txs: Hex[] }> {
  onStatus("Claiming ELO");
  await seatCall(core, seat, { target: ELOSCAPE.game, data: claimEloCall() }).catch(() => null);
  const eloIn = await swapHeldElo(core, seat, onStatus);
  if (eloIn === 0n) throw new Error("This seat has too little ELO to swap.");
  onStatus("Returning the HYPE to your private balance");
  return { eloIn, txs: await returnSeat(core, seat, onStatus, viaReceive) };
}
