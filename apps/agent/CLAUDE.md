# apps/agent — escrow server (WS3)

The heart of the system, on `:4000`, in WSL2 Ubuntu on the projector laptop. Owns the escrow state
machine, the decision log, the verifier, the agent's own WDK RGB wallet, and the WebSocket feed the UI
renders from. Specs: `docs/ESCROW_FLOW.md` (behaviour), `docs/CONTRACTS.md` (API, events, WS).

## Module layout
```
src/server.ts        entry: loads .env.local, listens on 0.0.0.0:AGENT_PORT
src/app.ts           buildApp(): Fastify + websocket + multipart, CORS, routes, ticker (used by tests too)
src/config.ts        env → Config (paths resolve against the repo root)
src/store.ts         JSON-file store (data/db.json): escrows + events; atomic write (tmp + rename)
src/machine.ts       allowed transitions table + transition(escrow, to, event) → validates, emits ONE LogEvent
src/decide.ts        PURE decide(escrow, results, now): Decision   ← the only place money decisions live
src/orchestrator.ts  drives each step: parse → fund watch → verify → decide → [client review] → pay/refund → settle
src/verifier/        index.ts (runs automatic conditions), tests.ts, hash.ts, present.ts, unpack.ts,
                     files.ts (fresh unpack under data/files for the client + path-checked file serving),
                     excerpt.ts (file tree + text excerpts for /review)
src/ai-client.ts     calls apps/ai (/parse, /explain SSE, /review) with timeouts + template fallback
src/client-token.ts  create clientToken, store its sha256, constant-time check for /approve
src/hub.ts           WebSocket hub: snapshot on connect, broadcast escrow/event/explanation messages
src/ticker.ts        every 5 s: deadlines, pending transfers, stuck states
src/dev.ts           /dev/mine (bitcoind RPC generatetoaddress), /dev/reset, auto-mine
src/wallet/          index.ts: loads WS1's @escrow/wallet, else StubWallet (mock only); timeout on every call
src/parse-fallback.ts, src/templates.ts   deterministic parser + explanation text when the AI is down
```

## Status (implemented, `npm test -w apps/agent`: 78 tests)
All tasks 1–7 below are implemented, including client review, and covered by `test/e2e.test.ts`
(fail-then-pass → released, deadline → refunded, validation/reparse/cancel, client review: dispute →
v2 → approve → released, and no answer → released), `test/verifier.test.ts` and `test/decide.test.ts`
(100% coverage: `npm run test:coverage -w apps/agent`). Remaining: real-wallet run on regtest once
WS1's `@escrow/wallet` lands; a real `/review` run against apps/ai once WS2 ships it.

### How the wallet is chosen
- If `@escrow/wallet` is installed and exports `createWallet({ role: 'agent', mode })`, it is used for
  both `mock` (shared-ledger MockWallet) and `real`. **WS1: keep that export name and signature.**
- Otherwise, `WALLET_MODE=mock` uses the in-process `StubWallet`: it cannot see other processes'
  payments, so `POST /escrows/:id/funded` simulates the client's payment. `real` refuses to start.
- `ESCROW_ASSET_ID` empty in mock mode → `mock-tusdt`. Party servers must use the same id.

### Design notes
- Steps are level-triggered from state: `orchestrator.resume(id)` looks at the state and runs the next
  step; the 5 s ticker calls it for every unfinished escrow. Restarts and transient errors need no
  special handling. One runner per escrow; HTTP actions and step commits share a per-escrow mutex.
- Payout/refund safety: `payout.status = 'sending'` is written to disk *before* `wallet.pay()`. If we
  crash or time out mid-call, the agent never re-pays on its own; it logs an error and waits for
  `POST /escrows/:id/retry-step {"force":true}` after a human checked the wallet.
- Refund invoice: a fresh one is requested from `CLIENT_PARTY_URL` (after checking its `/health` says
  `role: client`); the invoice the client attached via `/refund-invoice` is the fallback.
- Error events are de-duplicated per (state, title), so a retried step doesn't flood the log.
- `decide()` releases if every check passed even when verification ends after the deadline (the
  delivery itself was accepted before the deadline; late deliveries get 409).
- Cancel in `AWAITING_FUNDS` is refused once the incoming payment has been seen. A payment that
  arrives after a cancel is not refunded automatically.
- Client review: the client's file browser and the AI review read a **fresh unpack** of the upload
  (`data/files/<id>/<n>/`), never `data/work`, where the freelancer's test command ran and could have
  changed files or planted symlinks. File routes also refuse symlinks and anything outside that folder.
- `/review` and `/explain` share one queue (`AiClient.exclusive`), so the model runs one job at a time.
  The AI's review items are normalised to exactly one per `client_review` condition (unknown ids dropped,
  missing ones `unsure`). If the client answers before the report is ready, the report is discarded.
- The fallback parser turns sentences with words like "look", "colours", "clean", "professional" into
  `client_review` items (max 3), so the client-review demo also works with the AI down.

## Tasks, in order
1. **Skeleton with mocks (by H3).** Store, machine, routes, hub. Use `MockWallet` and `AI_MODE=mock`
   (or a local stub if apps/ai isn't ready). WS4 must be able to drive the whole flow against you by H4.
2. **State machine.** Transition table exactly as in `docs/ESCROW_FLOW.md`. Illegal transitions throw and
   return 409. Per-escrow async mutex so two requests can't race (e.g. double accept).
3. **`decide()`** + exhaustive vitest table tests: all automatic pass and no `client_review` → release;
   all automatic pass with a `client_review` → await_approval; some fail before deadline → retry;
   deadline passed with no passing delivery → refund. In `AWAITING_APPROVAL`: approved → release;
   disputed before deadline → retry; disputed after deadline → refund; no answer past `reviewDueAt` →
   release. Anything else → wait. Full rules in `docs/ESCROW_FLOW.md` step 8. This file has 100% coverage.
   Include a test that flips every `delivery.review` opinion and asserts the decision does not change:
   `decide()` must never read the AI review.
4. **Orchestrator steps.**
   - `POST /escrows`: create the `clientToken` (32 random bytes, hex), store only its sha256, return it
     once in the response. Never put it in `Escrow`, `LogEvent.data`, WS messages or logs.
   - `DRAFT`: call `/parse` → `PROPOSED` with conditions, summary, clarifications, `termsHash`.
   - accept ×2 with matching `termsHash` → `AGREED` → agent `createInvoice(amount)` → `AWAITING_FUNDS`.
   - funding watch: `wallet.waitForTransfer({ recipientId })` (+ auto-mine on regtest when
     `AUTO_MINE=true`) → `FUNDED`. Log `funding.payment_seen` when first seen pending, `funding.settled` when settled.
   - delivery upload → store file → `DELIVERED` → `VERIFYING` → verifier → one `verify.condition_result`
     event per condition → `verify.finished` → `decide()` → `decision.made`.
   - client review (when `decide()` returns `await_approval`): `AWAITING_APPROVAL`, set
     `delivery.reviewDueAt = now + REVIEW_WINDOW_SEC`, then **without blocking** build excerpts and call
     `/review` (timeout `AI_REVIEW_TIMEOUT_MS`); store the `AiReview` on the delivery and emit
     `review.report_ready`. On AI failure store a template report (every item `unsure`).
   - `POST /escrows/:id/approve`: zod-validate; `403` unless the `clientToken` matches; `409` unless the
     state is `AWAITING_APPROVAL` and `deliveryN` is the latest delivery; `400` for a dispute without
     `reason`. Store `delivery.approval`, emit `review.approved` / `review.disputed`, then `decide()` →
     `decision.made` → release, retry (`FUNDED`) or refund.
   - release: `wallet.pay(payoutInvoice)` → `RELEASING` → wait settled → `RELEASED`.
     refund: same with `refundInvoice` → `REFUNDING` → `REFUNDED`.
   - Every wallet/AI failure → `error` event with a human-readable title; the escrow stays in a state
     from which the step can be retried (add `POST /escrows/:id/retry-step` if needed).
5. **Verifier.**
   - `unpack.ts`: accept `.zip` (extract to `data/work/<escrowId>/<n>/`, reject absolute paths and `..`)
     or a single file. Max upload 20 MB.
   - `tests.ts`: `spawn(command, { shell: true, cwd, timeout })`, env = minimal (`PATH`, `HOME`, no secrets),
     kill process tree on timeout, keep last 40 lines of combined output. Do **not** run `npm install`;
     demo deliverables are dependency-free. Stretch: run inside `docker run --rm --network none node:22`.
   - `hash.ts`: sha256 of the named file (or the upload) vs expected, lowercase hex.
   - `present.ts`: glob match inside the unpacked folder (`fast-glob`).
   - `index.ts` skips `client_review` conditions (no `VerificationResult` for them).
   - `excerpt.ts`: list the unpacked files (`{ path, sizeBytes }`) and add the first few KB of each text
     file as `excerpt`; skip binaries; cap the total (~12 KB) so it fits the 2B model's context.
   - Delivery file routes: `GET /escrows/:id/deliveries/:n/files` (list) and `.../files/*` (raw file,
     path-checked like `unpack.ts`, with `Content-Security-Policy: sandbox` and `X-Content-Type-Options:
     nosniff`) so the client can look at the work without the page being able to call the agent API.
6. **Explanations.** After emitting an event with `explain: true`, call `/explain` (SSE) without blocking
   the flow; forward deltas as `explanation_delta`, then store the final text in the event and send
   `explanation_done`. Timeout or error → template text, `source: 'template'`.
7. **Ticker + dev routes.** Deadlines → `decide()`; `AWAITING_APPROVAL` past `reviewDueAt` →
   `review.expired` → `decide()` → release; retry stuck refresh loops; `/dev/mine` via bitcoind
   JSON-RPC (`BITCOIND_RPC_URL`, `BITCOIND_RPC_USER`, `BITCOIND_RPC_PASS`) mining to the agent wallet's
   address; `/dev/reset` only when `NODE_ENV !== 'production'`.

## Which events get `explain: true`
`terms.proposed`, `terms.agreed`, `funding.settled`, `verify.condition_result` (failures only),
`decision.made`, `review.disputed`, `review.expired`, `payout.settled`, `refund.settled`, `error`.
Everything else is self-explanatory — keep the model free for the moments the audience is watching.
(`review.report_ready` does not need an explanation: the report itself is the AI's text.)

## Done when
`npm run dev:mock` + `apps/web` completes: create → propose → accept ×2 → fund → deliver v1 (fail,
explained) → deliver v2 (pass) → released, with every step visible live in the agent view. Then the
same with `WALLET_MODE=real` on regtest.
Client review: an agreement with a `client_review` reaches `AWAITING_APPROVAL` after the automatic checks
pass, shows QVAC's report, and ends in release on approve, `FUNDED` on dispute, and release when the
review window runs out. `/approve` without the right `clientToken` returns `403`.

## Learned the hard way
- On WSL2 (mirrored networking) a connection to a closed localhost port **hangs** instead of being
  refused. Without a health probe, a down `apps/ai` cost the full 90 s parse timeout per escrow. The AI
  client now probes `/health` (2 s, cached 10 s) and goes straight to the fallback/template when down.
- zod 4 runs `.refine()` even after an earlier check failed: `BigInt('1.5')` inside a refine threw
  and became a 500. Guard refines (`/^\d+$/.test(a) && BigInt(a) > 0n`).
- adm-zip ≤ 0.6.0 has several extraction CVEs (symlinks, setuid, zip bombs). We pin ≥ 0.6.1 and still
  check every entry path ourselves and write plain files with mode 0644.
- `spawn(..., { detached: true })` + `process.kill(-pid)` is what kills the whole test process tree;
  `timeout` alone only kills the shell. We also kill the group after a normal exit (no orphans).
- `pkill -f <pattern>` in a shell whose own command line contains the pattern kills that shell.
  Stop the dev server by port: `ss -ltnp | grep 4000`.
