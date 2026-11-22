# Privacy on Elysium

Use Elysium's apps from a private balance. Each page here takes one live Elysium project and lets people use it so the
project, and everyone watching the chain, sees a fresh one-time address instead of their wallet.

> **Independent and unofficial.** This is an initiative by [Cloak](https://oncloak.xyz). The projects listed here don't
> build, run, review or endorse it. Their names and logos only identify whose public contracts a page talks to.

It's built entirely on [Cloak's SDK](https://oncloak.xyz/sdk) and [Gloam](https://gloam.trade)'s shielded vault, using
contracts that are already live on Elysium mainnet. **This repo deploys no contracts.**

## Projects

| Project | What's private | Page | Integration |
|---|---|---|---|
| [Eloscape](https://eloscape.com) | Who mines, which block (until 6 s before close), how much | `apps/web/src/projects/eloscape` | `projects/eloscape` |

Adding a project: an integration in `projects/<id>/` (no UI, testable on a fork), a page in
`apps/web/src/projects/<id>/`, a card in `apps/web/src/projects.ts`, and its logo in `apps/web/public/projects/<id>/`.

## How it works (Eloscape)

```
Private note in Gloam's vault
   │ 1. a zero-knowledge proof sends it to a fresh one-time "seat" address
   │    (the address is fixed by everything about the seat, so the proof can't be redirected)
   ▼
Seat ── deploy / setConfigFixed / claimETH ──▶ Eloscape's game (an ordinary player to it)
   │ 2. every call is signed by a one-time key derived from the player's private account
   │    and sent by Cloak's relay, so the player's wallet never sends a transaction
   ▼
Winnings back into Gloam's vault as new private notes
```

The seat is an account of Cloak's escrow `CloakGloamBids` on mainnet (`0x0334…1758`), used through its generic
`ownerCall`. Nothing new holds funds: the money is always in Gloam's vault, in the seat, or in Eloscape's game, and
each has a way out. If the player never returns, anyone can push a seat's funds to its fallback address after its
timeout (7 days by default). The fallback is a fresh Cloak receive address of the player's private account (one per
seat), never their wallet: the seat's key travels in the clear with every call, so a wallet there would undo the
privacy. Whatever lands at a fallback is swept back into the private balance the next time the player opens the page.

| Phase | Hides | How |
|---|---|---|
| 1 · Private Play / Private Auto | **Who** plays | One seat per play, or one seat running Eloscape's own Auto for many rounds |
| 2 · Sealed Play | **Which block**, until ~6 s before the round closes | The seat is funded early; its signed deploy stays on the player's device and is sent at the last moment |
| 3A · Split Play | **How much** | The stake as standard sizes (10, 5, 2, 1, 0.5, 0.2, 0.1, 0.05 HYPE), each from its own seat |

What stays public: each seat's blocks and amount once it plays (as for any player), and that a seat was funded from
Gloam's vault. Privacy grows with use: the more people use the vault, the harder deposits and plays are to link.

**Limits, stated plainly**
- Gloam keeps 0.5% when a note leaves the vault. Eloscape's own fees apply as for anyone.
- ELO can't enter Gloam's vault: it stays with the seat until the player sends it to an address they choose.
- Eloscape's solo-block ELO bonus is paid only with a signature from Eloscape's server. HYPE winnings and split-block
  ELO don't depend on it.
- Sealed Play needs the tab open until its play lands.
- The page reads the chain from the browser through the public RPC, which sees the visitor's IP alongside the seats it
  asks about. Use a VPN or your own RPC (`VITE_RPC_URL`) if that matters to you.

## Repo

```
apps/web/               the site: hub ("Privacy on Elysium") and one page per project (Vite + React)
projects/eloscape/      the Eloscape integration on @cloakely/sdk (no UI)
test/eloscape.fork.ts   end to end on a fork of Elysium mainnet, real proofs, real contracts
vendor/                 @cloakely/sdk built from Cloak's source (commit 6d5470b): the Gloam features aren't on npm yet
docs/                   what was checked on chain, and how
```

## Run

```bash
npm install
```

```bash
npm run dev
```

The end-to-end test needs [Foundry](https://getfoundry.sh)'s `anvil` on `PATH`:

```bash
npm run test:fork
```

MIT licensed.
