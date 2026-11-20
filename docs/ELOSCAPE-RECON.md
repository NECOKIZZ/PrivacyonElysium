# Eloscape: what was checked, and how

Checked Nov 18–20, 2026 against Elysium mainnet (chain 99901) through `rpc.elysium.kinetiq.xyz`, the explorer's
verified sources (`elysium.kinetiq.xyz/explorer/api`) and eloscape.com's own client bundle.

## Addresses

eloscape.com's client bundle names these as its canonical contracts (`NEXT_PUBLIC_LAB_CANONICAL_*`), and all are
verified on the explorer:

| Contract | Address | Verified as |
|---|---|---|
| Game | `0xFa5856b6f352C0E7863D7F5502564130215bf80F` | `ElysiumCanonicalGame` (39 files, solc 0.8.24) |
| ELO | `0xe107e5D99910F544f88ef961E3cA6d88F06f29DD` | `EloToken` |
| Treasury | `0xDB7CEA5D88492330BBd9FD3E9c7cd91A3604BB95` | `TreasuryV2` |
| Staking | `0x60448a43d96d6050824ab1c55Cb661f7887B7DB0` | `Staking` |
| Randomness | `0xa66828Cebf16B678398D1335c22C00FAfF679Ee8` | `DrandRandomnessOracle` |

None is a proxy: their code can't be upgraded.

## Can a contract play?

Yes.
- The game's source has no `tx.origin`, `code.length`, `extcodesize` or "EOA only" check anywhere.
- `deploy` and `setConfigFixed` called from a contract were simulated against live mainnet state (round 6342, a
  forwarder contract injected by state override) and both succeeded.
- Payouts use a plain `call{value}` to the player, which a seat accepts.

## What the owner can and can't do

The owner is a single EOA (`0xc40f3a4bcc1c9077ad08cce365947e70fe18b65e`).
- **Can't:** upgrade the game, block an address (there's no blocklist), or change round timing
  (`ROUND_DURATION = 60 seconds` and `ROUND_INTERMISSION = 12 seconds` are constants).
- **Can:** schedule the game's retirement (`scheduleRetirement`), change the treasury, fee collector or randomness
  oracle, and pause or re-key the signer for solo-block ELO (`pauseSingleElo`, `setSingleEloSigner`).
- Solo-block ELO (`claimSingleElo`) needs a signature from Eloscape's signer
  (`0x09ebe9aa7927e01759d68638e6e910c9e83977ea`). It's the one reward a seat depends on Eloscape's server for.

## Mechanics used

- `deploy(uint8[] blockIds)`, payable: the value is split equally across the blocks, at least 0.0000025 HYPE per block,
  one deploy per address per round.
- `setConfigFixed(blockMask, amountPerBlock)`, payable: Auto from a prepaid balance; `stopConfig()` refunds the rest.
- `claimETH()` pays out HYPE winnings and refunds; `claimELO()` pays ELO.
- Rounds are settled by the randomness oracle (`onRandomnessSettled`), and the next round is scheduled at settlement.

## The privacy side

- Gloam's vault `0x89d3…2164`: 0.5% withdrawal fee, 12 HYPE per deposit, 600 HYPE in total (read Nov 20).
- Cloak's `CloakGloamBids` `0x0334…1758`: `hypeVault()` is Gloam's vault, so seats are funded from it and return to it.
