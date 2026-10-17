# apps/agent — escrow server (WS3)

The heart of the system, on `:4000`, in WSL2 Ubuntu on the projector laptop. Owns the escrow state
machine, the decision log, the verifier, the agent's own WDK RGB wallet, and the WebSocket feed the UI
renders from. Specs: `docs/ESCROW_FLOW.md` (behaviour), `docs/CONTRACTS.md` (API, events, WS).

## Module layout
```
src/server.ts        Fastify + @fastify/websocket + @fastify/multipart, CORS, routes, startup
src/store.ts         JSON-file store (data/db.json): escrows + events; atomic write (tmp + rename)
src/machine.ts       allowed transitions table + transition(escrow, to, event) → validates, emits ONE LogEvent
src/decide.ts        PURE decide(escrow, results, now): Decision   ← the only place money decisions live
src/orchestrator.ts  drives each step: parse → fund watch → verify → decide → [client review] → pay/refund → settle
src/verifier/        index.ts (runs automatic conditions), tests.ts, hash.ts, present.ts, unpack.ts,
                     excerpt.ts (file tree + text excerpts for /review)
src/ai-client.ts     calls apps/ai (/parse, /explain SSE, /review) with timeouts + template fallback
src/client-token.ts  create clientToken, store its sha256, constant-time check for /approve
src/hub.ts           WebSocket hub: snapshot on connect, broadcast escrow/event/explanation messages
src/ticker.ts        every 5 s: deadlines, pending transfers, stuck states
src/dev.ts           /dev/mine (bitcoind RPC generatetoaddress), /dev/reset
```

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
(fill in)
