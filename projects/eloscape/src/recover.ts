/**
 * Seats a new device can find again from the chain alone, with nothing saved.
 *
 * A seat's address is fixed by its key: the note's nullifier and amount, the app it plays (`auction`), the owner key,
 * the fallback address and the timeout. The owner key always comes back from the private account. The other two used
 * to be chosen on the device (a counter, a clock), so a new device couldn't rebuild them. Now:
 *  - the fallback is a receive address whose index is derived from the nullifier (`fallbackIndex`);
 *  - the timeout is the opening day (UTC) plus one of a few fixed lengths (`SEAT_DAYS`), up to two years.
 *
 * To recover, the private account lists the notes it has spent; Gloam's vault logs every unshield with the
 * nullifier and the address it paid (`UNSHIELD_TOPIC`), so each spent note that opened a seat names that seat and
 * its block. Trying the few possible keys (apps × lengths × the day around that block) until one gives exactly that
 * address proves it is the player's seat. Seats opened before this scheme still need the device's records or a backup.
 */
import { getAddress, pad, type Address, type Hex, type PublicClient } from "viem";
import { CLOAK_GLOAM_BIDS_ABI, type GloamBidKey, type GloamCore } from "@cloakely/sdk";
import { privateKeyToAccount } from "viem/accounts";
import { HYPE, PRIVACY } from "./config.js";
import { arrivedOf, exitFeeBps, type Seat, type Status } from "./seat.js";

/** How long a seat can live, in days: a week, a month, 3 and 6 months, a year, two years. */
export const SEAT_DAYS = [7, 30, 90, 180, 365, 730] as const;
export type SeatDays = (typeof SEAT_DAYS)[number];
const DAY = 86_400n;

/** A seat's timeout: the start of today (UTC) plus `days`. Only the lengths in SEAT_DAYS, so it can be found again. */
export function exitAfterFor(days: number, nowSecs: number = Math.floor(Date.now() / 1000)): bigint {
  if (!(SEAT_DAYS as readonly number[]).includes(days)) throw new Error(`A seat lasts one of ${SEAT_DAYS.join(", ")} days.`);
  return (BigInt(nowSecs) / DAY) * DAY + BigInt(days) * DAY;
}

/** The receive-address index of a seat's fallback, derived from its note: far above the old counter's range. */
export const FALLBACK_BASE = 10_000_000;
export function fallbackIndex(nullifier: Hex): number {
  return FALLBACK_BASE + Number(BigInt(nullifier) % 1_000_000_000n);
}

/** Gloam's vault: Unshield(bytes32 indexed nullifier, address indexed asset, address indexed to, uint256 amount). */
export const UNSHIELD_TOPIC = "0x30b76ac0da56cfe7d189cac50fddb8605587482a710e09bbf79ef47e5ef8c300" as Hex;

export interface FoundSeat extends Seat {
  /** The app the seat was opened for (its key's `auction`). */
  label: Address;
  /** The block that funded it. */
  openedBlock: bigint;
}

const h32 = (n: bigint) => `0x${n.toString(16).padStart(64, "0")}` as Hex;
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BIDS = CLOAK_GLOAM_BIDS_ABI as any;

/**
 * Every seat this private account opened under the recoverable scheme, for the given apps, found from the chain.
 * `receiveAddress` is the account's receive address n (GloamPrivate.receiveAddress).
 */
export async function recoverSeats(
  core: GloamCore,
  p: { labels: Address[]; receiveAddress: (n: number) => Promise<Address>; logChunk?: bigint; onStatus?: Status },
): Promise<FoundSeat[]> {
  const pub = core.config.publicClient as PublicClient;
  const say = p.onStatus ?? (() => {});
  say("Looking for your seats on chain");
  await core.sync();
  const spent = core.spentNoteList(HYPE);
  if (!spent.length) return [];
  const byNullifier = new Map(spent.map((n) => [h32(n.nullifier).toLowerCase(), n]));

  // which of these notes left the vault, to which address, in which block
  const head = await pub.getBlockNumber();
  const chunk = p.logChunk ?? 5_000_000n;
  const hits: { nullifier: Hex; to: Address; block: bigint }[] = [];
  const ids = [...byNullifier.keys()] as Hex[];
  for (let i = 0; i < ids.length; i += 40) {
    const some = ids.slice(i, i + 40);
    for (let from = PRIVACY.gloamVaultBlock; from <= head; from += chunk) {
      const to = from + chunk - 1n > head ? head : from + chunk - 1n;
      const logs = await pub.request({
        method: "eth_getLogs",
        params: [{ address: PRIVACY.gloamVault, topics: [UNSHIELD_TOPIC, some], fromBlock: `0x${from.toString(16)}`, toBlock: `0x${to.toString(16)}` }],
      } as never) as { topics: Hex[]; blockNumber: Hex }[];
      for (const l of logs) hits.push({ nullifier: l.topics[1], to: getAddress(`0x${l.topics[3].slice(26)}`), block: BigInt(l.blockNumber) });
    }
  }
  if (!hits.length) return [];

  // the opening day comes from the funding block; try the day before and after too (a device clock can be off)
  const blocks = [...new Set(hits.map((h) => h.block))];
  const times = new Map<bigint, bigint>();
  await Promise.all(blocks.map(async (b) => times.set(b, (await pub.getBlock({ blockNumber: b })).timestamp)));

  const feeBps = await exitFeeBps(pub);
  const found: FoundSeat[] = [];
  for (const h of hits) {
    const note = byNullifier.get(h.nullifier.toLowerCase())!;
    const ownerKey = privateKeyToAccount(core.exitKeyFor(h.nullifier)).address;
    const fallbackTo = await p.receiveAddress(fallbackIndex(h.nullifier));
    const day = (times.get(h.block)! / DAY) * DAY;
    const keys: GloamBidKey[] = [];
    for (const label of p.labels)
      for (const days of SEAT_DAYS)
        for (const d of [day - DAY, day, day + DAY]) keys.push({ nullifier: h.nullifier, amount: note.amount, auction: label, ownerKey, fallbackTo, exitAfter: d + BigInt(days) * DAY });
    const accounts = (await pub.multicall({
      contracts: keys.map((k) => ({ address: PRIVACY.bids, abi: BIDS, functionName: "accountFor", args: [k] })),
      allowFailure: true,
    })) as { result?: Address }[];
    const i = accounts.findIndex((a) => a.result?.toLowerCase() === h.to.toLowerCase());
    if (i < 0) continue; // a note spent some other way, or a seat from before this scheme
    const key = keys[i];
    found.push({
      bids: PRIVACY.bids,
      key,
      account: h.to,
      tick: 0,
      quantity: 0n,
      salt: "0x",
      txHash: pad("0x0", { size: 32 }),
      amount: note.amount,
      arrived: arrivedOf(note.amount, feeBps),
      openedAt: Number(times.get(h.block)),
      label: key.auction,
      openedBlock: h.block,
    });
  }
  say(found.length ? `Found ${found.length} seat${found.length === 1 ? "" : "s"} on chain` : "");
  return found;
}

/** Days left before anyone may push what's left in a seat to its fallback (negative once it has passed). */
export function seatDaysLeft(seat: Pick<Seat, "key">, nowSecs: number = Math.floor(Date.now() / 1000)): number {
  return Math.floor((Number(seat.key.exitAfter) - nowSecs) / 86_400);
}
