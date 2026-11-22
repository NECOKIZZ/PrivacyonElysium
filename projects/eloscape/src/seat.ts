/**
 * A "seat": a one-time account that plays Eloscape for one private player.
 *
 * It's Cloak's live escrow for one-time accounts (CloakGloamBids on Elysium mainnet) used exactly as its code allows,
 * with nothing new deployed:
 *   1. open:   one private note leaves Gloam's vault, by its own zero-knowledge proof, straight to the seat's address.
 *              That address is fixed in advance from everything about the seat (note, owner key, fallback, timeout),
 *              so the proof can't be redirected.
 *   2. play:   the seat's owner key (a one-time key the player's device derives from its private account and the note)
 *              signs each call the seat makes: deploy, Auto, claims. Cloak's relay sends it. Eloscape sees a fresh
 *              address playing, never the player's wallet.
 *   3. return: the seat's HYPE goes back into Gloam's vault as new private notes of the player (finish), signed by the
 *              same key. If the player never comes back, anyone can push the seat's funds to its fallback address
 *              once its timeout passes, so nothing can be stuck.
 */
import { encodeFunctionData, parseAbi, type Address, type Hex, type PublicClient } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { CLOAK_GLOAM_BIDS_ABI, gloamFinishBid, type GloamBidKey, type GloamBidRecord, type GloamCore } from "@cloakely/sdk";
import { HYPE, PRIVACY, ELOSCAPE } from "./config.js";

const VAULT_ABI = parseAbi([
  "function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)",
  "function withdrawFeeBps() view returns (uint16)",
  "function isSpent(bytes32 nullifier) view returns (bool)",
  "function depositLimit(address asset) view returns (uint128 perDeposit, uint128 total)",
]);
// eslint-disable-next-line @typescript-eslint/no-explicit-any
const BIDS = CLOAK_GLOAM_BIDS_ABI as any;
const ERC20 = parseAbi(["function transfer(address to, uint256 amount) returns (bool)", "function balanceOf(address) view returns (uint256)"]);

export type Status = (s: string) => void;

export interface Seat extends GloamBidRecord {
  /** HYPE that left the vault (the note) and what reached the seat after Gloam's 0.5% exit fee. */
  amount: bigint;
  arrived: bigint;
  openedAt: number;
}

/** What a note of `amount` brings out of Gloam's vault: less its withdrawal fee, rounded as the vault rounds. */
export function arrivedOf(amount: bigint, feeBps: bigint): bigint {
  return amount - ((amount / 10_000n) * feeBps + ((amount % 10_000n) * feeBps) / 10_000n);
}

export async function exitFeeBps(pub: PublicClient): Promise<bigint> {
  return BigInt(await pub.readContract({ address: PRIVACY.gloamVault, abi: VAULT_ABI, functionName: "withdrawFeeBps" }));
}

/**
 * Move exactly `amount` of private HYPE into a new seat. One relayed transaction: the vault's unshield to the seat's
 * address. Nothing on chain links the seat to the player.
 */
export async function openSeat(
  core: GloamCore,
  p: { amount: bigint; fallbackTo: Address; exitAfter: bigint; game?: Address; exclude?: Set<bigint> },
  onStatus: Status = () => {},
): Promise<Seat> {
  const pub = core.config.publicClient as PublicClient;
  onStatus("Choosing a private note");
  const note = await core.exactNote(HYPE, p.amount, onStatus, p.exclude);
  p.exclude?.add(note.commitment); // a later seat in the same batch never picks this note again
  const nullifier = `0x${note.nullifier.toString(16).padStart(64, "0")}` as Hex;
  const ownerKey = privateKeyToAccount(core.exitKeyFor(nullifier)).address;
  const key: GloamBidKey = { nullifier, amount: p.amount, auction: p.game ?? ELOSCAPE.game, ownerKey, fallbackTo: p.fallbackTo, exitAfter: p.exitAfter };
  const account = (await pub.readContract({ address: PRIVACY.bids, abi: BIDS, functionName: "accountFor", args: [key] })) as Address;
  const s = await core.spendProof(note, account, onStatus);
  onStatus("Moving it to a fresh seat");
  const txHash = await core.config.submit({
    kind: "unshield",
    to: PRIVACY.gloamVault,
    data: encodeFunctionData({ abi: VAULT_ABI, functionName: "unshield", args: [s.proof, s.root, s.nullifier, s.asset, account, s.amount] }),
  });
  const arrived = arrivedOf(p.amount, await exitFeeBps(pub));
  return { bids: PRIVACY.bids, key, account, tick: 0, quantity: 0n, salt: "0x", txHash, amount: p.amount, arrived, openedAt: Math.floor(Date.now() / 1000) };
}

export interface SignedSeatCall {
  seat: Address;
  target: Address;
  value: bigint;
  data: Hex;
  nonce: bigint;
  /** The full CloakGloamBids.ownerCall transaction data: anyone holding it can send it, nobody can change it. */
  tx: Hex;
}

/**
 * Sign one call from the seat, without sending it. `nonce` is the seat's call count when this call will land (the
 * escrow checks it), so a play can be signed now and sent later: Sealed Play sends it a few seconds before close.
 */
export async function signSeatCall(
  core: GloamCore,
  seat: Seat,
  call: { target: Address; value?: bigint; data: Hex },
  nonce?: bigint,
): Promise<SignedSeatCall> {
  const pub = core.config.publicClient as PublicClient;
  const n = nonce ?? ((await pub.readContract({ address: seat.bids, abi: BIDS, functionName: "callNonce", args: [seat.account] })) as bigint);
  const value = call.value ?? 0n;
  const digest = (await pub.readContract({ address: seat.bids, abi: BIDS, functionName: "callDigest", args: [seat.account, call.target, value, call.data, n] })) as Hex;
  const signature = await privateKeyToAccount(core.exitKeyFor(seat.key.nullifier)).sign({ hash: digest });
  const tx = encodeFunctionData({ abi: BIDS, functionName: "ownerCall", args: [seat.key, call.target, value, call.data, signature] });
  return { seat: seat.account, target: call.target, value, data: call.data, nonce: n, tx };
}

export function sendSeatCall(core: GloamCore, signed: SignedSeatCall): Promise<Hex> {
  return core.config.submit({ kind: "escrow", to: PRIVACY.bids, data: signed.tx });
}

export async function seatCall(core: GloamCore, seat: Seat, call: { target: Address; value?: bigint; data: Hex }): Promise<Hex> {
  return sendSeatCall(core, await signSeatCall(core, seat, call));
}

/** Has the seat's note left the vault (its unshield landed)? Calls from the seat need that first. */
export async function seatFunded(pub: PublicClient, seat: Seat): Promise<boolean> {
  return pub.readContract({ address: PRIVACY.gloamVault, abi: VAULT_ABI, functionName: "isSpent", args: [seat.key.nullifier] });
}

/** Put all the seat's HYPE back into Gloam's vault as new private notes of the player (several if over the cap). */
export async function returnSeat(core: GloamCore, seat: Seat, onStatus: Status = () => {}): Promise<Hex[]> {
  const pub = core.config.publicClient as PublicClient;
  const bal = await pub.getBalance({ address: seat.account });
  if (bal === 0n) return [];
  return gloamFinishBid(core, seat, [{ asset: HYPE, amount: bal }], onStatus);
}

/** Send the seat's ELO to an address of the player's choice (ELO can't go into Gloam's vault). */
export async function sendSeatElo(core: GloamCore, seat: Seat, to: Address, elo: Address = ELOSCAPE.elo): Promise<Hex | null> {
  const pub = core.config.publicClient as PublicClient;
  // ELO the game still owes the seat is claimed into it first (claimELO), then sent on
  await seatCall(core, seat, { target: ELOSCAPE.game, data: encodeFunctionData({ abi: parseAbi(["function claimELO()"]), functionName: "claimELO" }) }).catch(() => null);
  const bal = await pub.readContract({ address: elo, abi: ERC20, functionName: "balanceOf", args: [seat.account] });
  if (bal === 0n) return null;
  return seatCall(core, seat, { target: elo, data: encodeFunctionData({ abi: ERC20, functionName: "transfer", args: [to, bal] }) });
}
