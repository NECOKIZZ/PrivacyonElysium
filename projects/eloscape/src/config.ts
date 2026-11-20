import type { Address } from "viem";

/**
 * Elysium mainnet (chain 99901). Every address here was read from the chain or from the project's own published
 * configuration on Nov 18, 2026 (see docs/ELOSCAPE-RECON.md for how each one was checked).
 */
export const ELYSIUM_MAINNET = 99901;
export const ELYSIUM_RPC = "https://rpc.elysium.kinetiq.xyz";
export const ELYSIUM_EXPLORER = "https://elysium.kinetiq.xyz/explorer";

/** Eloscape's contracts, as eloscape.com's own client bundle names them. None of them is upgradeable. */
export const ELOSCAPE = {
  game: "0xFa5856b6f352C0E7863D7F5502564130215bf80F" as Address,
  elo: "0xe107e5D99910F544f88ef961E3cA6d88F06f29DD" as Address,
  treasury: "0xDB7CEA5D88492330BBd9FD3E9c7cd91A3604BB95" as Address,
  staking: "0x60448a43d96d6050824ab1c55Cb661f7887B7DB0" as Address,
  randomnessOracle: "0xa66828Cebf16B678398D1335c22C00FAfF679Ee8" as Address,
} as const;

/**
 * The privacy layer: Gloam's shielded vault (HYPE lives here privately) and Cloak's escrow for one-time accounts
 * (CloakGloamBids, whose HYPE vault is Gloam's). Nothing in this repo is deployed: it only uses these live contracts.
 */
export const PRIVACY = {
  gloamVault: "0x89d3042390204f57b8b4F8949D3c2203E4002164" as Address,
  gloamVaultBlock: 3_248_495n,
  memoBoard: "0xb99db19cdeaf3779013a75f2cb7a13d0eecd075a" as Address,
  bids: "0x03344099637832bb26922dca9178675244271758" as Address,
  whype: "0x6521f9729d6c65e5e743de144f5546f334ea7d15" as Address,
  /** Cloak's relay: it sends every private transaction, so the player's wallet never appears. */
  relay: "https://keeper.oncloak.xyz",
} as const;

export const HYPE = "0x0000000000000000000000000000000000000000" as Address;
