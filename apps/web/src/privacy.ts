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
