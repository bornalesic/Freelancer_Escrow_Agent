# Freelancer Escrow Agent

> Hackathon "Agentic Dollars on Bitcoin" · Turin, BLOX · October 17–18, 2026

A freelancer escrow agent that pays in USDT on Bitcoin. The client and freelancer write their agreement
in plain language. A local AI (QVAC) turns it into machine-checkable conditions. The client locks USDT
(an RGB asset) in the agent's self-custodial Tether WDK wallet. The agent verifies the delivery (tests
pass, file hash matches), lets the client judge what only a person can judge with an AI review to help,
and pays the freelancer, or refunds the client. Every decision is explained in plain language, and
nothing leaves the participants' machines.

---

## Team

**Team name:** Inglorious Engineers

| Name | GitHub |
| ---- | ------ |
| Borna Lešić | [@bornalesic](https://github.com/bornalesic) |
| Marko Zovko | [@ZovkoM555](https://github.com/ZovkoM555) |
| Marko Cindrić | [@Marko-Cindric](https://github.com/Marko-Cindric) |
| Roko Domović | [@RoKo30](https://github.com/RoKo30) |

---

## The idea

Freelancers get paid late or not at all; clients pay for work that doesn't work. Escrow services are
slow, custodial and take a cut. Our agent:

1. **Understands the deal.** The client and freelancer describe the job in plain language. QVAC,
   running on-device, turns it into checks a machine can verify: "the test suite passes", "the
   delivered file matches this hash", "a README is included". Both parties approve the exact checks
   before any money moves.
2. **Holds the money on Bitcoin.** The client locks USDT, an RGB asset, in the escrow agent's own
   self-custodial Tether WDK wallet.
3. **Checks the work.** The freelancer uploads the delivery and a deterministic verifier runs every check.
   Requirements only a person can judge ("the logo looks professional") are agreed as client-review
   items: QVAC reads the delivery and writes an opinion, and the client approves or disputes.
4. **Pays or refunds.** All checks pass (and the client approves, or doesn't object in time) → the
   freelancer is paid over RGB. Deadline missed → the client is refunded.
5. **Explains every step.** A live decision log shows what happened and why, with a plain-language
   explanation from the local model.

### Why RGB
USDT natively on Bitcoin, with client-side validation that keeps transfers private, and self-custodial
wallets for every party. No smart-contract platform or third-party payment processor in the middle.

### Why local AI (QVAC)
Agreements and deliverables are often confidential client work: source code, designs, contracts. With
QVAC, the agreement, the code and the AI's reasoning never leave the participants' machines.

### The AI never moves money
The model only (a) proposes conditions that both humans must approve, (b) explains decisions after
they are made and (c) gives the client an opinion on subjective requirements. Release and refund come
from a deterministic verifier, the client's own approval and a pure decision function that never reads
the AI's opinion.

---

## Stack

| Layer | Technology | What we use it for |
| ----- | ---------- | ------------------ |
| Asset layer | **RGB** on Bitcoin | test USDT: issuance, invoices, transfers into and out of escrow |
| Local AI | **QVAC** (`@qvac/sdk`, Qwen models, on-device) | plain-language agreement → verifiable conditions; streamed explanations |
| Wallets (bonus) | **Tether WDK** + `@utexo/wdk-wallet-rgb` | self-custodial RGB wallets for client, freelancer and escrow agent |
| Chain | Local Bitcoin regtest (bitcoind + electrs + RGB proxy, Docker) | private test network, blocks mined on demand |
| App | TypeScript, Node.js 22, Fastify, zod, React + Vite + Tailwind | escrow server, wallet servers, AI service, two web UIs |
| Dev environment | Windows 11 + WSL2 Ubuntu; QVAC on native Windows (GPU via Vulkan) | — |

---

## Status before the hackathon (prior work declaration)

As of our first commit (October 14, 2026), this repository contains **planning material only. There
is no product code.**

| What | Where | Notes |
| ---- | ----- | ----- |
| Architecture, escrow state machine, data/API contracts | `docs/` | design documents, no implementation |
| Demo plan, risk list, setup checklist | `docs/` | |
| Instructions for our AI coding assistant | `CLAUDE.md` files, `.claude/commands/` | we use Claude Code during the hackathon |
| Config templates | `package.json`, `.env.example`, `.gitignore`, `.nvmrc` | workspace layout and variable names only |

The planning documents were drafted with the help of an AI assistant (Claude).

**All application code** (`packages/*/src`, `apps/*/src`, scripts, UI, demo fixtures) **is written
during the hackathon.** The git history shows exactly what was added on site.

Other prior work (code, prototypes, designs, apps): none.

### Installed and working before the event

‹FILL IN — tick only what you actually tested, delete the rest›

- [ ] WSL2 Ubuntu + Node.js 22 on all four laptops
- [ ] QVAC SDK installed; model `‹FILL IN›` downloaded and running on ‹FILL IN: GPU / CPU›,
      ‹FILL IN› tokens/s
- [ ] `@utexo/wdk-wallet-rgb` installs and loads in WSL2
- [ ] Regtest stack (bitcoind + electrs + RGB proxy) starts via Docker
- [ ] Ran the official quickstarts/tutorials (QVAC, WDK, RGB wallet) to learn the APIs.
      These throwaway experiments are not part of this repository.
- [ ] ‹FILL IN›

---

## Final submission (completed by Sunday, October 18, 13:00)

### How to install and run

**Requirements.** Node.js ≥ 22.17. Wallets run in **WSL2 Ubuntu 24.04** (the RGB library's native binary
needs glibc ≥ 2.38). The real AI service runs on **native Windows** with a GPU (QVAC uses Vulkan). The
regtest chain needs Docker. Details: [`docs/SETUP.md`](docs/SETUP.md).

```bash
git clone https://github.com/bornalesic/Freelancer_Escrow_Agent.git && cd Freelancer_Escrow_Agent
npm install                      # in WSL; on the AI laptop also in Windows PowerShell
cp .env.example .env.local       # per-laptop settings; mnemonics stay in this file, never in git
```

**One laptop, no chain, no GPU (mock wallets + mock AI):**
```bash
npm run dev:mock                 # agent :4000, client + freelancer wallets :4101/:4102, mock AI :4300, marketplace :5174
```
Open **http://localhost:5174**, choose Client in one tab and Freelancer in another; the service screen is
`/service`. Every process keeps working with `WALLET_MODE=mock` / `AI_MODE=mock`: that is our stage fallback.

**Real RGB on regtest (the demo setup, three to four laptops):**
1. Agent laptop: `docker compose -f scripts/regtest/compose.yaml up -d` (bitcoind, electrs, RGB proxy).
2. Client and freelancer laptops: `npm run setup:role -- --role client|freelancer` (creates the wallet,
   prints its address).
3. Agent laptop: `npm run demo:setup -- --client-address <a> --freelancer-address <b>`: funds every wallet
   with BTC, creates UTXOs, issues the test USDT asset, sends 100 to the client, writes `ESCROW_ASSET_ID`.
4. Start, in this order: `npm run dev:ai` (AI laptop, PowerShell) → `npm run dev:agent` → `npm run dev:parties`
   on each party laptop → `npm run dev:market` (or `npm run dev:web` for the three-screen view).

Exact per-laptop settings, LAN/firewall steps and the run checklist: [`docs/INTEGRATION_PLAN.md`](docs/INTEGRATION_PLAN.md)
and [`scripts/regtest/README.md`](scripts/regtest/README.md). Between runs: `npm run demo:clear-jobs` (jobs
only) or `npm run demo:reset` (jobs and wallets).

**Checks:** `npm run typecheck` and `npm test` (vitest in every workspace). `npm run fixtures:zip` builds the
demo deliveries into `fixtures/dist/`.

### What we built during the hackathon

| Part | What it does |
| ---- | ------------ |
| `packages/shared` | Every type, zod schema, route name and event crossing a process boundary; amounts in bigint-safe base units; canonical `termsHash` (pure JS, so browsers can recompute it); the service fee. |
| `packages/wallet` | `RgbWdkWallet` on Tether WDK (`@utexo/wdk-wallet-rgb`) and a `MockWallet` on a shared JSON ledger, behind one `EscrowWallet` interface. |
| `apps/agent` (:4000) | The escrow service: state machine, deterministic verifier, the pure `decide()` function, the agent's own WDK wallet, a 5-second ticker for every deadline, a live decision log over WebSocket. |
| `apps/ai` (:4300) | QVAC service: agreement → conditions (`/parse`), streamed explanations (`/explain`), advisory review of subjective items (`/review`), and seven assist features (`/assist/*`). Every route has a deterministic fallback. |
| `apps/party` (:4101/:4102) | Each person's own wallet server. Balances and spending answer only to the same laptop; auto-pay funds a job the moment a freelancer takes it. |
| `apps/market` (:5174) | The marketplace UI used in the demo: role choice, listings, requirements review, counteroffers, practice checks, client review, a service screen for the projector, a "How payments work" page. |
| `apps/web` (:5173) | The first UI: one screen per role (client, freelancer, projector) with the big decision log, client review with sandboxed file previews, and a fixture mode that works without any server. |
| `scripts/` | Regtest stack (Docker compose) and the demo setup/reset scripts that create, fund and reset every wallet. |
| `fixtures/` | Demo deliveries (`slugify` v1 fails/v2 passes; `landing` v1/v2 for client review, plus a prompt-injection copy) and an eval set of 17 agreements for the parser. |

The escrow in one paragraph: the client describes a job; QVAC proposes checks (tests pass, file present,
file hash, example inputs → outputs, or "client reviews"); the client approves and the job is listed with
reward + 2 % fee pre-authorised. When a freelancer takes it, the client's wallet pays the agent's RGB invoice
automatically. The freelancer uploads work (and can first run a practice check with QVAC's hints); the
verifier runs every automatic check. A failure goes back to the freelancer before the deadline; a pass pays
the freelancer over RGB, after the client's approval if there are client-review items (no answer within the
review window also pays). No passing delivery by the deadline refunds the client. Architecture and
security details: [`docs/TECHNICAL.md`](docs/TECHNICAL.md); screens: [`docs/UI.md`](docs/UI.md).

### What is mocked, simulated or hard-coded
- **Chain and asset.** A local Bitcoin **regtest** network, not mainnet or signet. The "USDT" is a test asset
  (`TUSDT`, NIA, precision 6) that our setup script issues; it is not Tether's USDT. Blocks are mined on demand
  by the agent (`AUTO_MINE=true`, `POST /dev/mine`) so transfers confirm in seconds.
- **Mock modes (fallback only).** `WALLET_MODE=mock` (shared-ledger `MockWallet`) and `AI_MODE=mock` exist so
  the demo survives a broken chain or GPU. The demo itself ran with real WDK wallets on regtest.
- **No accounts.** Users pick a role (Client or Freelancer) without sign-up. Identity is a one-time
  `clientToken` / `freelancerToken` kept in the browser; balances are private because each wallet server
  answers only its own laptop.
- **Verifier sandbox.** Freelancer code runs in a temp folder with a timeout, a minimal environment and the
  process tree killed afterwards, but not in a container.
- **Fixed values.** Service fee 2 % (`SERVICE_FEE_PERCENT`); short demo windows (`REVIEW_WINDOW_SEC` ≈ 120 s,
  `FUNDING_WINDOW_SEC` 600 s, `OFFER_WINDOW_SEC` 900 s), all set in `.env`.
- **Not built** (from our feature list): team payouts and the 90/10 split on a late dispute. "Split with my
  team" is an AI suggestion only; payout stays one freelancer, all-or-nothing.
- **`apps/web` fixture mode** (`?fixture=1`) renders recorded data for screenshots; it is not used in the flow.

### RGB operations used
All through the WDK RGB wallet (`packages/wallet/src/rgb-wdk-wallet.ts`, `treasury.ts`, `scripts/`):
- **Issuance:** `issueAssetNia` creates the test USDT asset (setup).
- **UTXO management:** `createUtxos` gives every wallet free colourable UTXOs; `listUnspents` checks them.
- **Receive invoices:** `receiveAsset` (blinded, `witness: false`) for the agent's funding invoice
  (reward + fee), the client's refund invoice and the freelancer's payout invoice. Each invoice is single-use.
- **Transfers:** `transfer` pays the funding invoice (client → agent), the payout (agent → freelancer, the
  service keeps the fee) and refunds (agent → client), with fee rate and confirmation settings from `.env`.
- **Settlement tracking:** `refreshWallet` (pulls consignments from the RGB proxy), `listTransfers` (status
  pending → settled/failed), `syncWallet`, `listAssets` and asset balances.
- **Consignment transport:** the RGB proxy server from the regtest stack; electrs as the indexer.

### QVAC features used
`@qvac/sdk` 0.21.0 on-device, Qwen3.5 2B (Q4) on GPU via Vulkan, with Qwen3.5 0.8B as fallback
(`apps/ai/src/llm.ts`): `loadModel` (once, with warm-up), `completion` with **streaming** (`contentDelta`
events), **structured output** (`responseFormat: json_schema`), `reasoning_budget: 0`, `cancel` on timeout,
`unloadModel` on shutdown. What the model does:
- **Parse** a plain-language agreement into conditions + summary (guards drop anything not literally in the
  text, such as invented hashes or files; a deterministic parser is the fallback). Eval: 17/17 agreements.
- **Explain** every important log event in plain English, streamed live (grounding check, template fallback).
- **Review** delivered files for client-review items: an advisory opinion (looks met / unmet / unsure),
  with excerpts fenced as untrusted input against prompt injection. Never read by the payment decision.
- **Assist** (all advisory): clarifying questions, verifiability score + measurable rewrites, price/deadline
  check, Q&A answered only from the terms, hints for a failed practice check, job matching and team split.

### WDK features used
Every wallet in the system is a self-custodial Tether WDK wallet (`@utexo/wdk-wallet-rgb` 2.0.3,
`WalletManagerRgb` → `getAccount()`), each with its own mnemonic and data folder:
- **Escrow agent wallet:** creates the funding invoice, receives and holds the funds, pays the freelancer
  (keeping the fee) or refunds the client. Its balance is the "held in escrow" figure.
- **Client wallet:** auto-pays the funding invoice (reward + fee) and creates its own refund invoice.
- **Freelancer wallet:** creates a fresh payout invoice for every delivery.
- **Treasury wallet (setup):** issues the asset and funds the client.
- Operations: `registerWallet`, `createUtxos`, `issueAssetNia`, `receiveAsset`, `transfer`,
  `refreshWallet`, `syncWallet`, `listTransfers`, `listAssets`, asset/BTC balances, `sign` (message
  signature exposed by the party server), `dispose`.

### Third-party tooling (declared)
Organizers allow community forks and third-party tooling if declared in the pull request.
- `@utexo/wdk-wallet-rgb` 2.0.3 (UTEXO's WDK adapter for RGB) and its `@utexo/rgb-sdk` /
  `@utexo/rgb-lib` dependencies
- `@qvac/sdk` 0.21.0 and the Qwen3.5 2B / 0.8B models it downloads
- Regtest Docker images: `registry.gitlab.com/hashbeam/docker/bitcoind:30.2`,
  `registry.gitlab.com/hashbeam/docker/electrs:0.11.0`, `ghcr.io/rgb-tools/rgb-proxy-server:0.3.0`
- Open-source npm libraries: Fastify, zod, React, React Router, Vite, Tailwind CSS, vitest, adm-zip, fast-glob
- No forks of RGB or Lightning software are used.

---

## Documentation

| Doc | What it's for |
| --- | ------------- |
| [`docs/TECHNICAL.md`](docs/TECHNICAL.md) | **as built:** components, money flow, state machine, security, AI guards, testing |
| [`docs/UI.md`](docs/UI.md) | **as built:** every screen of the marketplace and the three-screen UI |
| [`docs/ARCHITECTURE.md`](docs/ARCHITECTURE.md) | processes, ports, trust model, network choice |
| [`docs/ESCROW_FLOW.md`](docs/ESCROW_FLOW.md) | escrow state machine, step by step |
| [`docs/CONTRACTS.md`](docs/CONTRACTS.md) | types, events, HTTP/WebSocket APIs |
| [`docs/RGB_PRIMER.md`](docs/RGB_PRIMER.md) | RGB concepts and gotchas |
| [`docs/WORKSTREAMS.md`](docs/WORKSTREAMS.md) | who owns what, timeline, git rules |
| [`docs/SETUP.md`](docs/SETUP.md) | environment setup (Windows + WSL2) |
| [`docs/RISKS.md`](docs/RISKS.md) | risks and questions for mentors |
| [`docs/DEMO_SCRIPT.md`](docs/DEMO_SCRIPT.md) | demo and pitch plan, rehearsal checklist |
| [`docs/INTEGRATION_PLAN.md`](docs/INTEGRATION_PLAN.md) | real RGB across four laptops, step by step |
| [`docs/AI_ASSIST_PLAN.md`](docs/AI_ASSIST_PLAN.md) | the AI assist features and their contract |
| [`scripts/regtest/README.md`](scripts/regtest/README.md) | regtest stack and wallet setup commands |
| `CLAUDE.md` in each folder | per-component notes, status and lessons learned |
