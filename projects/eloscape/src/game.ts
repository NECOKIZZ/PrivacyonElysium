import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { ELOSCAPE } from "./config.js";

/** The parts of Eloscape's ElysiumCanonicalGame this integration uses (from its verified source). */
export const GAME_ABI = parseAbi([
  "function deploy(uint8[] blockIds) payable",
  "function setConfigFixed(uint256 blockMask, uint256 amountPerBlock) payable",
  "function setConfigRandom(uint8 phase, uint8 width, uint256 amountPerBlock) payable",
  "function stopConfig()",
  "function claimETH()",
  "function claimELO()",
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
export const stopAutoCall = (): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "stopConfig" });
export const claimEthCall = (): Hex => encodeFunctionData({ abi: GAME_ABI, functionName: "claimETH" });
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

/** What an address can collect from the game now (HYPE winnings and refunds, and unclaimed ELO). */
export async function owed(pub: PublicClient, who: Address, game: Address = ELOSCAPE.game) {
  const [hype, elo, auto] = await Promise.all([
    pub.readContract({ address: game, abi: GAME_ABI, functionName: "userUnclaimedETH", args: [who] }),
    pub.readContract({ address: game, abi: GAME_ABI, functionName: "userUnclaimedELO", args: [who] }),
    pub.readContract({ address: game, abi: GAME_ABI, functionName: "standing", args: [who] }),
  ]);
  return { hype, elo, autoActive: auto[0], autoBalance: auto[8], autoEndRound: auto[10] };
}
