/**
 * The three ways to play Eloscape privately, on top of seats (seat.ts):
 *
 *  Phase 1  Private Play / Private Auto  hides WHO plays: a fresh seat plays, funded from Gloam's vault.
 *  Phase 2  Sealed Play                  hides WHICH BLOCK until ~6 s before the round closes: the seat is funded
 *                                        early, and its signed deploy is held on the player's device and only sent
 *                                        at the last moment. Nothing on chain says which block before then.
 *  Phase 3A Split Play                   hides HOW MUCH: the stake goes in as standard sizes, each from its own seat,
 *                                        at slightly different moments.
 */
import type { Address, Hex, PublicClient } from "viem";
import type { GloamCore } from "@cloakely/sdk";
import { ELOSCAPE } from "./config.js";
import { GRID, MIN_DEPLOY, autoFixedCall, claimAllCall, deployCall, liveRound, owed, stopAutoCall } from "./game.js";
import { ELO_MIN_SWAP, swapHeldElo } from "./elo.js";
import { openSeat, returnSeat, seatCall, sendSeatCall, signSeatCall, type ReceiveRoute, type Seat, type SignedSeatCall, type Status } from "./seat.js";

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DAY = 86_400n;

export interface SeatOptions {
  /**
   * Where the seat's funds go if the player never returns them (after `exitAfterDays`). It's part of the seat's key,
   * which every call from the seat carries in the clear: NEVER the player's wallet. Use a fresh receive address of the
   * player's private account (GloamPrivate.receiveAddress), which collects back into the private balance.
   */
  fallbackTo: Address | (() => Promise<Address>);
  exitAfterDays?: number;
  /** Called as soon as each seat is opened (its note has left the vault), before it plays: save it right away. */
  onSeat?: (seat: Seat) => void;
}

const seatParams = async (o: SeatOptions, amount: bigint, exclude?: Set<bigint>) => ({
  amount,
  fallbackTo: typeof o.fallbackTo === "function" ? await o.fallbackTo() : o.fallbackTo,
  exitAfter: BigInt(Math.floor(Date.now() / 1000)) + BigInt(o.exitAfterDays ?? 7) * DAY,
  game: ELOSCAPE.game,
  exclude,
});

/** The deploy value: what reached the seat, rounded down to equal parts per block (the game splits it equally). */
export function playValue(arrived: bigint, blocks: number[]): bigint {
  const n = BigInt(blocks.length);
  if (n === 0n) throw new Error("Pick at least one block.");
  const v = arrived - (arrived % n);
  if (v / n < MIN_DEPLOY) throw new Error("Too little per block: Eloscape's minimum is 0.0000025 HYPE per block.");
  return v;
}

/**
 * Wait until a round is open with at least `minLeft` seconds to go (by the chain's clock). Eloscape refuses deploys
 * between a round's close and the next round's start, so a play sent then would revert (the HYPE stays in the seat).
 */
export async function waitOpenRound(pub: PublicClient, minLeft: number, onStatus: Status = () => {}) {
  for (let said = false; ; ) {
    const r = await liveRound(pub);
    const now = Number((await pub.getBlock()).timestamp);
    if (now >= r.startTime && r.endTime - now >= minLeft) return r;
    if (!said) (onStatus("Waiting for the next round to open"), (said = true));
    await sleep(1000);
  }
}

/** Seconds a plain play needs left in the round: room for the relay to send it. */
export const PLAY_MIN_LEFT = 5;
/** Eloscape's own app stops Auto setups 20 s before close; this does the same. */
export const AUTO_MIN_LEFT = 20;

/**
 * Send a seat's deploy into the next open round, and if it doesn't make it (the round closed while the relay was
 * sending: the relay simulates first, so nothing is spent), wait for the following round and send it again.
 */
async function deployInOpenRound(core: GloamCore, seat: Seat, blocks: number[], onStatus: Status): Promise<{ tx: Hex; roundId: bigint }> {
  const pub = core.config.publicClient as PublicClient;
  for (let attempt = 0; ; attempt++) {
    const r = await waitOpenRound(pub, PLAY_MIN_LEFT, onStatus);
    try {
      const tx = await seatCall(core, seat, { target: ELOSCAPE.game, value: playValue(seat.arrived, blocks), data: deployCall(blocks) });
      return { tx, roundId: r.id };
    } catch (e) {
      const now = await liveRound(pub);
      const closed = now.id !== r.id || Number((await pub.getBlock()).timestamp) >= now.endTime;
      if (!closed || attempt >= 2) throw e;
      onStatus("That round closed first; playing in the next one");
    }
  }
}

async function waitFunded(core: GloamCore, seat: Seat): Promise<void> {
  const pub = core.config.publicClient as PublicClient;
  for (let i = 0; i < 120; i++) {
    if ((await pub.getBalance({ address: seat.account })) >= seat.arrived) return;
    await sleep(1000);
  }
  throw new Error("The seat wasn't funded in time.");
}

// ── Phase 1 ─────────────────────────────────────────────────────────────────

/** Private Play: one manual play this round, from a fresh seat. */
export async function privatePlay(core: GloamCore, p: { amount: bigint; blocks: number[] } & SeatOptions, onStatus: Status = () => {}) {
  const seat = await openSeat(core, await seatParams(p, p.amount), onStatus);
  p.onSeat?.(seat);
  await waitFunded(core, seat);
  onStatus("Playing from the seat");
  const { tx, roundId } = await deployInOpenRound(core, seat, p.blocks, onStatus);
  return { seat, tx, roundId };
}

/**
 * Private Auto: one note funds an Auto position on a fresh seat, which plays `perBlock` on each of `blocks` every
 * round until its balance runs out (Eloscape's own Auto, unchanged). Stop and collect with collect().
 */
export async function privateAuto(core: GloamCore, p: { amount: bigint; blocks: number[]; perBlock: bigint } & SeatOptions, onStatus: Status = () => {}) {
  if (p.perBlock < MIN_DEPLOY) throw new Error("Too little per block: Eloscape's minimum is 0.0000025 HYPE per block.");
  const seat = await openSeat(core, await seatParams(p, p.amount), onStatus);
  p.onSeat?.(seat);
  await waitFunded(core, seat);
  const perRound = p.perBlock * BigInt(p.blocks.length);
  const rounds = seat.arrived / perRound;
  if (rounds < 1n) throw new Error("The amount doesn't cover one round at this size.");
  await waitOpenRound(core.config.publicClient as PublicClient, AUTO_MIN_LEFT, onStatus);
  onStatus(`Starting Auto for ${rounds} rounds`);
  const tx = await seatCall(core, seat, { target: ELOSCAPE.game, value: rounds * perRound, data: autoFixedCall(p.blocks, p.perBlock) });
  return { seat, tx, rounds };
}

/**
 * Collect a seat: stop its Auto if it runs, claim what the game owes it (HYPE, and ELO when swapping) in one call,
 * swap its ELO to HYPE when asked (and worth it), and put everything back into the private balance in one return.
 * Without swapElo, ELO stays credited to the seat for Send ELO later.
 */
export async function collect(
  core: GloamCore,
  seat: Seat,
  onStatus: Status = () => {},
  viaReceive?: () => Promise<ReceiveRoute>,
  opts: { swapElo?: boolean } = {},
): Promise<{ txs: Hex[]; eloSwapped: bigint }> {
  const pub = core.config.publicClient as PublicClient;
  const txs: Hex[] = [];
  const o = await owed(pub, seat.account);
  if (o.autoActive) {
    onStatus("Stopping Auto");
    txs.push(await seatCall(core, seat, { target: ELOSCAPE.game, data: stopAutoCall() }));
  }
  const swap = !!opts.swapElo && o.elo >= ELO_MIN_SWAP;
  const after = o.autoActive ? await owed(pub, seat.account) : o;
  if (after.hype > 0n || swap) {
    onStatus(swap ? "Claiming winnings and ELO" : "Claiming winnings");
    txs.push(await seatCall(core, seat, { target: ELOSCAPE.game, data: claimAllCall(swap) }));
  }
  const eloSwapped = swap ? await swapHeldElo(core, seat, onStatus) : 0n;
  txs.push(...(await returnSeat(core, seat, onStatus, viaReceive)));
  return { txs, eloSwapped };
}

// ── Phase 2 ─────────────────────────────────────────────────────────────────

/** How many seconds before the round's close a sealed play is sent. */
export const SEAL_LEAD_SECONDS = 6;
/** Extra seconds before close for each additional sealed piece (Split Play), so every piece lands in time. */
export const PIECE_SPACING_SECONDS = 2;

async function chainNow(pub: PublicClient): Promise<number> {
  return Number((await pub.getBlock()).timestamp);
}

/**
 * Sealed Play. Seats are funded first (that reveals nothing about the block), the deploys are signed and kept on this
 * device, and they're sent together SEAL_LEAD_SECONDS before the round closes. Until then nobody can see the choice:
 * not other players, not the relay, not Eloscape. If the moment is missed the play simply doesn't happen; the HYPE
 * stays in the seat for the next round or goes back with collect().
 *
 * Takes already-opened seats, so Split Play can seal several pieces at once.
 */
export async function sealAndSend(
  core: GloamCore,
  seats: Seat[],
  blocks: number[],
  opts: { leadSeconds?: number; jitterSeconds?: number; onSealed?: (calls: SignedSeatCall[], sendAt: number, roundId: bigint) => void } = {},
  onStatus: Status = () => {},
): Promise<{ roundId: bigint; txs: Hex[] }> {
  const pub = core.config.publicClient as PublicClient;
  for (const s of seats) await waitFunded(core, s);
  const signed = await Promise.all(seats.map((s) => signSeatCall(core, s, { target: ELOSCAPE.game, value: playValue(s.arrived, blocks), data: deployCall(blocks) })));
  let r = await liveRound(pub);
  const lead = opts.leadSeconds ?? SEAL_LEAD_SECONDS;
  // too close to this round's close to make it: aim at the next one
  const needed = lead + (opts.jitterSeconds ?? PIECE_SPACING_SECONDS) * (seats.length - 1) + 2;
  if (r.endTime - (await chainNow(pub)) < needed) {
    onStatus("Waiting for the next round");
    const id = r.id;
    while ((r = await liveRound(pub)).id === id || (await chainNow(pub)) < r.startTime) await sleep(1000);
  }
  // several pieces go one after another (each waits for the relay), so the first starts early enough for all of them
  // to land: SEAL_LEAD_SECONDS before close for one, PIECE_SPACING_SECONDS more for each extra piece
  const spacing = opts.jitterSeconds ?? PIECE_SPACING_SECONDS;
  const sendAt = r.endTime - lead - spacing * (signed.length - 1);
  opts.onSealed?.(signed, sendAt, r.id);
  onStatus(`Sealed. Sending ${r.endTime - sendAt}s before round ${r.id} closes. Keep this tab open.`);
  const txs: Hex[] = [];
  for (let i = 0; i < signed.length; i++) {
    const at = sendAt + i * spacing;
    while ((await chainNow(pub)) < at) await sleep(250);
    if ((await chainNow(pub)) > r.endTime - 2) {
      // too late to land in this round: the rest stays in its seats, safe, for Collect or a later play
      onStatus(`Round ${r.id} closed before ${signed.length - i} of ${signed.length} pieces were sent; they're still in your seats.`);
      break;
    }
    txs.push(await sendSeatCall(core, signed[i]));
  }
  return { roundId: r.id, txs };
}

export async function sealedPlay(core: GloamCore, p: { amount: bigint; blocks: number[] } & SeatOptions, onStatus: Status = () => {}) {
  const seat = await openSeat(core, await seatParams(p, p.amount), onStatus);
  p.onSeat?.(seat);
  const sent = await sealAndSend(core, [seat], p.blocks, {}, onStatus);
  return { seats: [seat], ...sent };
}

// ── Phase 3A ────────────────────────────────────────────────────────────────

/** Standard sizes, in HYPE. Every private piece is one of these, so a piece says little about the stake behind it. */
export const STANDARD_SIZES = ["10", "5", "2", "1", "0.5", "0.2", "0.1", "0.05", "0.02", "0.01", "0.005", "0.002", "0.001"].map((x) => BigInt(Math.round(Number(x) * 1e6)) * 10n ** 12n);

/** The standard pieces a stake splits into (largest first); what's below the smallest size stays private. */
export function splitSizes(amount: bigint): { pieces: bigint[]; left: bigint } {
  const pieces: bigint[] = [];
  let left = amount;
  for (const s of STANDARD_SIZES) while (left >= s) (pieces.push(s), (left -= s));
  return { pieces, left };
}

/**
 * Split Play: the stake as standard pieces, each from its own seat, all on the same blocks. With `sealed`, the pieces
 * go in during the last seconds, spread over a few seconds; without, they go in now, a few seconds apart.
 */
export async function splitPlay(
  core: GloamCore,
  p: { amount: bigint; blocks: number[]; sealed?: boolean } & SeatOptions,
  onStatus: Status = () => {},
) {
  const { pieces } = splitSizes(p.amount);
  if (!pieces.length) throw new Error("The stake is below the smallest standard size (0.001 HYPE).");
  const seats: Seat[] = [];
  const used = new Set<bigint>();
  for (let i = 0; i < pieces.length; i++) {
    onStatus(`Piece ${i + 1} of ${pieces.length}`);
    const seat = await openSeat(core, await seatParams(p, pieces[i], used), onStatus);
    p.onSeat?.(seat);
    seats.push(seat);
  }
  if (p.sealed) return { seats, ...(await sealAndSend(core, seats, p.blocks, {}, onStatus)) };
  const txs: Hex[] = [];
  for (const s of seats) {
    await waitFunded(core, s);
    txs.push((await deployInOpenRound(core, s, p.blocks, onStatus)).tx);
    await sleep(1500 + Math.floor(Math.random() * 2500));
  }
  return { seats, txs };
}

export { GRID };
