# packages/shared — `@escrow/shared`

Owner: **WS3** (gatekeeper). Built by the whole team together at H0, in ~45 minutes.

## Purpose
The single source of truth for everything that crosses a process boundary: domain types, zod schemas,
log event types, WebSocket messages, HTTP route constants, the wallet interface, and small pure helpers.
No runtime dependencies besides `zod`. **No Node-only APIs at all**, so `apps/web` can import it:
`hash.ts` has a small pure-JS sha256 (tested against `node:crypto`), so the UI can recompute `termsHash`.

## Build it from `docs/CONTRACTS.md`
Create these files, translating the spec 1:1. Every type gets a zod schema; derive the TS type with
`z.infer` so they can never drift.

```
src/domain.ts      Role, EscrowState, Condition (discriminated union), Acceptance, Delivery,
                   VerificationResult, Decision, Escrow, Approval, AiReview  (+ schemas)
src/events.ts      Actor, LogEventType, LogEvent, WsMessage  (+ schemas)
src/wallet.ts      WalletInfo, AssetBalance, TransferStatus, TransferSummary, EscrowWallet (interface only)
src/api.ts         request/response schemas for every route in CONTRACTS.md §4, and route constants:
                   export const AGENT_ROUTES = { escrows: '/escrows', escrow: (id) => `/escrows/${id}`, ... }
                   export const AI_ROUTES = ...; export const PARTY_ROUTES = ...
src/ai.ts          ParseRequest, ParseResult, ExplainRequest, ReviewRequest (+ schemas)
src/amount.ts      toBaseUnits("50", 6) -> "50000000"; formatAmount("50000000", 6) -> "50"; bigint-safe
src/hash.ts        canonicalJson(obj) (sorted keys, no whitespace), termsHash(escrow), sha256Hex(buf)
src/ids.ts         newEscrowId() -> "esc_" + 4 hex chars; eventId(escrowId, seq) -> "esc_7f3a:0007"
src/index.ts       re-export everything
```

## Package setup
- `package.json`: `"name": "@escrow/shared"`, `"type": "module"`, `"main": "./src/index.ts"`,
  `"exports": { ".": "./src/index.ts" }` — consumers run via `tsx`, so no build step is needed.
- Tests: `vitest` for `amount.ts` and `hash.ts` (canonicalJson must be key-order independent;
  formatAmount must handle precision 0 and trailing zeros).

## Rules
- Adding an **optional** field: allowed for anyone, tell the team in chat.
- Renaming/removing/changing a field or a route: only via `.claude/commands/contract-change.md`,
  merged by WS3, announced in chat, and `docs/CONTRACTS.md` updated in the same commit.
- Keep this package boring: no classes with behaviour, no I/O, no environment variables.

## Client review (landed on `ws/agent`)
Done: `client_review` (+ `isAutomaticCondition`), `AWAITING_APPROVAL`, `Approval`, `AiReview`, `await_approval`,
`review.*` events, `ReviewRequest`, `DeliveryFile`, `ApproveRequestSchema`, `CreateEscrowResponseSchema`,
`AGENT_ROUTES.approve / deliveryFiles / deliveryFile`, `AI_ROUTES.review`. Originally specified as one
contract change, merged by WS3, adding everything in `docs/CONTRACTS.md` marked for client review:
the `client_review` condition kind (also in `CONDITION_KINDS`), state `AWAITING_APPROVAL`, `Delivery`
fields `reviewDueAt` / `review` / `approval`, `Approval`, `AiReview`, the `await_approval` decision,
the four `review.*` event types, `ReviewRequest`, `ApproveRequest`, the `POST /escrows` response
`Escrow & { clientToken }`, and route constants for `/approve`, the delivery file routes and AI `/review`.
`clientToken` must never be a field of `EscrowSchema`: escrows are broadcast to everyone.
Breaking for anyone with an exhaustive `switch` over `EscrowState`, `Condition['kind']`, `Decision['action']`
or `LogEventType` (e.g. `apps/ai` `TEMPLATES`): they must handle the new values.
