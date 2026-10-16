# Architecture

## One-paragraph summary

A client and a freelancer agree on a job in plain language. A local AI (QVAC) turns that text into
**machine-checkable conditions** (tests must pass, a file must match a hash). Both parties approve the
conditions. The client sends test-USDT (an RGB asset) to the **escrow agent's WDK wallet**. The
freelancer uploads the deliverable. A **deterministic verifier** checks every condition. If all pass, the
agent's wallet pays the freelancer; if the deadline passes without a passing delivery, it refunds the
client. Every step is written to a **live decision log**, and QVAC explains each step in plain language.

## Trust model (say this honestly in the pitch)

- **The LLM never moves money.** It only (1) proposes conditions that humans must approve and
  (2) explains decisions after they are made. Release/refund is a pure function of verifier results,
  escrow state and the deadline (`decide()` in `apps/agent`).
- **The escrow agent is a custodian during the escrow.** Funds sit in the agent's own self-custodial
  RGB wallet between funding and release. That is model "A" from our planning. It is transparent
  (every action logged and explained) and local (no cloud), but it is trusted.
- **Stretch goal (do not start before the core demo works):** RGB over Lightning with hold invoices
  via `@utexo/wdk-rgb-lightning`, where funds are locked in an HTLC instead of held by the agent.
  Hold (HODL) invoices exist in UTEXO's fork `UTEXO-Protocol/rgb-lightning-node` (tag
  `v0.11.0-beta.3`: `payment_hash` on invoice, `claimhodlinvoice`, `cancelhodlinvoice`), not in
  RGB-Tools' upstream node. Organizers allow forks if declared in the PR. RGB over Lightning is a
  bonus, not a requirement: an on-chain RGB payment with 1 confirmation fully counts for
  "Payments and checkout".

## Processes and ports

Everything is plain Node.js (TypeScript, ESM). Each box below is a separate process.

```
 Laptop A (client)                 Laptop C (agent, on projector)              Laptop B (freelancer)
 ┌───────────────────────┐        ┌──────────────────────────────────┐        ┌───────────────────────┐
 │ apps/web  (/client)   │──HTTP─▶│ apps/agent        :4000          │◀─HTTP──│ apps/web (/freelancer)│
 │ apps/party :4101      │  + WS  │  • escrow state machine          │  + WS  │ apps/party :4102      │
 │  └ WDK RGB wallet     │        │  • verifier (tests / hash)       │        │  └ WDK RGB wallet     │
 └──────────┬────────────┘        │  • agent's WDK RGB wallet        │        └──────────┬────────────┘
            │                     │  • decision log + WebSocket      │                   │
            │                     └───────┬──────────────────────────┘                   │
            │                             │ HTTP                                         │
            │                     ┌───────▼──────────┐                                   │
            │                     │ apps/ai   :4300  │  QVAC (local LLM, GPU if present) │
            │                     └──────────────────┘                                   │
            │                                                                            │
            └──────────────── RGB transport (proxy) + Electrum indexer + bitcoind ───────┘
                              scripts/regtest (Docker) — runs on ONE laptop, reached over LAN
```

| Process        | Port  | Owner (workstream) | Runs where                                  |
| -------------- | ----- | ------------------ | ------------------------------------------- |
| `apps/agent`   | 4000  | WS3 Escrow core    | Agent laptop, **WSL2 Ubuntu**               |
| `apps/party`   | 4101 (client), 4102 (freelancer) | WS1 Wallet | Each party's laptop, **WSL2 Ubuntu** |
| `apps/ai`      | 4300  | WS2 AI             | Borna's laptop (GTX 1060), **native Windows** |
| `apps/web`     | 5173 (dev) | WS4 UI        | Vite, WSL2 Ubuntu on any laptop             |
| regtest stack  | bitcoind 18443, electrs 50001, rgb-proxy 3000 | WS1 Wallet | Agent laptop, Docker in WSL2 |

Why the AI is its own service: all our laptops run Windows. `@utexo/wdk-wallet-rgb` 2.0.3 ships native
binaries only for Linux and Apple Silicon, so wallets must run in WSL2. QVAC needs the GPU through
Vulkan ≥ 1.4, which works reliably only from native Windows. A separate HTTP service makes that split
trivial, and lets WS2 develop completely independently. WSL2 runs with `networkingMode=mirrored` so
WSL servers are reachable on each laptop's LAN IP (see `docs/SETUP.md`).

## Network choice

Configured by `RGB_NETWORK` + endpoints in `.env`, never hard-coded.

1. **Primary: local regtest** (`scripts/regtest`). Instant blocks on demand, no faucet, no internet,
   fits the "nothing leaves the machine" pitch. The agent exposes `POST /dev/mine` so the demo can
   confirm transfers instantly.
   Organizers confirmed there is no shared regtest: each team runs its own, and they recommend
   regtest for testing because public test networks can have incompatibilities.
2. **Optional upgrade: Mutinynet as plain `signet`.** The WDK adapter supports plain `signet` only
   (confirmed by UTEXO). Use KaleidoSwap's endpoints: indexer `https://esplora.signet.kaleidoswap.com`,
   proxy `rpcs://proxy.kaleidoswap.com/json-rpc`; fallback indexer `https://mutinynet.com/api`
   (rate-limited, and the venue likely shares one public IP). Gains: transfers visible on
   mutinynet.com. Costs: no `/dev/mine`, so we wait for real blocks; BTC from the faucet
   (`https://faucet.mutinynet.com`, 1M sats per IP per 24 h, **fund before arriving**); don't poll in
   tight loops (their maker shares the esplora). Only switch if regtest works end to end first.

## The asset

We use a **test asset we issue ourselves** (NIA, ticker `tUSDT`, precision 6) from a "treasury"
wallet during setup, then send some to the client. In the UI and pitch it is "USDT (test)". This holds
on signet too: **the organizers' faucet USDT cannot be used.** It is a NIA asset issued on
`signetcustom` (recipient ids tagged `sbc:`), while WDK wallets run on plain `signet` (`sb:`). RGB
treats these as separate networks on the same chain, and every asset is bound to one at issuance, so a
WDK wallet cannot receive faucet USDT or pay KaleidoSwap wallets.

## Data and persistence

- Agent: escrows + log in a JSON file (`apps/agent/data/db.json`), written atomically. No database.
- Wallets: each process owns its own `dataDir`. **Never** point two processes at the same `dataDir`,
  and never load the same mnemonic in two places: RGB state can be lost.
- Deliverables: uploaded files stored under `apps/agent/data/deliverables/<escrowId>/<n>/`.

## Key design rules

1. `packages/shared` is the single source of truth for types, zod schemas, API routes and event names.
2. Every external dependency has a **mock** behind the same interface (`MockWallet`, mock AI mode,
   mock agent server for the UI) so all four workstreams build in parallel from hour 1.
3. Amounts are integers in base units, carried as **decimal strings** in JSON (bigint-safe).
4. Every state change emits exactly one `LogEvent`. The UI renders only from state + events.
5. AI calls have a timeout and a templated fallback. The demo must never block on the model.
