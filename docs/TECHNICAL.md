# Technical overview (as built)

How the escrow agent works as of the submission (October 18, 2026). The planning documents describe what we
set out to build; this one describes what the code does. Specs that are still authoritative are linked:
[`CONTRACTS.md`](CONTRACTS.md) (every type, event and route), [`ESCROW_FLOW.md`](ESCROW_FLOW.md) (state
machine), [`AI_ASSIST_PLAN.md`](AI_ASSIST_PLAN.md) (assist features). Screens: [`UI.md`](UI.md).

## 1. Components

One npm workspace, TypeScript (strict, ESM) everywhere, run with `tsx` (no build step for servers).

| Package | Port | Role | Key files |
| ------- | ---- | ---- | --------- |
| `packages/shared` | – | The contract: zod schemas (types derived with `z.infer`), route constants, event types, amount and fee helpers, canonical JSON + `termsHash` (pure-JS sha256, so browsers can check it), `examples` test rendering, assist schemas. No I/O, no Node-only APIs. | `domain.ts`, `events.ts`, `api.ts`, `amount.ts`, `hash.ts`, `assist.ts`, `examples.ts` |
| `packages/wallet` | – | `EscrowWallet` implementations: `RgbWdkWallet` (Tether WDK + RGB) and `MockWallet` (shared JSON ledger). `createWallet({ role, mode })` picks one from `WALLET_MODE`. | `rgb-wdk-wallet.ts`, `mock-wallet.ts`, `treasury.ts`, `factory.ts` |
| `apps/agent` | 4000 | The escrow service. Owns the state machine, the verifier, `decide()`, the agent's wallet, the decision log and the WebSocket feed. | `orchestrator.ts`, `machine.ts`, `decide.ts`, `verifier/`, `hub.ts`, `ticker.ts` |
| `apps/ai` | 4300 | QVAC service: `/parse`, `/explain` (SSE), `/explain/sync`, `/review`, `/assist/*`. Runs on native Windows for the GPU. | `llm.ts`, `parse.ts`, `postprocess.ts`, `fallback.ts`, `review.ts`, `explain.ts`, `mock.ts` |
| `apps/party` | 4101 / 4102 | One person's wallet server (client or freelancer role). Invoices, payments, balances, signatures, auto-pay. | `app.ts`, `wallet.ts`, `refresh-loop.ts`, `autopay.ts` |
| `apps/market` | 5174 | Marketplace UI (the demo UI). | see [`UI.md`](UI.md) |
| `apps/web` | 5173 | Three-screen UI (client / freelancer / projector). | see [`UI.md`](UI.md) |
| `scripts/` | – | Regtest Docker stack; `setup-demo.ts`, `setup-role.ts`, `reset-demo.ts`. | `regtest/compose.yaml` |

Regtest stack (Docker, on the agent laptop): bitcoind (18443), electrs (50001), RGB proxy server (3000).

### Who talks to whom

```
 browser ──HTTP + WebSocket──▶ apps/agent :4000 ──HTTP──▶ apps/ai :4300 (QVAC)
    │                              │  └── agent's own WDK wallet ──┐
    └──HTTP (same laptop only)──▶ apps/party :4101/:4102           │
                                   └── party's WDK wallet ─────────┤
                                                                   ▼
                                       electrs :50001 + RGB proxy :3000 + bitcoind (regtest)
```

- The browser talks to the agent for everything about a job, and to **its own laptop's** party server for
  everything about its own money.
- The agent calls the AI service and, for refund invoices, the client's party server (`/wallet/invoice`).
  It never reads a party's balance.
- Every wallet reaches the shared indexer and RGB proxy over the LAN.

## 2. Escrow lifecycle

States (`EscrowState`): `DRAFT → PROPOSED → OPEN → AGREED → AWAITING_FUNDS → FUNDED → DELIVERED → VERIFYING →
[AWAITING_APPROVAL] → RELEASING → RELEASED`, with exits `REFUNDING → REFUNDED` and `CANCELLED`. `OPEN` exists
for the marketplace; the original two-party flow (`PROPOSED → AGREED` when both accept) still works.

| From | To | Trigger |
| ---- | -- | ------- |
| `DRAFT` | `PROPOSED` | AI (or fallback parser) returned conditions; agent computes `termsHash` |
| `PROPOSED` / `OPEN` | `DRAFT` | client edits the description (`/reparse`): new terms, acceptances void |
| `PROPOSED` | `OPEN` | client publishes (`/publish`) = client accepts `termsHash`; needs ≥ 1 automatic check |
| `OPEN` | `AGREED` → `AWAITING_FUNDS` | a freelancer takes it (`/take`) or the client accepts a counteroffer; agent creates the funding invoice |
| `AWAITING_FUNDS` | `FUNDED` | the agent's wallet sees the incoming transfer settled |
| `AWAITING_FUNDS` | `OPEN` | not funded by `fundingDueAt`, or the payment failed (`decide()` → `reopen`) |
| `FUNDED` | `DELIVERED` → `VERIFYING` | freelancer uploads work + payout invoice |
| `VERIFYING` | `FUNDED` | a check failed, before the deadline (`retry`) |
| `VERIFYING` | `AWAITING_APPROVAL` | all automatic checks passed, terms have client-review items |
| `VERIFYING` / `AWAITING_APPROVAL` | `RELEASING` | all passed and no review items / client approved / review window expired |
| `AWAITING_APPROVAL` | `FUNDED` / `REFUNDING` | client disputed before / after the deadline |
| `FUNDED` | `REFUNDING` | deadline passed without a passing delivery |
| any state before `FUNDED` | `CANCELLED` | either party cancels (marketplace jobs: with their token; in `AWAITING_FUNDS` only until the payment is seen), or an `OPEN` listing reaches its deadline with no taker (`decide()` → `cancel`) |

**Rules the code enforces**
- **Every state has an exit with a timeout.** The ticker (every 5 s) calls `decide()` for deadlines,
  `reviewDueAt`, `fundingDueAt` and offer expiry. Nothing can wait forever.
- **Exactly one `LogEvent` per state change**, with a title written by code. Error events are de-duplicated
  per (state, title).
- **Level-triggered steps.** `orchestrator.resume(id)` looks at the state and runs the next step; a restart
  or a transient error needs no special handling. One runner per escrow, plus a per-escrow mutex shared with
  the HTTP actions.
- **Clock safety.** Money deadlines use `safeNow()`: the earlier of the wall clock and a monotonic clock
  anchored at startup. A wall-clock jump can only make a release or refund late, never early.

### `decide()`: the only place money decisions are made
A pure function of the escrow (state, deadlines, automatic results, the client's answer) and the time
(`apps/agent/src/decide.ts`). Outcomes: `release`, `retry`, `refund`, `await_approval`, `cancel`, `reopen`,
`wait`. It never reads the AI review; a test flips every AI opinion and asserts the decision is unchanged.
It has 100 % test coverage.

## 3. Money flow

All amounts are integer base units in decimal strings (JSON) and `bigint` in code. Display formatting happens
only in the UIs.

| Step | Payer → payee | Amount | Invoice from |
| ---- | ------------- | ------ | ------------ |
| Funding | client → agent | `amount + fee` (`escrowTotal`) | agent wallet, expires at `fundingDueAt` |
| Release | agent → freelancer | `amount` (the service keeps `fee`) | freelancer wallet, fresh per delivery |
| Refund | agent → client | `amount + fee` | client wallet, attached at funding (valid until a day after the deadline) |

- **Fee:** `serviceFee(amount)` = 2 % rounded up, at least 1 base unit. It is part of the terms, so it is
  inside `termsHash` (`{ title, amount, fee, assetId, deadline, conditions }`).
- **Settlement never waits for a person.** The refund invoice is attached when the job is funded and the
  payout invoice with each delivery, so the agent can always pay out or refund on its own.
- **Auto-pay.** Publishing a listing pre-authorises the client's own party server (`POST /autopay`). When the
  job is taken, that server attaches the refund invoice and pays exactly `escrowTotal()`: never more, never
  twice for one invoice. State in `apps/party/data/<role>/autopay.json`; a payment interrupted by a crash is
  marked failed, never retried blindly.
- **A payment on its way is never abandoned.** The agent records a payment it sees *before* checking the
  funding window, and refuses a cancel while the wallet shows an incoming payment for the job's invoice. Either
  way, a job whose money is arriving cannot reopen or close, which would make auto-pay pay a second time.
- **No double payout.** Before `wallet.pay()` the agent writes `payout.status = 'sending'` to disk. If it
  crashes or times out mid-call, it does not pay again on its own; it logs an error and waits for a human
  to check the wallet and call `POST /escrows/:id/retry-step { "force": true }`.
- **RGB settlement.** A transfer only advances when both sides refresh. Party servers refresh while a
  transfer is pending and until each invoice they handed out expires; the agent's `waitForTransfer` polls
  `refreshWallet` + `listTransfers`, and with `AUTO_MINE=true` mines a block after each payment. Each side
  settles at its own `minConfirmations`. Details: `packages/wallet/CLAUDE.md`.

## 4. Verifier

`apps/agent/src/verifier/`. Runs only **automatic** conditions; `client_review` gets no result.

| Condition | Passes when |
| --------- | ----------- |
| `tests_pass` | the command (e.g. `npm test`) exits 0 in the unpacked delivery |
| `file_present` | the glob matches a file in the delivery (`fast-glob`) |
| `file_hash` | sha256 of the named file (or the whole upload) equals the agreed hash |
| `examples` | the agreed inputs → outputs, rendered by `renderExamplesTest()` into a `node:test` file in a fresh temp folder, all pass: exit 0 **and** the runner's summary counts every case as passed |

- **Unpacking:** `.zip` or a single file, max 20 MB; entry paths are checked (no absolute paths, no `..`,
  no symlinks), files written as plain 0644 (adm-zip ≥ 0.6.1).
- **Running code:** `spawn` with a minimal environment (`PATH`, `HOME`, no secrets), a timeout, and the
  whole process group killed afterwards. The last 40 lines of output are kept as evidence. No container.
- **Client review reads a fresh unpack** (`data/files/<id>/<n>/`), never the folder the tests ran in, which
  the freelancer's code could have changed.
- **Practice check** (`POST /escrows/:id/dry-run`): the same verifier on an upload that is not submitted, plus
  QVAC hints for failures. No state change.

## 5. AI service (QVAC)

`@qvac/sdk` 0.21.0, Qwen3.5 2B Q4 on GPU (Vulkan), Qwen3.5 0.8B as fallback. The model loads once at startup
with a warm-up; `/health` reports `loaded` and the model name, which the agent forwards as `aiModel`.

| Route | Output | Guards and fallback |
| ----- | ------ | ------------------- |
| `/parse` | conditions, summary, clarifications | JSON-schema structured output, thinking off; every file, command, hash and quote must appear literally in the agreement; a deterministic parser cross-checks and is the fallback (shared with the agent, so the agent can parse locally when the AI is down) |
| `/explain` (SSE) | 1–2 plain sentences per log event, streamed | rewrites a correct template sentence; `isGrounded` rejects unknown numbers, money words and pass/fail flips; template on timeout |
| `/review` | `looks_met` / `looks_unmet` / `unsure` per client-review item | excerpts fenced as untrusted data, instructions inside ignored; notes may mention only real files; template (all `unsure`) on failure |
| `/assist/*` | clarify, rewrite, estimate, answer, hint, match, split | each has a deterministic fallback and `source: 'ai' \| 'fallback'` |

- **The AI never moves money.** Its output is a proposal people approve (`/parse`), text (`/explain`), or
  advice (`/review`, `/assist/*`). `decide()` reads none of it.
- **Timeouts everywhere.** The agent probes AI `/health` (2 s, cached) and skips straight to fallbacks when
  it is down; per-call budgets come from `.env` (`AI_PARSE_TIMEOUT_MS`, `AI_EXPLAIN_TIMEOUT_MS`,
  `AI_REVIEW_TIMEOUT_MS`, `AI_ASSIST_TIMEOUT_MS`), and the AI answers 5 s before each.
- **One job at a time.** `/review` and `/explain` share one queue in the agent, so the small model is never
  asked two things at once.
- **Measured** (GTX 1650, 4 GB): 2B ≈ 65 tokens/s, `/parse` 3.3 s average, `/explain` 0.5–1 s. Evals on the live
  model: `/parse` 17/17 (`fixtures/agreements.json`), `/explain` 15/16, `/review` 8/8 per landing fixture.

## 6. Security and trust model

- **Tokens instead of accounts.** `POST /escrows` returns a one-time `clientToken`; `/take` returns a
  `freelancerToken`; a counteroffer returns an `offerToken`. The agent stores only their sha256 and compares in
  constant time. They are never in `Escrow`, log events or WebSocket messages, which everyone receives.
  Approving, editing, cancelling and delivering on marketplace jobs need the right token, in the body, or in
  the `x-escrow-token` header for file requests (never in a URL: URLs are logged).
- **Exact terms.** Acceptances are stored against a `termsHash`; any change produces a new hash and voids
  earlier acceptances. `apps/web` recomputes the hash in the browser from the terms on screen and refuses to
  accept on a mismatch.
- **Private balances.** A party server answers `/wallet`, `/wallet/pay`, `/wallet/transfers`, `/wallet/sign`
  and `/autopay` only to loopback requests whose `Origin` is `localhost`/`127.0.0.1`/`[::1]` (the loopback
  check alone is not enough, since any site open in a local browser is loopback). Only `/health`,
  `/wallet/invoice` and `/wallet/refresh` answer the LAN. The agent's `/wallet` is its own wallet only.
- **Delivered files are sandboxed.** Served with `Content-Security-Policy: sandbox` and `nosniff`; `apps/web`
  opens them in `<iframe sandbox>` without `allow-same-origin`, so a delivered web page cannot run scripts
  against the agent. `apps/market` shows files as blob URLs, which run on its own (trusted, localhost) origin,
  so only PNG/JPEG/GIF/WebP keep their type; everything else, SVG included, becomes a download that never
  renders. Before release the client sees image previews only; everything after `RELEASED`.
- **Operator routes are local.** `POST /dev/reset` and `retry-step` with `force` (re-send a payment whose
  outcome is unknown) answer only the agent's own laptop (loopback), never the venue network.
- **Untrusted deliveries.** Nothing inside a delivery can change the outcome: checks are mechanical, and the
  AI review is advice the client reads next to the files themselves (a `landing-inject` fixture tests this).
- **Secrets.** Mnemonics live only in each laptop's `.env.local`, never logged or committed; one wallet data
  folder per process.
- **Known limits.** Other routes trust the `role` in the body (LAN demo). A client can dispute every delivery
  until the deadline (real platforms use arbitration). The verifier is not a container sandbox.

## 7. Real-time feed

`ws://<agent>:4000/ws?escrowId=<id>` (omit `escrowId` for every job). Messages (`WsMessage`): `snapshot`
(escrow + its whole log, on connect), `escrow` (new escrow state), `event` (a new log event),
`explanation_delta` / `explanation_done` (QVAC text streaming into an event). The UIs render only from a
reducer over these messages and reconnect with backoff; the marketplace also re-reads `GET /escrows` every
15 s so lists stay complete.

## 8. Persistence and configuration

| Data | Where |
| ---- | ----- |
| Escrows + log | `AGENT_DATA_DIR/db.json`, written atomically (tmp + rename); kept across restarts on purpose |
| Uploaded and unpacked deliveries | `AGENT_DATA_DIR/deliverables`, `work`, `files` |
| Wallets | `RGB_DATA_DIR/<role>`, one per process; mock mode: `MOCK_LEDGER_PATH` |
| Auto-pay authorisations | `apps/party/data/<role>/autopay.json` (mode 0600) |
| Browser tokens | `localStorage` per escrow (marketplace and `apps/web`) |

Every process reads only the variables in `.env.example` (per-laptop values in `.env.local`). The ones that
change behaviour most: `WALLET_MODE`, `AI_MODE`, `RGB_NETWORK` / endpoints, `ESCROW_ASSET_ID`, `AUTO_MINE`,
`REVIEW_WINDOW_SEC`, `FUNDING_WINDOW_SEC`, `OFFER_WINDOW_SEC`, `AI_EXAMPLES`, the AI timeouts, and the
`*_PARTY_URL` / `AI_URL` / `VITE_*` addresses.

## 9. Testing

`npm test` runs vitest in every workspace; `npm run typecheck` runs `tsc --noEmit` everywhere.

| Workspace | What is covered |
| --------- | --------------- |
| `packages/shared` | amounts and fee, canonical JSON / `termsHash` (key-order independent, matches `node:crypto`), schemas, assist contract |
| `packages/wallet` | `MockWallet` across processes, pending → settled/failed, RGB status mapping; `RGB_IT=1` runs a real invoice → pay → mine → settled test on regtest |
| `apps/agent` | `decide()` (every outcome, 100 % coverage), state machine, verifier (zip safety, timeouts, `examples`), marketplace flow, client review, clock safety, assist proxy, full end-to-end flows with an injected wallet |
| `apps/ai` | parse guards and fallback, explanations, review guards (colours, prompt injection), assist fallbacks, server routes |
| `apps/party` | routes, privacy checks, auto-pay (never pays twice) |
| `apps/market`, `apps/web` | stream reducers, display rules, terms hash check, assist client, render smoke tests |

Live checks beyond unit tests: the integration runs in [`INTEGRATION_PLAN.md`](INTEGRATION_PLAN.md) (real
wallets on regtest across laptops, AI on its own laptop) and `npm run eval -w apps/ai` against the live model.
