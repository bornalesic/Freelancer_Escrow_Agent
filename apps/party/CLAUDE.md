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
3. Background loop: while any transfer is `pending`, `refresh()` every 3 s (stop when none pending).
   Receivers must refresh for transfers to progress — this loop is what makes payments "just arrive".
4. `wallet.init()` on startup; if it fails, keep serving `/health` with `{ ok: false, error }` so the UI
   can show a clear message instead of a dead page.
5. Never return or log the mnemonic. Never expose a "send arbitrary amount anywhere" route beyond
   `/wallet/pay` (the UI only calls it with an invoice the agent provided).

## Done when
With `WALLET_MODE=mock`, two instances (client + freelancer) and the agent can complete the whole flow
from the UI. With `WALLET_MODE=real`, the same works on regtest across two laptops.
