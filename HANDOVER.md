# Handover: hosting and the first live test

## 1. Push access (needed before anything goes to GitHub)

The repo is `NECOKIZZ/PrivacyonElysium` (public, empty). The Claude session works as GitHub user
`cloakonelysium-beep`, which can read it but not push. Either:
- add `cloakonelysium-beep` as a collaborator with **Write** access (repo → Settings → Collaborators), or
- install the Claude GitHub App on NECOKIZZ for this repo and connect NECOKIZZ at claude.ai/connect-github.

## 2. Hosting (Vercel)

`vercel.json` is set up: install `npm install`, build `npm run build`, output `apps/web/dist`. Pages use hash routes
(`/#/eloscape`), so no rewrites are needed. Environment variables (optional, these are the defaults):

| Variable | Default |
|---|---|
| `VITE_RELAY_URL` | `https://keeper.oncloak.xyz` |
| `VITE_RPC_URL` | `https://rpc.elysium.kinetiq.xyz` |

Point the subdomain (e.g. `ecosystem.oncloak.xyz`) at the Vercel project.

## 3. One change on Cloak's keeper (required)

The keeper answers browser calls only from the origins in `CORS_ORIGINS`. Mainnet today:
`https://oncloak.xyz,https://www.oncloak.xyz`. Add the new site's origin in the Render dashboard (and in Cloak's
`render.yaml` so it stays), e.g.:

```
CORS_ORIGINS=https://oncloak.xyz,https://www.oncloak.xyz,https://ecosystem.oncloak.xyz
```

Nothing else changes on the keeper: its mainnet `GLOAM_ESCROWS` already includes the bids escrow
(`0x0334…1758`) and the receive contract (`0xe2a8…f9e`) this site uses.

## 4. First live test on mainnet (small amounts)

1. Open the site, **Connect & go private**, sign once.
2. **Add** 0.2 HYPE (the one public transaction, from your wallet).
3. Pick one block, Sealed **off**, stake 0.05, **Play**. Check on the explorer: the play comes from a fresh address,
   sent by the keeper, and your wallet appears nowhere.
4. After the round, **Collect**. The HYPE (if it won) or nothing (if it lost) comes back to the private balance.
5. Repeat with **Sealed** on: the play should land in the round's last ~6 s.
6. Repeat with **Also hide my amount** and 0.35: three seats, 0.2 + 0.1 + 0.05.
7. Try **Auto** with 0.1 at 0.01 per block on one block, let it run two rounds, **Stop & collect**.

## 5. Optional

- `@cloakely/sdk` on npm (0.9.2) predates the Gloam features. This repo vendors a build of Cloak's source at
  `6d5470b` (`vendor/`). Publishing a new SDK version lets this repo depend on npm instead.
- Sealed Play keeps the signed play on the device. A public drand-timelocked copy (so anyone can send it if the tab
  closes) would need a small board contract; not built.

## Tests

- `npm run test:fork`: the Eloscape integration end to end on a mainnet fork (18 checks).
- `npm run test:ui`: the site itself in Chromium on a mainnet fork, clicking through connect, add, play, collect,
  sealed + split.
