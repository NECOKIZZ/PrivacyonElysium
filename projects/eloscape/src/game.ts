import { encodeFunctionData, hexToBigInt, parseAbi, toFunctionSelector, type Address, type Hex, type PublicClient } from "viem";
import { ELOSCAPE } from "./config.js";

/** The parts of Eloscape's ElysiumCanonicalGame this integration uses (from its verified source). */
export const GAME_ABI = parseAbi([
  "function deploy(uint8[] blockIds) payable",
  "function setConfigFixed(uint256 blockMask, uint256 amountPerBlock) payable",
  "function setConfigRandom(uint8 phase, uint8 width, uint256 amountPerBlock) payable",
  "function stopConfig()",
  "function claimETH()",
  "function claimELO()",
  "function claimAll(uint64[] roundIds, bool withElo)",
  "function checkpoint(uint64 roundId)",
  "function claimStanding(uint64 toRound)",
  "function currentRoundId() view returns (uint64)",
  "function getCurrentRound() view returns (uint64 id, uint256 startTime, uint256 endTime, uint256 totalDeployed, uint256 minerCount, uint256 secondsRemaining)",
  "function getRoundDeployed(uint64 roundId) view returns (uint256[25])",
  "function roundTotals(uint64 roundId) view returns (uint256 localWeight, uint256 externalWeight, uint8 winningBlock, bool settled)",
  "function getMiner(uint64 roundId, address user) view returns ((uint256 deployedMask, uint256 amountPerBlock, bool checkpointed))",
  "function standing(address user) view returns (bool active, bool isRandom, uint256 mask, uint8 phase, uint8 width, uint8 numBlocks, uint256 amountPerBlock, uint256 perRoundSpend, uint256 balance, uint64 startRound, uint64 endRound, uint64 lastClaimedRound)",
  "function userUnclaimedETH(address user) view returns (uint256)",
  "function userUnclaimedELO(address user) view returns (uint256)",
  "function settlementTime(uint64 roundId) view returns (uint256)",
  "function onRandomnessSettled(uint64 rid, uint8 winningBlock, uint256 entropy)",
  "event Deployed(uint64 indexed roundId, address indexed user, uint256 amountPerBlock, uint256 blockMask, uint256 totalAmount)",
]);

export const GRID = 25;
export const MIN_DEPLOY = 2_500_000_000_000n; // 0.0000025 HYPE per block
export const ROUND_SECONDS = 60;
export const INTERMISSION_SECONDS = 12;

export const deployCall = (blocks: number[]): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "deploy", args: [blocks] });
export const autoFixedCall = (blocks: number[], perBlock: bigint): Hex =>
  encodeFunctionData({ abi: GAME_ABI, functionName: "setConfigFixed", args: [maskOf(blocks), perBlock] });
export const autoRandomCall = (phase: number, width: number, perBlock: bigint): Hex =>
  encodeFunctionData({ abi: GAME_ABI, functionName: "setConfigRandom", args: [phase, width, perBlock] });

/** Widths Eloscape accepts for random Auto: a window of this many blocks, moved by the round's seed every round. */
export const RANDOM_WIDTHS = [1, 3, 5, 9, 13] as const;

/** Eloscape's own block strategies (its app's presets), on the 0-24 grid read row by row. */
export const STRATEGIES = ["all", "cross", "odd", "even", "plus"] as const;
export type Strategy = (typeof STRATEGIES)[number];
export function strategyBlocks(s: Strategy): number[] {
  const out: number[] = [];
  for (let n = 0; n < GRID; n++) {
    const row = Math.floor(n / 5);
    const col = n % 5;
    const on =
      s === "all" ||
      (s === "cross" && (row === col || row + col === 4)) ||
      (s === "odd" && n % 2 === 0) || // blocks 1, 3, 5, … as numbered on the grid
      (s === "even" && n % 2 === 1) ||
      (s === "plus" && (row === 2 || col === 2));
    if (on) out.push(n);
  }
  return out;
}
/** Which strategy a selection is, or "custom" (or null when empty), as Eloscape's app labels it. */
export function strategyOf(blocks: number[]): Strategy | "custom" | null {
  if (!blocks.length) return null;
  const key = [...blocks].sort((a, b) => a - b).join(",");
  for (const s of STRATEGIES) if (strategyBlocks(s).join(",") === key) return s;
  return "custom";
}
/** `count` random blocks. */
export function randomBlocks(count: number): number[] {
  const all = Array.from({ length: GRID }, (_, i) => i);
  for (let i = all.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [all[i], all[j]] = [all[j], all[i]];
  }
  return all.slice(0, Math.max(1, Math.min(GRID, count))).sort((a, b) => a - b);
}

export const stopAutoCall = (): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "stopConfig" });
export const claimEthCall = (): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "claimETH" });
/** HYPE winnings and refunds, and (withElo) ELO, in one call; it also checkpoints the seat's last round. */
export const claimAllCall = (withElo: boolean): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "claimAll", args: [[], withElo] });
export const claimEloCall = (): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "claimELO" });

export function maskOf(blocks: number[]): bigint {
  let m = 0n;
  for (const b of blocks) {
    if (!Number.isInteger(b) || b < 0 || b >= GRID) throw new Error(`block ${b} is not on the 5x5 grid`);
    m |= 1n << BigInt(b);
  }
  return m;
}

export interface LiveRound {
  id: bigint;
  startTime: number;
  endTime: number;
  totalDeployed: bigint;
  minerCount: bigint;
  deployed: readonly bigint[];
}

export async function liveRound(pub: PublicClient, game: Address = ELOSCAPE.game): Promise<LiveRound> {
  const [id, startTime, endTime, totalDeployed, minerCount] = await pub.readContract({ address: game, abi: GAME_ABI, functionName: "getCurrentRound" });
  const deployed = await pub.readContract({ address: game, abi: GAME_ABI, functionName: "getRoundDeployed", args: [id] });
  return { id, startTime: Number(startTime), endTime: Number(endTime), totalDeployed, minerCount, deployed };
}

/** What an address can collect from the game now: HYPE (winnings and refunds, credited or not), its own balance, ELO credited so far, and its Auto. */
export async function owed(pub: PublicClient, who: Address, game: Address = ELOSCAPE.game) {
  const [after, held, elo, auto] = await Promise.all([
    collectableHype(pub, who, game),
    pub.getBalance({ address: who }),
    collectableElo(pub, who, game),
    pub.readContract({ address: game, abi: GAME_ABI, functionName: "standing", args: [who] }),
  ]);
  // hype: what claimETH would pay now (credited or not); held: already in the address
  return { hype: after > held ? after - held : 0n, held, elo, autoActive: auto[0], autoBalance: auto[8], autoEndRound: auto[10] };
}

/**
 * What `who` would hold right after claimETH(): its balance plus every HYPE the game owes it, including rounds the
 * game hasn't credited yet (userUnclaimedETH only moves when a player is checkpointed, and claimETH checkpoints).
 * Read with eth_call and a throwaway probe in place of `who`'s code: it calls claimETH, then returns its balance.
 * Nothing is sent.
 */
export async function collectableHype(pub: PublicClient, who: Address, game: Address = ELOSCAPE.game): Promise<bigint> {
  const sel = toFunctionSelector("claimETH()").slice(2);
  const g = game.slice(2).toLowerCase();
  // calldata empty: accept HYPE (the game's payout). Otherwise: call game.claimETH(), ignore the result, return selfbalance.
  const code = ("0x" + "3615" + "603b" + "57" + "63" + sel + "60e01b" + "600052" + "6000600060046000600073" + g + "5af150" + "47600052" + "60206000f3" + "5b00") as Hex;
  const r = await pub.call({ to: who, data: "0x01", stateOverride: [{ address: who, code }] });
  return r.data && r.data !== "0x" ? hexToBigInt(r.data) : 0n;
}

/**
 * ELO `who` would hold right after claimELO(): what it holds plus what the game owes it, credited or not (net of the
 * game's realizing fee). Same read-only probe as collectableHype: calls claimELO, then returns ELO.balanceOf(itself).
 */
export async function collectableElo(pub: PublicClient, who: Address, game: Address = ELOSCAPE.game, elo: Address = ELOSCAPE.elo): Promise<bigint> {
  const claim = toFunctionSelector("claimELO()").slice(2);
  const bal = toFunctionSelector("balanceOf(address)").slice(2);
  const g = game.slice(2).toLowerCase();
  const e = elo.slice(2).toLowerCase();
  const code = ("0x" + "3615" + "6066" + "57" + "63" + claim + "60e01b" + "600052" + "6000600060046000600073" + g + "5af150" +
    "63" + bal + "60e01b" + "600052" + "30600452" + "6020600060246000" + "73" + e + "5afa50" + "60206000f3" + "5b00") as Hex;
  const r = await pub.call({ to: who, data: "0x01", stateOverride: [{ address: who, code }] });
  return r.data && r.data !== "0x" ? hexToBigInt(r.data) : 0n;
}
