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
src/orchestrator.ts  drives each step: parse → fund watch → verify → decide → pay/refund → settle
src/verifier/        index.ts (runs all conditions), tests.ts, hash.ts, present.ts, unpack.ts
src/ai-client.ts     calls apps/ai (/parse, /explain SSE) with timeouts + template fallback
src/hub.ts           WebSocket hub: snapshot on connect, broadcast escrow/event/explanation messages
src/ticker.ts        every 5 s: deadlines, pending transfers, stuck states
src/dev.ts           /dev/mine (bitcoind RPC generatetoaddress), /dev/reset
```

## Tasks, in order
1. **Skeleton with mocks (by H3).** Store, machine, routes, hub. Use `MockWallet` and `AI_MODE=mock`
   (or a local stub if apps/ai isn't ready). WS4 must be able to drive the whole flow against you by H4.
2. **State machine.** Transition table exactly as in `docs/ESCROW_FLOW.md`. Illegal transitions throw and
   return 409. Per-escrow async mutex so two requests can't race (e.g. double accept).
3. **`decide()`** + exhaustive vitest table tests: all pass → release; some fail before deadline → retry;
   deadline passed with no passing delivery → refund; anything else → wait. This file has 100% coverage.
4. **Orchestrator steps.**
   - `DRAFT`: call `/parse` → `PROPOSED` with conditions, summary, clarifications, `termsHash`.
   - accept ×2 with matching `termsHash` → `AGREED` → agent `createInvoice(amount)` → `AWAITING_FUNDS`.
   - funding watch: `wallet.waitForTransfer({ recipientId })` (+ auto-mine on regtest when
     `AUTO_MINE=true`) → `FUNDED`. Log `funding.payment_seen` when first seen pending, `funding.settled` when settled.
   - delivery upload → store file → `DELIVERED` → `VERIFYING` → verifier → one `verify.condition_result`
     event per condition → `verify.finished` → `decide()` → `decision.made`.
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
6. **Explanations.** After emitting an event with `explain: true`, call `/explain` (SSE) without blocking
   the flow; forward deltas as `explanation_delta`, then store the final text in the event and send
   `explanation_done`. Timeout or error → template text, `source: 'template'`.
7. **Ticker + dev routes.** Deadlines → `decide()`; retry stuck refresh loops; `/dev/mine` via bitcoind
   JSON-RPC (`BITCOIND_RPC_URL`, `BITCOIND_RPC_USER`, `BITCOIND_RPC_PASS`) mining to the agent wallet's
   address; `/dev/reset` only when `NODE_ENV !== 'production'`.

## Which events get `explain: true`
`terms.proposed`, `terms.agreed`, `funding.settled`, `verify.condition_result` (failures only),
`decision.made`, `payout.settled`, `refund.settled`, `error`. Everything else is self-explanatory —
keep the model free for the moments the audience is watching.

## Done when
`npm run dev:mock` + `apps/web` completes: create → propose → accept ×2 → fund → deliver v1 (fail,
explained) → deliver v2 (pass) → released, with every step visible live in the agent view. Then the
same with `WALLET_MODE=real` on regtest.

## Learned the hard way
(fill in)
