/**
 * Private launches and private holding on Montra (montramarkets.xyz), Elysium's Uniswap v4 launchpad.
 *
 * Every Montra call here is made by a seat: a one-time account of Cloak's escrow (CloakGloamBids), funded from the
 * player's private balance in Gloam's vault and driven by an owner key only the player's device can derive. Cloak's
 * relay sends the transactions, so the player's wallet never appears.
 *
 *  - A **mine** is the seat that launches a token. Montra makes the caller the creator, so the mine is the creator and
 *    (unless the fees go elsewhere) the fee recipient. Its creator fees are claimed into the private balance.
 *  - A **holding** is a seat that buys a Montra token and holds it. It earns Montra's holder rewards like any holder,
 *    claims them into the private balance, and sells back into it.
 *
 * Gas rule: what pays out pays its own way. A fee claim or a reward claim sends the relay the claim's gas (from the
 * transactions' receipts, plus estimates for the payment and the deposit) out of what it claimed, and runs only when
 * what it would claim covers that at least 1.5 times. Launches and trades are sent like Eloscape plays.
 *
 * Contracts and ABIs are Montra's own (montramarkets.xyz/docs/abis.json, build in abis.json): every address is read
 * from Montra's registry, as Montra's docs ask. Checked on a fork of Elysium mainnet (test/montra.fork.ts).
 */
import { decodeEventLog, encodeFunctionData, parseAbi, stringToHex, toHex, zeroAddress, type Abi, type Address, type Hex, type PublicClient } from "viem";
import type { GloamCore } from "@cloakely/sdk";
import { HYPE, PRIVACY, exitAfterFor, grossFor, openSeat, seatCall, returnSeat, type FoundSeat, type ReceiveRoute, type Seat, type SeatDays, type Status } from "@privacy-for-elysium/eloscape";
import abis from "./abis.json";

const C = abis.contracts as unknown as Record<string, Abi>;
export const ABI = {
  registry: C.LaunchpadRegistry,
  factory: C.LaunchFactory,
  hook: C.LaunchHook,
  token: C.LaunchToken,
  lens: C.LaunchLens,
  router: C.LaunchRouter,
  splitter: C.FeeSplitter,
};

/** Montra's registry on Elysium mainnet: the one address an integration hard-codes (Montra's docs, Contracts). */
export const MONTRA_REGISTRY = "0xF1E2FA75422F889e565F3142bdbf60B28dce2aa7" as Address;
/** In a fee route, address one names the token's holders (Montra's `HOLDERS`). */
export const HOLDERS = "0x0000000000000000000000000000000000000001" as Address;
/** Our Montra Builders code, put on every launch as an ERC-8021 suffix. */
export const BUILDER_CODE = "cloak";
/**
 * How long a mine or a holding seat lives by default before anyone may push what it holds to its fallback (a receive
 * address of the private account). The creator or holder picks from SEAT_DAYS, up to two years.
 */
export const MINE_DAYS: SeatDays = 365;
export const HOLDING_DAYS: SeatDays = 180;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
/** A trade's deadline from the chain's own clock (a device clock can be off), ten minutes ahead. */
const deadline = async (pub: PublicClient) => (await pub.getBlock()).timestamp + 600n;

/**
 * ERC-8021 attribution for Montra Builders: the code's ASCII, its length in one byte, schema 0, then the 16-byte
 * marker, appended after the factory call's calldata (montramarkets.xyz/docs/builders). Inside a seat's call it sits
 * in the escrow's calldata, which Montra's indexer still finds.
 */
export function builderSuffix(code: string = BUILDER_CODE): Hex {
  if (!/^[a-z0-9][a-z0-9-]{2,31}$/.test(code)) throw new Error("Builder codes are 3 to 32 of a-z, 0-9 and dashes.");
  const ascii = Array.from(code, (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
  return `0x${ascii}${code.length.toString(16).padStart(2, "0")}00${"8021".repeat(8)}` as Hex;
}

// ── addresses and reads ──────────────────────────────────────────────────────────────────────────────────────────

export interface MontraAddresses {
  factory: Address;
  router: Address;
  lens: Address;
  poolManager: Address;
}

const cache = new Map<string, Promise<MontraAddresses>>();
/** Montra's addresses, read from its registry (once per client). */
export function montraAddresses(pub: PublicClient, registry: Address = MONTRA_REGISTRY): Promise<MontraAddresses> {
  const k = `${registry}`;
  if (!cache.has(k)) {
    const get = (name: string) => pub.readContract({ address: registry, abi: ABI.registry, functionName: "get", args: [stringToHex(name, { size: 32 })] }) as Promise<Address>;
    const p = Promise.all([get("factory"), get("router"), get("lens"), get("poolManager")]).then(([factory, router, lens, poolManager]) => {
      if ([factory, router, lens].some((a) => !a || a === zeroAddress)) throw new Error("Montra's registry didn't name its contracts.");
      return { factory, router, lens, poolManager };
    });
    p.catch(() => cache.delete(k));
    cache.set(k, p);
  }
  return cache.get(k)!;
}

export interface LaunchRow {
  id: bigint;
  quote: Address;
  totalFeePips: number;
  earlyBuyFeeWindow: number;
  moduleSetId: bigint;
}

/** The factory's menu: rows that launch now and pair with native HYPE (the only quote this product offers). */
export async function launchRows(pub: PublicClient): Promise<LaunchRow[]> {
  const { factory } = await montraAddresses(pub);
  const n = (await pub.readContract({ address: factory, abi: ABI.factory, functionName: "configCount" })) as bigint;
  // in small multicalls: the whole menu in one is too big an answer for the public RPC
  const rows: Record<string, unknown>[] = [];
  for (let i = 0; i < Number(n); i += 6) {
    const ids = Array.from({ length: Math.min(6, Number(n) - i) }, (_, k) => BigInt(i + k));
    const got = await pub.multicall({ contracts: ids.map((id) => ({ address: factory, abi: ABI.factory, functionName: "getConfig", args: [id] }) as const), allowFailure: false });
    rows.push(...(got as unknown as Record<string, unknown>[]));
  }
  return rows
    .map((r, i) => ({ id: BigInt(i), quote: r.quote as Address, totalFeePips: Number(r.totalFeePips), earlyBuyFeeWindow: Number(r.earlyBuyFeeWindow), moduleSetId: r.moduleSetId as bigint, enabled: r.enabled as boolean }))
    .filter((r) => r.enabled && r.quote.toLowerCase() === HYPE)
    .map(({ enabled: _, ...r }) => r);
}

export interface PoolKey {
  currency0: Address;
  currency1: Address;
  fee: number;
  tickSpacing: number;
  hooks: Address;
}

export interface TokenInfo {
  token: Address;
  poolId: Hex;
  hook: Address;
  key: PoolKey;
  symbol: string;
  name: string;
}

/** A Montra token's pool, read from the token and its hook. */
export async function tokenInfo(pub: PublicClient, token: Address): Promise<TokenInfo> {
  const [poolId, hook, symbol, name] = await Promise.all([
    pub.readContract({ address: token, abi: ABI.token, functionName: "poolId" }) as Promise<Hex>,
    pub.readContract({ address: token, abi: ABI.token, functionName: "hook" }) as Promise<Address>,
    pub.readContract({ address: token, abi: ABI.token, functionName: "symbol" }) as Promise<string>,
    pub.readContract({ address: token, abi: ABI.token, functionName: "name" }) as Promise<string>,
  ]);
  const key = (await pub.readContract({ address: hook, abi: ABI.hook, functionName: "poolKey", args: [poolId] })) as PoolKey;
  if (key.currency0 !== HYPE) throw new Error("Only HYPE-paired Montra tokens are supported.");
  return { token, poolId, hook, key, symbol, name };
}

/** Tokens out for `hypeIn` (a buy) or HYPE out for `tokenIn` (a sale), as Montra's router quotes them. */
export async function quote(pub: PublicClient, info: TokenInfo, buy: boolean, amountIn: bigint): Promise<bigint> {
  const { router } = await montraAddresses(pub);
  const r = await pub.simulateContract({ address: router, abi: ABI.router, functionName: "quoteExactIn", args: [info.key, buy, amountIn] });
  return r.result as bigint;
}

// ── seats ───────────────────────────────────────────────────────────────────────────────────────────────────────

export interface SeatPlan {
  /** The seat's fallback: a receive address of the private account derived from the note (never the wallet). */
  fallbackTo: (nullifier: Hex) => Promise<Address>;
  /** Called once the seat exists: save it at once. */
  onSeat?: (seat: Seat) => void;
}

async function waitFunded(pub: PublicClient, seat: Seat, atLeast: bigint): Promise<void> {
  for (let i = 0; i < 180; i++) {
    if ((await pub.getBalance({ address: seat.account })) >= atLeast) return;
    await sleep(1000);
  }
  throw new Error("The seat wasn't funded in time.");
}

/**
 * Open a seat holding `net` HYPE, funded in standard pieces when `pieces` lists them (each piece's own note leaves
 * the vault to the same seat, so the seat's total doesn't match any one note). The first piece opens the seat.
 */
export async function openFundedSeat(core: GloamCore, net: bigint, plan: SeatPlan, days: number, label: Address, pieces?: bigint[], onStatus: Status = () => {}): Promise<Seat> {
  const pub = core.config.publicClient as PublicClient;
  const parts = pieces?.length ? pieces : [net];
  const exclude = new Set<bigint>();
  const seat = await openSeat(core, { amount: grossFor(parts[0]), fallbackTo: plan.fallbackTo, exitAfter: exitAfterFor(days), game: label, exclude }, onStatus);
  plan.onSeat?.(seat);
  await addPieces(core, seat.account, parts.slice(1), exclude, onStatus, 2);
  await waitFunded(pub, seat, parts.reduce((a, b) => a + b, 0n));
  return seat;
}

/** Unshield more pieces straight into an address the account already owns (a seat): each arrives as its net amount. */
async function addPieces(core: GloamCore, to: Address, parts: bigint[], exclude: Set<bigint>, onStatus: Status, first = 1): Promise<void> {
  const total = parts.length + first - 1;
  for (let i = 0; i < parts.length; i++) {
    onStatus(total > 1 ? `Adding piece ${first + i} of ${total}` : "Moving HYPE from your private balance");
    const note = await core.exactNote(HYPE, grossFor(parts[i]), onStatus, exclude);
    exclude.add(note.commitment);
    const s = await core.spendProof(note, to, onStatus);
    await core.config.submit({
      kind: "unshield",
      to: PRIVACY.gloamVault,
      data: encodeFunctionData({ abi: VAULT_UNSHIELD, functionName: "unshield", args: [s.proof, s.root, s.nullifier, s.asset, to, s.amount] }),
    });
  }
}

/**
 * Buy more of a token into a seat you already have (a holding, or a mine buying more of its own token), paid from the
 * private balance. The new HYPE goes to the same address, so on chain it reads as that address buying again: it
 * links the buys to each other, never to the wallet. Recovery isn't affected (the seat is found by its first note).
 */
export async function buyMore(core: GloamCore, seat: Seat, token: Address, net: bigint, opts: { pieces?: bigint[]; maxSlippageBps?: number } = {}, onStatus: Status = () => {}): Promise<{ spent: bigint; bought: bigint }> {
  const pub = core.config.publicClient as PublicClient;
  if (seatDaysLeftOf(seat) < 1) throw new Error("This seat is at its end date: buy from a fresh one instead.");
  const info = await tokenInfo(pub, token);
  const { router } = await montraAddresses(pub);
  const parts = opts.pieces?.length ? opts.pieces : [net];
  const before = await pub.getBalance({ address: seat.account });
  const held = (await pub.readContract({ address: token, abi: ABI.token, functionName: "balanceOf", args: [seat.account] })) as bigint;
  await addPieces(core, seat.account, parts, new Set(), onStatus);
  await waitFunded(pub, seat, before + net);
  const out = await quote(pub, info, true, net);
  const minOut = (out * BigInt(10_000 - (opts.maxSlippageBps ?? 1_000))) / 10_000n;
  onStatus(`Buying more ${info.symbol} from the same address`);
  await seatCall(core, seat, {
    target: router,
    value: net,
    data: encodeFunctionData({ abi: ABI.router, functionName: "swapExactIn", args: [{ key: info.key, zeroForOne: true, amountIn: net, minAmountOut: minOut, recipient: seat.account, deadline: await deadline(pub) }] }),
  });
  const now = (await pub.readContract({ address: token, abi: ABI.token, functionName: "balanceOf", args: [seat.account] })) as bigint;
  return { spent: net, bought: now - held };
}
const seatDaysLeftOf = (seat: Seat) => (Number(seat.key.exitAfter) - Date.now() / 1000) / 86_400;

const VAULT_UNSHIELD = parseAbi(["function unshield(bytes proof, bytes32 root, bytes32 nullifier, address asset, address to, uint256 amount)"]);

// ── launching ───────────────────────────────────────────────────────────────────────────────────────────────────

export interface LaunchInput {
  name: string;
  symbol: string;
  metadataURI?: string;
  logo?: string;
  description?: string;
  socials?: { telegram?: string; twitter?: string; discord?: string; website?: string };
  configId: bigint;
  /** HYPE the mine buys at launch (0 for none). */
  devBuy: bigint;
  /** Where the creator side of the fee goes, in basis points summing to 10,000: the mine (private), the holders, us. */
  split: { creator: number; holders: number; builder?: { to: Address; bps: number } };
  /** Fund the mine in these standard pieces (summing to devBuy + launch fee) to hide the amount. */
  pieces?: bigint[];
  /** How long the mine lives (default a year, at most two). */
  days?: SeatDays;
}

export interface Mine {
  seat: Seat;
  token: Address;
  poolId: Hex;
  hook: Address;
  /** The fee recipient: the mine itself, the token (holders only), or a splitter. */
  recipient: Address;
  splitter?: Address;
  symbol: string;
  name: string;
  launchTx: Hex;
}

/** feeRecipients/feeShares for a split: none for the mine alone, one for a single route, two to four for a splitter. */
export function feeRoute(mine: Address, s: LaunchInput["split"]): { recipients: Address[]; shares: number[] } {
  const parts: [Address, number][] = [];
  if (s.creator > 0) parts.push([mine, s.creator]);
  if (s.holders > 0) parts.push([HOLDERS, s.holders]);
  if (s.builder && s.builder.bps > 0) {
    if (s.builder.bps > 2_000) throw new Error("Montra allows our own slot at most 20% of the creator side.");
    parts.push([s.builder.to, s.builder.bps]);
  }
  if (parts.reduce((a, [, b]) => a + b, 0) !== 10_000) throw new Error("The fee split must add up to 100%.");
  if (parts.length === 1 && parts[0][0] === mine) return { recipients: [], shares: [] };
  return { recipients: parts.map(([a]) => a), shares: parts.map(([, b]) => b) };
}

/** The factory's launch calldata, with our builder code appended. */
export function launchCalldata(mine: Address, p: LaunchInput, salt: Hex, code: string = BUILDER_CODE): Hex {
  const route = feeRoute(mine, p.split);
  const data = encodeFunctionData({
    abi: ABI.factory,
    functionName: "launch",
    args: [
      {
        name: p.name,
        symbol: p.symbol,
        metadataURI: p.metadataURI ?? "",
        profile: {
          logo: p.logo ?? "",
          description: p.description ?? "",
          socials: { telegram: p.socials?.telegram ?? "", twitter: p.socials?.twitter ?? "", discord: p.socials?.discord ?? "", website: p.socials?.website ?? "", extra: "" },
        },
        configId: p.configId,
        supply: 0n,
        salt,
        feeRecipients: route.recipients,
        feeShares: route.shares,
        firstBuyAmount: p.devBuy,
        firstBuyMinOut: 0n,
        permit: { deadline: 0n, v: 0, r: `0x${"0".repeat(64)}`, s: `0x${"0".repeat(64)}` },
      },
    ],
  });
  return (data + builderSuffix(code).slice(2)) as Hex;
}

/**
 * Launch a token from a fresh mine seat. The seat is funded with the dev buy plus Montra's launch fee (in pieces if
 * asked), then calls the factory: the mine becomes the token's creator and, for the creator slot, its fee recipient.
 */
export async function launchFromMine(core: GloamCore, p: LaunchInput, plan: SeatPlan, onStatus: Status = () => {}): Promise<Mine> {
  const pub = core.config.publicClient as PublicClient;
  const { factory } = await montraAddresses(pub);
  const fee = (await pub.readContract({ address: factory, abi: ABI.factory, functionName: "launchFee" })) as bigint;
  const value = p.devBuy + fee;
  if (value === 0n) throw new Error("Fund the mine with at least a small dev buy: the seat needs a note to open from.");
  if (p.pieces?.length && p.pieces.reduce((a, b) => a + b, 0n) !== value) throw new Error("The pieces must add up to the dev buy plus the launch fee.");
  const seat = await openFundedSeat(core, value, plan, p.days ?? MINE_DAYS, factory, p.pieces, onStatus);
  const salt = toHex(crypto.getRandomValues(new Uint8Array(32)));
  onStatus("Launching from your mine");
  const launchTx = await seatCall(core, seat, { target: factory, value, data: launchCalldata(seat.account, p, salt) });
  const rc = await pub.waitForTransactionReceipt({ hash: launchTx });
  let launched: Record<string, unknown> | undefined;
  let splitter: Address | undefined;
  for (const l of rc.logs) {
    try {
      const e = decodeEventLog({ abi: ABI.factory, data: l.data, topics: l.topics });
      const args = e.args as unknown as Record<string, unknown>;
      if (e.eventName === "TokenLaunched") launched = args;
      if (e.eventName === "FeeSplitterDeployed") splitter = args.splitter as Address;
    } catch {}
  }
  if (!launched) throw new Error("The launch didn't go through.");
  const token = launched.token as Address;
  const info = await tokenInfo(pub, token);
  return { seat, token, poolId: info.poolId, hook: info.hook, recipient: launched.feeRecipient as Address, splitter, symbol: p.symbol, name: p.name, launchTx };
}

// ── paying out: the claim pays its own gas ──────────────────────────────────────────────────────────────────────

/** Gas estimates for the parts of a payout we can't read from a receipt before sending them. */
export const PAYOUT_GAS = { pay: 70_000n, forward: 60_000n, deposit: 450_000n };
const WORTH_BPS = 15_000n;

/** The gas a payout costs at today's price, with the claim's own gas estimated at `claimGas`. */
export async function payoutCost(pub: PublicClient, claimGas: bigint): Promise<bigint> {
  const gp = await pub.getGasPrice();
  return gp * (claimGas + PAYOUT_GAS.pay + PAYOUT_GAS.forward + PAYOUT_GAS.deposit);
}

/** Is `amount` worth paying out now? It must cover its own gas 1.5 times. */
export async function worthPaying(pub: PublicClient, amount: bigint, claimGas: bigint): Promise<{ worth: boolean; cost: bigint }> {
  const cost = await payoutCost(pub, claimGas);
  return { worth: amount * 10_000n >= cost * WORTH_BPS, cost };
}

/**
 * After claiming into the seat: pay the relay the claim's real gas plus the estimated payment, forward and deposit,
 * forward the rest to a fresh receive address and sweep it into the private balance. Returns what reached it.
 */
async function settlePayout(core: GloamCore, seat: Seat, claimTxs: Hex[], viaReceive: () => Promise<ReceiveRoute>, onStatus: Status): Promise<{ paid: bigint; gas: bigint }> {
  const pub = core.config.publicClient as PublicClient;
  const [relayTx, receipts, gp] = await Promise.all([
    pub.getTransaction({ hash: claimTxs[0] }),
    Promise.all(claimTxs.map((hash) => pub.waitForTransactionReceipt({ hash }))),
    pub.getGasPrice(),
  ]);
  const gas = receipts.reduce((a, r) => a + r.gasUsed * r.effectiveGasPrice, 0n) + gp * (PAYOUT_GAS.pay + PAYOUT_GAS.forward + PAYOUT_GAS.deposit);
  const bal = await pub.getBalance({ address: seat.account });
  if (bal <= gas) throw new Error("What was claimed doesn't cover its own gas yet.");
  onStatus("Paying the claim's gas from what it claimed");
  await seatCall(core, seat, { target: relayTx.from, value: gas, data: "0x" });
  const route = await viaReceive();
  const rest = bal - gas;
  onStatus("Moving it to a fresh receive address of your private account");
  await seatCall(core, seat, { target: route.address, value: rest, data: "0x" });
  onStatus("Sweeping it into your private balance");
  await route.collect();
  return { paid: rest, gas };
}

/** What the mine's creator fees come to now (its share of a split included). */
export async function mineOwed(pub: PublicClient, mine: Pick<Mine, "seat" | "hook" | "poolId" | "recipient" | "splitter">): Promise<bigint> {
  const { lens } = await montraAddresses(pub);
  const pool = (await pub.readContract({ address: lens, abi: ABI.lens, functionName: "creatorClaimable", args: [mine.hook, mine.poolId] })) as bigint;
  if (mine.recipient.toLowerCase() === mine.seat.account.toLowerCase()) return pool;
  if (!mine.splitter) return 0n;
  const [owed, recipients, shares] = await Promise.all([
    pub.readContract({ address: mine.splitter, abi: ABI.splitter, functionName: "owed", args: [mine.seat.account] }) as Promise<bigint>,
    pub.readContract({ address: mine.splitter, abi: ABI.splitter, functionName: "recipients" }) as Promise<Address[]>,
    pub.readContract({ address: mine.splitter, abi: ABI.splitter, functionName: "shares" }) as Promise<readonly number[]>,
  ]);
  const i = recipients.findIndex((a) => a.toLowerCase() === mine.seat.account.toLowerCase());
  return owed + (i < 0 ? 0n : (pool * BigInt(shares[i])) / 10_000n);
}

const MINE_CLAIM_GAS = 220_000n;

/** Claim the mine's creator fees into the private balance, paying their own gas. Refuses amounts not worth it yet. */
export async function claimMineFees(core: GloamCore, mine: Mine, viaReceive: () => Promise<ReceiveRoute>, onStatus: Status = () => {}): Promise<{ paid: bigint; gas: bigint }> {
  const pub = core.config.publicClient as PublicClient;
  const owed = await mineOwed(pub, mine);
  const w = await worthPaying(pub, owed, MINE_CLAIM_GAS);
  if (!w.worth) throw new Error("Not worth claiming yet: the fees don't cover their own gas.");
  const txs: Hex[] = [];
  onStatus("Claiming your creator fees");
  if (mine.recipient.toLowerCase() === mine.seat.account.toLowerCase()) {
    txs.push(await seatCall(core, seat(mine), { target: mine.hook, data: encodeFunctionData({ abi: ABI.hook, functionName: "claim", args: [mine.poolId, mine.seat.account] }) }));
  } else if (mine.splitter) {
    txs.push(await seatCall(core, seat(mine), { target: mine.splitter, data: encodeFunctionData({ abi: ABI.splitter, functionName: "distribute" }) }));
    const due = (await pub.readContract({ address: mine.splitter, abi: ABI.splitter, functionName: "owed", args: [mine.seat.account] })) as bigint;
    txs.push(await seatCall(core, seat(mine), { target: mine.splitter, data: encodeFunctionData({ abi: ABI.splitter, functionName: "collect", args: [mine.seat.account, due] }) }));
  } else throw new Error("This mine's fees go to the holders: there is nothing for it to claim.");
  return settlePayout(core, mine.seat, txs, viaReceive, onStatus);
}
const seat = (m: Mine) => m.seat;

// ── holding privately ───────────────────────────────────────────────────────────────────────────────────────────

export interface Holding {
  seat: Seat;
  token: Address;
  symbol: string;
  name: string;
  /** HYPE that went into the buy. */
  spent: bigint;
}

/** Buy `net` HYPE of a Montra token from a fresh seat (in pieces if asked); the seat holds what it bought. */
export async function buyPrivately(core: GloamCore, token: Address, net: bigint, plan: SeatPlan, opts: { pieces?: bigint[]; maxSlippageBps?: number; days?: SeatDays } = {}, onStatus: Status = () => {}): Promise<Holding> {
  const pub = core.config.publicClient as PublicClient;
  const info = await tokenInfo(pub, token);
  const { router } = await montraAddresses(pub);
  const s = await openFundedSeat(core, net, plan, opts.days ?? HOLDING_DAYS, router, opts.pieces, onStatus);
  const out = await quote(pub, info, true, net);
  const minOut = (out * BigInt(10_000 - (opts.maxSlippageBps ?? 1_000))) / 10_000n;
  onStatus(`Buying ${info.symbol} from the seat`);
  await seatCall(core, s, {
    target: router,
    value: net,
    data: encodeFunctionData({ abi: ABI.router, functionName: "swapExactIn", args: [{ key: info.key, zeroForOne: true, amountIn: net, minAmountOut: minOut, recipient: s.account, deadline: await deadline(pub) }] }),
  });
  return { seat: s, token, symbol: info.symbol, name: info.name, spent: net };
}

/** A holding's tokens and the rewards it has earned. */
export async function holdingView(pub: PublicClient, h: Pick<Holding, "seat" | "token">): Promise<{ balance: bigint; earned: bigint }> {
  const [balance, earned] = await Promise.all([
    pub.readContract({ address: h.token, abi: ABI.token, functionName: "balanceOf", args: [h.seat.account] }) as Promise<bigint>,
    pub.readContract({ address: h.token, abi: ABI.token, functionName: "earned", args: [h.seat.account] }) as Promise<bigint>,
  ]);
  return { balance, earned };
}

const REWARD_CLAIM_GAS = 120_000n;

/** Claim a holding's rewards into the private balance, paying their own gas. Refuses amounts not worth it yet. */
export async function claimHoldingRewards(core: GloamCore, h: Holding, viaReceive: () => Promise<ReceiveRoute>, onStatus: Status = () => {}): Promise<{ paid: bigint; gas: bigint }> {
  const pub = core.config.publicClient as PublicClient;
  const { earned } = await holdingView(pub, h);
  const w = await worthPaying(pub, earned, REWARD_CLAIM_GAS);
  if (!w.worth) throw new Error("Not worth claiming yet: the rewards don't cover their own gas.");
  onStatus(`Claiming ${h.symbol} holder rewards`);
  const tx = await seatCall(core, h.seat, { target: h.token, data: encodeFunctionData({ abi: ABI.token, functionName: "claimRewards", args: [h.seat.account] }) });
  return settlePayout(core, h.seat, [tx], viaReceive, onStatus);
}

/**
 * Sell everything a holding holds and bring the HYPE (rewards included) back into the private balance. The seat
 * claims its rewards, approves Montra's router, sells, and returns.
 */
export async function sellPrivately(core: GloamCore, h: Holding, viaReceive: () => Promise<ReceiveRoute>, opts: { maxSlippageBps?: number } = {}, onStatus: Status = () => {}): Promise<{ hypeOut: bigint; txs: Hex[] }> {
  const pub = core.config.publicClient as PublicClient;
  const info = await tokenInfo(pub, h.token);
  const { router } = await montraAddresses(pub);
  const { balance, earned } = await holdingView(pub, h);
  if (earned > 0n) {
    onStatus("Claiming its rewards first");
    await seatCall(core, h.seat, { target: h.token, data: encodeFunctionData({ abi: ABI.token, functionName: "claimRewards", args: [h.seat.account] }) });
  }
  let hypeOut = 0n;
  if (balance > 0n) {
    const out = await quote(pub, info, false, balance);
    const minOut = (out * BigInt(10_000 - (opts.maxSlippageBps ?? 1_000))) / 10_000n;
    onStatus(`Selling ${info.symbol}`);
    await seatCall(core, h.seat, { target: h.token, data: encodeFunctionData({ abi: ABI.token, functionName: "approve", args: [router, balance] }) });
    await seatCall(core, h.seat, {
      target: router,
      data: encodeFunctionData({ abi: ABI.router, functionName: "swapExactIn", args: [{ key: info.key, zeroForOne: false, amountIn: balance, minAmountOut: minOut, recipient: h.seat.account, deadline: await deadline(pub) }] }),
    });
    hypeOut = out;
  }
  onStatus("Returning the HYPE to your private balance");
  const txs = await returnSeat(core, h.seat, onStatus, viaReceive);
  return { hypeOut, txs };
}

// ── recovery ────────────────────────────────────────────────────────────────────────────────────────────────────

/** The apps Montra seats are opened for (their keys' `auction`): mines name the factory, holdings the router. */
export async function montraSeatLabels(pub: PublicClient): Promise<Address[]> {
  const { factory, router } = await montraAddresses(pub);
  return [factory, router];
}

/**
 * Turn seats found on chain (recoverSeats) back into mines and holdings: a mine is the creator of a TokenLaunched
 * near its funding block; a holding received a Montra token from the router's swap near its funding block.
 */
export async function recoverMontra(pub: PublicClient, seats: FoundSeat[]): Promise<{ mines: Mine[]; holdings: Holding[] }> {
  const { factory, router } = await montraAddresses(pub);
  const mines: Mine[] = [];
  const holdings: Holding[] = [];
  const window = 20_000n;
  for (const s of seats) {
    const a = s.account.toLowerCase();
    if (s.label.toLowerCase() === factory.toLowerCase()) {
      const logs = await pub.getContractEvents({ address: factory, abi: ABI.factory, eventName: "TokenLaunched", args: { creator: s.account } as never, fromBlock: s.openedBlock, toBlock: s.openedBlock + window });
      for (const l of logs) {
        const e = l.args as unknown as Record<string, unknown>;
        const token = e.token as Address;
        const info = await tokenInfo(pub, token);
        const recipient = (await pub.readContract({ address: info.hook, abi: ABI.hook, functionName: "recipientOf", args: [info.poolId] })) as Address;
        const rc = await pub.getTransactionReceipt({ hash: l.transactionHash! });
        let splitter: Address | undefined;
        for (const x of rc.logs) {
          try {
            const d = decodeEventLog({ abi: ABI.factory, data: x.data, topics: x.topics });
            if (d.eventName === "FeeSplitterDeployed") splitter = (d.args as unknown as Record<string, unknown>).splitter as Address;
          } catch {}
        }
        mines.push({ seat: s, token, poolId: info.poolId, hook: info.hook, recipient, splitter, symbol: info.symbol, name: info.name, launchTx: l.transactionHash! });
      }
    } else if (s.label.toLowerCase() === router.toLowerCase()) {
      // the first Montra token the seat received after it was funded
      const logs = await pub.request({
        method: "eth_getLogs",
        params: [{ topics: [TRANSFER_TOPIC, null, `0x${"0".repeat(24)}${a.slice(2)}`], fromBlock: `0x${s.openedBlock.toString(16)}`, toBlock: `0x${(s.openedBlock + window).toString(16)}` }],
      } as never) as { address: Address }[];
      for (const l of logs) {
        try {
          const info = await tokenInfo(pub, l.address);
          holdings.push({ seat: s, token: info.token, symbol: info.symbol, name: info.name, spent: s.arrived });
          break;
        } catch {}
      }
    }
  }
  return { mines, holdings };
}
const TRANSFER_TOPIC = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";

// ── a token's card: profile and market, read from the chain ─────────────────────────────────────────────────────

export interface TokenProfile {
  name: string;
  symbol: string;
  /** The image URI as launched (render only http(s):// and ipfs://; see imageSrc). */
  logo: string;
  description: string;
  socials: { telegram: string; twitter: string; discord: string; website: string };
  metadataURI: string;
}

export interface TokenMarket {
  /** HYPE per whole token, from the pool's current price. */
  priceHype: number;
  /** Price × supply, in HYPE. */
  marketCapHype: number;
  /** HYPE held by the token's locked launch position at the current price (what a seller can actually get out). */
  liquidityHype: number;
  supply: bigint;
  /** "new", "graduated"…: Montra's stage, and progress to the next one in basis points. */
  stage: number;
  graduationBps: number;
}

const Q96 = 2 ** 96;
const sqrtAt = (tick: number) => Math.sqrt(1.0001 ** tick) * Q96;

/** HYPE in a position of liquidity `L` between two ticks, at the pool's sqrt price (currency0 = HYPE), in HYPE. */
export function positionHype(L: bigint, sqrtPriceX96: bigint, tickLower: number, tickUpper: number): number {
  const l = Number(L);
  const sp = Number(sqrtPriceX96);
  const sa = sqrtAt(tickLower);
  const sb = sqrtAt(tickUpper);
  const s = Math.min(Math.max(sp, sa), sb);
  if (s >= sb) return 0;
  return (l * (sb - s) * Q96) / (s * sb) / 1e18;
}

/** A Montra token's on-chain profile and market: one multicall to its token and Montra's lens. */
export async function tokenCard(pub: PublicClient, token: Address): Promise<{ profile: TokenProfile; market: TokenMarket }> {
  const { lens } = await montraAddresses(pub);
  const [view, info, name, symbol, supply, meta] = (await pub.multicall({
    contracts: [
      { address: lens, abi: ABI.lens, functionName: "tokenView", args: [token] },
      { address: token, abi: ABI.token, functionName: "getTokenInfo" },
      { address: token, abi: ABI.token, functionName: "name" },
      { address: token, abi: ABI.token, functionName: "symbol" },
      { address: token, abi: ABI.token, functionName: "totalSupply" },
      { address: token, abi: ABI.token, functionName: "metaURI" },
    ],
    allowFailure: false,
  })) as unknown as [Record<string, any>, [Address, string, string, Record<string, string>], string, string, bigint, string];
  const sqrt = view.sqrtPriceX96 as bigint;
  if (view.key.currency0 !== HYPE) throw new Error("Only HYPE-paired Montra tokens are supported.");
  // currency0 is HYPE: the pool's price is tokens per HYPE, so HYPE per token is its inverse
  const priceHype = sqrt > 0n ? (Q96 / Number(sqrt)) ** 2 : 0;
  const cfg = view.config;
  const liquidityHype = positionHype(cfg.seedLiquidity as bigint, sqrt, Number(cfg.seedTickLower), Number(cfg.seedTickUpper));
  const s = info[3] ?? {};
  return {
    profile: {
      name,
      symbol,
      logo: info[1] ?? "",
      description: info[2] ?? "",
      socials: { telegram: s.telegram ?? "", twitter: s.twitter ?? "", discord: s.discord ?? "", website: s.website ?? "" },
      metadataURI: meta ?? "",
    },
    market: {
      priceHype,
      marketCapHype: priceHype * (Number(supply) / 1e18),
      liquidityHype,
      supply,
      stage: Number(cfg.stage),
      graduationBps: Number(view.graduationProgressBps),
    },
  };
}

/**
 * A browser-loadable URL for a token's image, or "" when it can't be shown. Only http(s):// and ipfs:// render
 * (Montra's rule: profiles are whatever the launcher sent). ipfs:// goes through a gateway that serves it.
 */
export function imageSrc(uri: string): string {
  const u = (uri ?? "").trim();
  if (/^ipfs:\/\//i.test(u)) return `https://ipfs.filebase.io/ipfs/${u.replace(/^ipfs:\/\/(ipfs\/)?/i, "")}`;
  if (/^https?:\/\/[^\s"'<>]+$/i.test(u)) return u;
  return "";
}

/** The image types Montra stores, and its size limit. */
export const IMAGE_TYPES = ["image/png", "image/jpeg", "image/webp", "image/gif"] as const;
export const IMAGE_MAX_BYTES = 2 * 1024 * 1024;
