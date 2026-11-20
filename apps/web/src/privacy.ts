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
    logChunk: 50_000n,
    pendingStore: (vault) => store(`pfe.notes.v1.${CHAIN.id}.${who}.${vault.toLowerCase()}`),
    records: {
      load: () => {
        const s = recs.load();
        return s ? (fromJson(s) as never) : [];
      },
      save: (r) => recs.save(toJson(r)),
    },
  });
  return { priv, core: priv.cores[0], address: who };
}

export async function privateHype(core: GloamCore): Promise<bigint> {
  await core.sync();
  return core.ownNotes(HYPE).reduce((a, n) => a + n.amount, 0n);
}

/**
 * A fresh receive address of the private account for each seat's fallback (index 1000 onward, one per seat), so no
 * seat's key ever names the wallet, and no two seats share a fallback. Whatever lands there collects back privately.
 */
export function fallbackFor(priv: GloamPrivate, wallet: string): () => Promise<`0x${string}`> {
  return async () => {
    const k = `pfe.fallback.v1.${CHAIN.id}.${wallet.toLowerCase()}`;
    const st = store(k);
    const n = Number(st.load() ?? "1000");
    st.save(String(n + 1));
    return priv.receiveAddress(n);
  };
}

/** Sweep the seat fallbacks (receive addresses 1000..next) back into the private balance. */
export async function sweepFallbacks(priv: GloamPrivate, wallet: string): Promise<number> {
  const next = Number(store(`pfe.fallback.v1.${CHAIN.id}.${wallet.toLowerCase()}`).load() ?? "1000");
  let made = 0;
  for (let n = Math.max(1000, next - 50); n < next; n++) made += (await priv.collectReceived(n).catch(() => [])).length;
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
