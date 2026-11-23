/**
 * The player's private balance: Cloak's SDK on Gloam's shielded vault. One signature unlocks it; the same wallet always
 * gets the same private account back, and nothing is kept on a server.
 */
import { GloamPrivate, fromJson, gloamProvers as sdkProvers, gloamRelaySubmitter, toJson, type GloamCore, type GloamCoreConfig } from "@cloakely/sdk";
import type { WalletClient } from "viem";
import { HYPE, PRIVACY, type Seat } from "@privacy-for-elysium/eloscape";
import { CHAIN, RELAY_URL, publicClient } from "./wallet";

let provers: GloamCoreConfig["provers"] | null = null;
const gloamProvers = () => (provers ??= sdkProvers()); // ~13 MB of circuit files, fetched once on the first proof

function store(key: string) {
  return {
    load(): string | null {
      try {
        return localStorage.getItem(key);
      } catch {
        return null;
      }
    },
    save(v: string) {
      try {
        localStorage.setItem(key, v);
      } catch {}
    },
  };
}

export interface Private {
  priv: GloamPrivate;
  core: GloamCore;
  address: string;
}

export async function unlockPrivate(wallet: WalletClient): Promise<Private> {
  const who = wallet.account!.address.toLowerCase();
  const recs = store(`pfe.records.v1.${CHAIN.id}.${who}`);
  const priv = await GloamPrivate.unlock(wallet, {
    publicClient,
    chainId: CHAIN.id,
    gloamVault: { pool: PRIVACY.gloamVault, poolBlock: PRIVACY.gloamVaultBlock },
    payMemo: PRIVACY.memoBoard,
    whype: PRIVACY.whype,
    bids: PRIVACY.bids,
    receive: PRIVACY.receive,
    provers: gloamProvers(),
    submit: gloamRelaySubmitter(RELAY_URL),
    logChunk: 5_000_000n, // the public RPC takes the whole range: a first sync in ~3 s, not ~60
    pendingStore: (vault) => store(`pfe.notes.v1.${CHAIN.id}.${who}.${vault.toLowerCase()}`),
    records: {
      load: () => {
        const s = recs.load();
        return s ? (fromJson(s) as never) : [];
      },
      save: (r) => recs.save(toJson(r)),
    },
  });
  await seedFromKeeper(priv);
  return { priv, core: priv.cores[0], address: who };
}

/**
 * The private HYPE balance. The first read asks the RPC for the vault's whole history in a few large requests (~3 s);
 * if that fails (an RPC that limits ranges, a heavy history), it falls back to small pieces, slower but always served.
 */
/**
 * Start the vault's tree from the keeper's public leaf list (GET /leaves), as Cloak's own site does, so the first sync
 * reads only the newest blocks from the RPC instead of the vault's whole history. Checked against the vault's own
 * root by the SDK; if anything is off it simply syncs from the chain.
 */
async function seedFromKeeper(priv: GloamPrivate): Promise<void> {
  try {
    const r = await fetch(`${RELAY_URL.replace(/\/$/, "")}/leaves?pool=${PRIVACY.gloamVault}`);
    if (!r.ok) return;
    const j = (await r.json()) as { block: string; leaves: [number, string, string][] };
    await priv.seedLeaves(PRIVACY.gloamVault, { block: BigInt(j.block), leaves: j.leaves.map(([index, c]) => ({ index, commitment: BigInt(c) })) });
  } catch {}
}

export async function privateHype(core: GloamCore): Promise<bigint> {
  try {
    await core.sync();
  } catch (e) {
    const small = 50_000n;
    const c = core as unknown as { cfg: { logChunk?: bigint }; tree?: { chunk: bigint } };
    // a rate limit isn't a range problem: smaller pieces would only mean more requests. Let the next refresh retry.
    if (/429|too many|rate limit/i.test(String((e as { details?: string })?.details ?? "") + String(e))) throw e;
    if ((c.cfg.logChunk ?? 0n) <= small) throw e;
    console.warn("balance read failed with large ranges, retrying in small ones:", e);
    c.cfg.logChunk = small;
    if (c.tree) c.tree.chunk = small;
    await core.sync();
  }
  return core.ownNotes(HYPE).reduce((a, n) => a + n.amount, 0n);
}

/**
 * A fresh receive address of the private account for each seat's fallback (index 1000 onward, one per seat), so no
 * seat's key ever names the wallet, and no two seats share a fallback. Whatever lands there collects back privately.
 */
export function fallbackFor(priv: GloamPrivate, wallet: string): () => Promise<`0x${string}`> {
  return async () => {
    await (scans.get(wallet.toLowerCase()) ?? Promise.resolve()).catch(() => {}); // never hand out an index a scan is still placing
    const k = `pfe.fallback.v1.${CHAIN.id}.${wallet.toLowerCase()}`;
    const st = store(k);
    const n = Number(st.load() ?? "1000");
    st.save(String(n + 1));
    return priv.receiveAddress(n);
  };
}

/** A fresh receive address (from the same 1000+ range) and its sweep: the way back for a seat the escrow has closed. */
export function receiveRoute(priv: GloamPrivate, wallet: string) {
  const next = fallbackFor(priv, wallet);
  return async () => {
    const address = await next();
    const n = Number(store(`pfe.fallback.v1.${CHAIN.id}.${wallet.toLowerCase()}`).load()) - 1;
    return { address, collect: () => priv.collectReceived(n) };
  };
}

const MULTICALL3 = "0xcA11bde05977b3631167028862bE2a173976CA11" as const;
const MC3 = [{ type: "function", name: "getEthBalance", stateMutability: "view", inputs: [{ name: "addr", type: "address" }], outputs: [{ name: "", type: "uint256" }] }] as const;
async function retry<T>(f: () => Promise<T>, tries = 4): Promise<T> {
  for (let k = 0; ; k++) {
    try {
      return await f();
    } catch (e) {
      if (k >= tries - 1) throw e;
      await new Promise((r) => setTimeout(r, 1500 * (k + 1)));
    }
  }
}
/** Receive addresses from 1000 up are seat fallbacks; this many past the last known one are always checked. */
const FALLBACK_SCAN = 200;

/**
 * Sweep the seat fallbacks back into the private balance, without trusting this device's records: a fresh device
 * (cleared storage, another browser) has no counter, so every receive address from 1000 to the counter plus
 * FALLBACK_SCAN is checked in batched reads, and only those holding HYPE are collected. Addresses found in use
 * (holding funds, or already deployed by an earlier collect) move the counter past them, so a new seat never reuses a
 * fallback another device gave out.
 */
export function sweepFallbacks(priv: GloamPrivate, wallet: string): Promise<number> {
  const w = wallet.toLowerCase();
  const run = scans.get(w) ?? sweep(priv, w).finally(() => scans.delete(w));
  scans.set(w, run);
  return run;
}
const scans = new Map<string, Promise<number>>();

async function sweep(priv: GloamPrivate, wallet: string): Promise<number> {
  const k = `pfe.fallback.v1.${CHAIN.id}.${wallet.toLowerCase()}`;
  const st = store(k);
  const next = Number(st.load() ?? "1000");
  const idx = Array.from({ length: next - 1000 + FALLBACK_SCAN }, (_, i) => 1000 + i);
  const pub = publicClient;
  let made = 0;
  let used = next - 1;
  for (let i = 0; i < idx.length; i += 50) {
    const chunk = idx.slice(i, i + 50);
    const boxes = await retry(() => Promise.all(chunk.map((n) => priv.receiveAddress(n))));
    if (i === 0) console.info(`fallback sweep: first addresses ${boxes.slice(0, 6).join(" ")}`);
    // balances: one multicall per 50 addresses; code: small batches. A read that keeps failing stops the sweep with
    // its error instead of passing for an empty address (it runs again on the next open)
    const bal = await retry(() =>
      pub.multicall({ contracts: boxes.map((a) => ({ address: MULTICALL3, abi: MC3, functionName: "getEthBalance", args: [a] }) as const), allowFailure: false }),
    );
    const code: (string | undefined)[] = [];
    for (let j = 0; j < boxes.length; j += 10) code.push(...(await retry(() => Promise.all(boxes.slice(j, j + 10).map((a) => pub.getCode({ address: a }))))));
    for (let j = 0; j < chunk.length; j++) {
      if (bal[j] > 0n || (code[j] && code[j] !== "0x")) used = Math.max(used, chunk[j]);
      if (bal[j] > 0n) made += (await priv.collectReceived(chunk[j])).length;
    }
  }
  if (used + 1 > next) st.save(String(used + 1));
  console.info(`fallback sweep: checked ${idx.length} receive addresses, collected ${made}, next index ${Math.max(next, used + 1)}`);
  return made;
}

/** Seats this device opened, per wallet. They hold no secrets: each seat's key comes back from the account's signature. */
export function seatBook(wallet: string) {
  const s = store(`pfe.eloscape.seats.v1.${CHAIN.id}.${wallet.toLowerCase()}`);
  return {
    load(): (Seat & { label: string; done?: boolean })[] {
      const v = s.load();
      try {
        return v ? (fromJson(v) as never) : [];
      } catch {
        return [];
      }
    },
    save(x: (Seat & { label: string; done?: boolean })[]) {
      s.save(toJson(x));
    },
  };
}
