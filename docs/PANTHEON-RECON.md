# Pantheon: what was checked, and how

Checked Nov 27, 2026 (block ~11 789 971) against Elysium mainnet (chain 99901) through `rpc.elysium.kinetiq.xyz`, the
explorer's API (`elysium.kinetiq.xyz/explorer/api`), pantheonperps.com's client bundle and its public `/api/*`.

## Status: not ready to build on yet

- **No position has ever opened.** The engine has taken 7 orders, all from one EOA (`0xD69C…371A`), and all were
  cancelled by the keeper with `market_cap` or `side_cap`. `totalSize` is 0, as is `deferredTotal`.
- The bundle ships with `VITE_TRADING_LIVE=false`, and every one of the 22 Elysium-token markets reads `paused: true` in
  `/api/markets`. (The other ~300 markets in that feed are mirrored from Hyperliquid, and their volume and open
  interest are Hyperliquid's own figures, not Pantheon's.)
- The LP pool holds **~510 USDC**, so side caps top out around $2.6k on one market and Up/Down at ~$14 a side.
- **The engine is being replaced.** The pool has `proposedEngine = 0xDEA9…2C7C`, ready at `1795969224`
  (Nov 29 16:20 UTC). Anything we build must target that engine, not the current one.

## Addresses

From the bundle's env block (`VITE_*_ADDRESS`). **None of Pantheon's own contracts is verified** on the explorer, so
the ABIs below come from the bundle's human-readable ABI strings. None is a proxy (EIP-1967 implementation and beacon
slots are empty): engine, oracle and reader are swapped by propose → wait → accept on the pool.

| Role | Address | Code |
|---|---|---|
| Engine (current) | `0xb0bcf9cf6a4ee65d6fc4c5497b789db9f9724be4` | 24 030 B |
| Engine (pending, Nov 29) | `0xDEA954c2093d94A17e8afB0c46A9596e5D1a2C7C` | 24 574 B |
| LP pool | `0x9d73f372666fedce9c91baa751c5eefdbd55ecdc` | 7 242 B |
| Tranches (steady / bold LP) | `0xf387fb59b900feb21f8b9dc17dc5245d5a4eab0d` | 14 789 B |
| Pooled | `0xc3f2848305f64c59119f71dee36efdb24105917f` | 11 403 B |
| Up/Down | `0xdd9d8ae873e8686f032774fc5f12f239fee75a2e` | 14 488 B |
| Copy factory | `0x26e56fd07538200435bd58c05106cab274e4d5fb` | 1 873 B |
| Oracle / coin oracle | `0xd02e…461e` / `0xc420…4b` | |
| Engine's oracle | `0x0e818f21AE1ECcaAE31252c0adbf9c882531c3C7` | 15 046 B |
| Reader, early listing, theme oracle, theme record | `0xcad6…f770`, `0xee15…ea1d`, `0xaa10…ef8b`, `0x3637…9e5d` | |
| Collateral: USDC (6 dp) | `0xb47c4C8F73F009CC0C0d3f92B388d13E293F0B65` | beacon proxy |

**Owner of everything:** a 2-of-3 Gnosis Safe `0xc5d5955C4C46AE844C0FF14557b7253F3935739b` (owners `0xd1a3…eef2`,
`0xb7d4…1200`, `0x3c2a…57f5`). Engine keeper (fills orders): `0x1195A07F2EB01Ec0f056C5b28CAa8f3934A901a0`.

## Mechanics (engine)

- `requestOpen(market, isLong, collateral, leverage, price, limit, takeProfit, stopLoss)`, payable with
  `executionFee()` = **0.0005 HYPE**; collateral is USDC pulled from the caller. The keeper then calls
  `executeOpen(orderId, fillPrice, priceTime)` or cancels the order with a reason.
- `requestClose(positionId, acceptablePrice)` (also payable), `requestTrigger` for TP/SL, `cancelOrder`.
- Payouts go to `positions.trader`. Above `dailyPayoutBps` (10% of the pool per day) the rest is `deferred`, claimed
  later with `claimDeferred(trader)` or `claimOwed()`.
- Every listed market reads the same on both engines: max 3×, maintenance margin 10%, fee 0.2%, max 10% of the pool
  per market and 7% per side.
- Up/Down: `enter(bytes32 market, bool up, uint256 stake)`, settled by `settle(ids)`. Yes/No questions:
  `enter(id, yes, amount)`. Copy trading: `open(leader, settings)` deploys a per-follower account (none exist yet).

## Can a contract trade?

**Probably, but this isn't proven yet.**
- No `ORIGIN` opcode (so no `tx.origin`) in the bytecode of the engine, the pending engine, pool, pooled, tranches,
  Up/Down, copy factory or the engine's oracle. The `EXTCODESIZE` counts look like Solidity's normal pre-call checks.
- Not checked: a fork simulation of `requestOpen` from a contract. It's worth doing only once the new engine is
  accepted, and only against a market that isn't paused.
- The keeper is off-chain and decides what it fills. Whether it treats fresh addresses the same as any other is a
  policy question that only real fills will answer.

## What the owner can and can't do

- **Can:** pause the engine; change any market's leverage, margin, fees and caps (`setMarket`); swap the engine,
  oracle and reader (with a delay); set the keeper; **`voidDeferred(trader, amount)`**, which cancels a trader's
  deferred winnings; allowlist depositors and open or close deposits; force-drop index coins at a price they choose
  (`forceDrop`).
- **Can't (as far as the ABI shows):** upgrade a contract in place. Changes land as new contracts behind a delay.
- The keeper sets the fill price (`executeOpen(..., fillPrice, priceTime)`), checked against the oracle on chain in a
  way we can't read without source.

## The privacy side

- Gloam's vault (`0x89d3…2164`) already holds this exact USDC (`assets` in the vendored SDK), and the SDK's router
  swaps HYPE ↔ USDC privately. So a seat could be funded in USDC straight from a private balance.
- The vault holds only **~17 USDC** today. A USDC note is a small crowd; funding from HYPE notes and swapping at the
  seat is the bigger one.
- A seat needs a little HYPE as well (0.0005 per order or close) on top of its USDC.
- Deferred winnings mean a seat may have to wait days to be paid, and the owner can void them. That outlives a
  7-day seat timeout unless the seat's life is set longer.

## What would change the verdict

1. The new engine is accepted (after Nov 29 16:20 UTC) and `VITE_TRADING_LIVE` flips to true.
2. Markets unpause and the pool grows enough that a real position can open.
3. A real fill from a contract address, checked first by fork simulation, then with a small mainnet test.
