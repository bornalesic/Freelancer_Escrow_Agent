# apps/party — per-party wallet server (WS1)

A thin HTTP server that owns **one** party's WDK RGB wallet (client or freelancer) and exposes the
party routes from `docs/CONTRACTS.md` §4. The web UI on that party's laptop talks to it for everything
wallet-related, and to `apps/agent` for everything escrow-related. Runs in WSL2 Ubuntu.

## Run
Root scripts `dev:party:client` / `dev:party:freelancer` call this package's `dev:client` / `dev:freelancer`
scripts, which you create as `cross-env ROLE=client PARTY_PORT=4101 tsx watch src/server.ts` (and the
freelancer equivalent with 4102). Each role uses its own wallet dir `RGB_DATA_DIR/<role>`.
Env: `ROLE`, `PARTY_PORT`, `WALLET_MODE`, `RGB_*` (see `.env.example`), `<ROLE>_MNEMONIC`, `ESCROW_ASSET_ID`.

## Tasks
1. Fastify server with CORS, request logging, zod validation from `@escrow/shared`.
2. Routes: `GET /health`, `GET /wallet`, `POST /wallet/invoice`, `POST /wallet/pay`,
   `POST /wallet/refresh`, `GET /wallet/transfers`, `POST /wallet/sign`.
   Client review (branch `New_Rules`) needs no new party routes: an approval leads to the same agent
   `pay()`. Stretch: the client UI can sign its approval with `/wallet/sign`, like acceptances.
3. Background loop: while any transfer is `pending`, `refresh()` every 3 s (stop when none pending).
   Receivers must refresh for transfers to progress — this loop is what makes payments "just arrive".
4. `wallet.init()` on startup; if it fails, keep serving `/health` with `{ ok: false, error }` so the UI
   can show a clear message instead of a dead page.
5. Never return or log the mnemonic. Never expose a "send arbitrary amount anywhere" route beyond
   `/wallet/pay` (the UI only calls it with an invoice the agent provided).

## Done when
With `WALLET_MODE=mock`, two instances (client + freelancer) and the agent can complete the whole flow
from the UI. With `WALLET_MODE=real`, the same works on regtest across two laptops.

## Status (mock mode done; `npm test -w apps/party`: 9 tests)
Tasks 1–5 are implemented: `src/app.ts` (routes), `src/wallet.ts` (create + init with retry every 15 s,
timeout on every call), `src/refresh-loop.ts`, `src/config.ts`, `src/server.ts`. Verified end to end
with real processes (agent + both party servers, `WALLET_MODE=mock`): create → accept ×2 → the client
pays the funding invoice from its party server → agent `FUNDED`; balances client 100 → 90, agent 0 → 10.
Remaining: `WALLET_MODE=real` once `RgbWdkWallet` lands in `packages/wallet`.

## Marketplace (apps/market)
- **Both servers on every laptop.** Anyone can pick either role, so each laptop runs `npm run dev:parties`
  (client :4101 + freelancer :4102), each with its own mnemonic and `RGB_DATA_DIR/<role>` wallet.
- **Private.** `/wallet`, `/wallet/pay`, `/wallet/transfers`, `/wallet/sign` and `/autopay` answer only
  loopback requests whose `Origin` (if any) is `localhost` / `127.0.0.1` / `[::1]`. The loopback check
  alone is not enough: a browser on this laptop is always loopback, whatever site it shows. The LAN can
  still reach `/health` and `/wallet/invoice`.
- **Auto-pay** (`src/autopay.ts`, client role only). `POST /autopay { escrowId, clientToken }` when the
  client publishes. Each tick, per authorisation: when the agent shows `AWAITING_FUNDS`, attach a refund
  invoice (valid until deadline + 1 day, max 30 days) with the clientToken, then pay exactly
  `amount + fee`. State in `apps/party/data/<role>/autopay.json` (mode 0600); a `paying` entry found at
  start becomes `failed`, never paid twice. `npm run demo:clear-jobs` deletes `apps/party/data`.
- Verified end to end with real processes (mock wallets, 2026-10-18): publish → auto-pay → take →
  funded → v1 fails → v2 passes → released; client −51, freelancer +50, agent +1 (fee).

## Learned the hard way
- **"Refresh only while pending" is not enough for a receiver.** A wallet's first invoice for an asset
  is unbound, and its incoming transfer may not be listed under that asset until a refresh pulls the
  consignment in, so a pending-only loop could wait forever. The loop also keeps refreshing until each
  invoice this server handed out expires (`RefreshLoop.watchInvoice`, monotonic deadline).
- `GET /wallet/transfers?assetId=` has no query schema in `@escrow/shared`; it is validated locally
  (`TransfersQuerySchema` in `src/app.ts`). Candidate for the next contract change.
- **Tests need Node ≥ 22.12.** Fastify's `inject()` loads `light-my-request`, whose `cookie@2` is
  ESM-only; on Node 20 every test fails with "require() of ES Module ... not supported". In WSL, nvm's
  Node only loads in interactive shells: `bash -ic` gets Node 22, `bash -lc` got the system Node 20.
- **Run git inside WSL, never Windows Git for Windows on the `\\wsl$` / `Z:` checkout.** Its
  `core.autocrlf=true` writes every file it checks out with CRLF, so WSL git then shows dozens of other
  workstreams' files as modified. Fix if it happens: in WSL, check `git diff --ignore-cr-at-eol --stat`
  shows no real changes, then `git checkout -- <those files>`.
