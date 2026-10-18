# Contracts between components

This file is the **specification for `packages/shared`**. At hour 0 the whole team turns it into code
(`packages/shared/src/*.ts`, with zod schemas). After that, `packages/shared` is the source of truth and
this file is updated alongside it. Changing a contract follows `.claude/commands/contract-change.md`.

All JSON amounts are integer base units as **decimal strings**. All timestamps are ISO-8601 strings (UTC).

## 1. Core domain types (`packages/shared/src/domain.ts`)

```ts
export type Role = 'client' | 'freelancer' | 'agent';

export type EscrowState =
  | 'DRAFT' | 'PROPOSED' | 'OPEN' | 'AGREED' | 'AWAITING_FUNDS' | 'FUNDED'
  | 'DELIVERED' | 'VERIFYING' | 'AWAITING_APPROVAL' | 'RELEASING' | 'RELEASED'
  | 'REFUNDING' | 'REFUNDED' | 'CANCELLED';
// OPEN (marketplace): the client approved the requirements (= accepted the termsHash); the listing waits
// for a freelancer. Exits: taken → AGREED, edited → DRAFT, cancelled or past its deadline → CANCELLED.

/**
 * An acceptance condition. Discriminated on `kind`. The verifier checks `tests_pass`, `file_hash`,
 * `file_present` and `examples` automatically; `client_review` is judged by the client, after QVAC writes an
 * advisory report.
 */
export type Condition =
  | {
      id: string;                 // "c1", "c2", ...
      kind: 'tests_pass';
      description: string;        // human sentence shown in the UI
      command: string;            // e.g. "npm test" — run in the unpacked deliverable
      timeoutSec: number;         // default 60
    }
  | {
      id: string;
      kind: 'file_hash';
      description: string;
      fileName?: string;          // which file inside the deliverable; whole upload if absent
      sha256: string;             // lowercase hex, 64 chars
    }
  | {
      id: string;
      kind: 'file_present';
      description: string;
      pathPattern: string;        // glob inside the unpacked deliverable, e.g. "README.md"
    }
  | {
      id: string;
      kind: 'client_review';
      description: string;        // what the client judges, e.g. "The logo uses warm colours"
    }
  | {
      id: string;
      kind: 'examples';           // agreed inputs → expected outputs (packages/shared/src/examples.ts)
      description: string;
      target: { type: 'js_function'; export: string; file?: string } | { type: 'command'; command: string };
      cases: { input: string; expected: string }[]; // 1–10
      timeoutSec: number;
    };

export interface Acceptance {
  role: 'client' | 'freelancer';
  termsHash: string;
  at: string;
  signature?: string;            // optional BIP-322 signature over termsHash
  address?: string;              // signer's address, if signed
}

export interface Escrow {
  id: string;                    // short id, e.g. "esc_7f3a"
  title: string;
  rawText: string;               // the original plain-language agreement
  amount: string;                // base units; the freelancer's reward
  fee?: string;                  // service fee, serviceFee(amount); part of the terms; absent = 0
  assetId: string;               // RGB asset id (never a ticker)
  assetTicker: string;           // display only, e.g. "tUSDT"
  precision: number;             // display only, e.g. 6
  deadline: string;
  state: EscrowState;
  summary?: string;              // AI one-paragraph summary of the terms
  clarifications?: string[];     // things the AI could not turn into checks
  conditions: Condition[];
  termsHash?: string;
  acceptances: Acceptance[];
  fundingInvoice?: string;       // agent's receive invoice
  refundInvoice?: string;        // client's receive invoice
  payoutInvoice?: string;        // freelancer's receive invoice (latest delivery)
  fundingDueAt?: string;         // set when a freelancer takes the listing: now + FUNDING_WINDOW_SEC
  offers?: Offer[];              // counteroffers on the listing, newest last (public)
  deliveries: Delivery[];
  createdAt: string;
  updatedAt: string;
}

// A freelancer's counteroffer on an OPEN listing: the same job for a lower reward. Making it = that
// freelancer accepting `termsHash` (the listing's terms with this amount and fee). The client accepting it
// agrees to the same hash → AGREED. Pending until expiresAt = min(now + OFFER_WINDOW_SEC, deadline);
// declined when the listing is taken, edited or closed.
export interface Offer {
  id: string;                    // "o1", "o2", ... per escrow
  amount: string;                // lower than the listing's amount
  fee: string;                   // serviceFee(amount)
  termsHash: string;
  note?: string;                 // ≤ 500 chars
  at: string;
  expiresAt: string;
  status: 'pending' | 'accepted' | 'declined' | 'expired' | 'withdrawn';
  closedAt?: string;
}

export interface Delivery {
  n: number;                     // 1, 2, 3...
  fileName: string;
  sha256: string;
  sizeBytes: number;
  at: string;
  results?: VerificationResult[];
  reviewDueAt?: string;          // set on entering AWAITING_APPROVAL: now + REVIEW_WINDOW_SEC
  review?: AiReview;             // QVAC's advisory report on the client_review conditions (display only)
  approval?: Approval;           // the client's answer for this delivery
}

/** The client's answer to a delivery in AWAITING_APPROVAL. */
export interface Approval {
  decision: 'approve' | 'dispute';
  at: string;
  reason?: string;               // required for 'dispute'; shown to the freelancer
}

/** QVAC's opinion on each client_review condition. Shown to people, never read by decide(). */
export interface AiReview {
  items: {
    conditionId: string;         // a client_review condition id
    opinion: 'looks_met' | 'looks_unmet' | 'unsure';
    note: string;                // 1–2 sentences; may only mention files that exist in the delivery
  }[];
  source: 'ai' | 'template';     // 'template' = AI unavailable, every item 'unsure'
  model?: string;
  ms: number;
}

/** One per automatic condition. `client_review` conditions never get a VerificationResult. */
export interface VerificationResult {
  conditionId: string;
  passed: boolean;
  evidence: {
    exitCode?: number;
    stdoutTail?: string;         // last ~40 lines
    actualSha256?: string;
    matched?: string[];          // for file_present
    durationMs: number;
    error?: string;              // infrastructure error (timeout, unzip failed...)
  };
}

export type Decision =
  | { action: 'release'; reason: string }
  | { action: 'retry'; reason: string; failed: string[] }
  | { action: 'refund'; reason: string }
  | { action: 'await_approval'; reason: string; pending: string[] } // client_review condition ids
  | { action: 'cancel'; reason: string }   // OPEN listing past its deadline (no money moves)
  | { action: 'reopen'; reason: string }   // AWAITING_FUNDS not funded by fundingDueAt (no money moves)
  | { action: 'wait'; reason: string };
```

The client's `clientToken` and the freelancer's `freelancerToken` (§4) are never part of `Escrow`:
escrows are broadcast to every WebSocket client.

**Fees** (`packages/shared/src/amount.ts`): `serviceFee(reward)` = 2 % (`SERVICE_FEE_PERCENT`) rounded up to a
whole base unit, at least 1. `escrowTotal(e)` = `amount + fee`. The client escrows the total; release pays the
freelancer `amount` (the service keeps `fee`); refund returns the total. `termsHash` covers
`{ title, amount, fee, assetId, deadline, conditions }`; an absent `fee` is left out, so older terms keep their hash.

## 2. Decision log (`packages/shared/src/events.ts`)

```ts
export type Actor = 'client' | 'freelancer' | 'agent' | 'ai' | 'verifier' | 'wallet' | 'system';

export type LogEventType =
  | 'escrow.created' | 'terms.proposed' | 'terms.reparse_requested' | 'terms.accepted' | 'terms.agreed'
  | 'listing.published'                                    // PROPOSED → OPEN
  | 'offer.made' | 'offer.withdrawn' | 'offer.declined' | 'offer.expired' // counteroffers (accepted = terms.agreed)
  | 'funding.invoice_created' | 'funding.payment_seen' | 'funding.settled'
  | 'funding.reopened'                                     // AWAITING_FUNDS → OPEN (window over / payment failed)
  | 'delivery.received' | 'verify.started' | 'verify.condition_result' | 'verify.finished'
  | 'decision.made'
  | 'review.report_ready' | 'review.approved' | 'review.disputed' | 'review.expired'
  | 'payout.sent' | 'payout.settled' | 'refund.sent' | 'refund.settled'
  | 'escrow.cancelled' | 'error';

export interface LogEvent {
  id: string;                    // monotonic per escrow, e.g. "esc_7f3a:0007"
  escrowId: string;
  at: string;
  actor: Actor;
  type: LogEventType;
  title: string;                 // short, deterministic, written by code (never by the LLM)
  data?: Record<string, unknown>;// txid, invoice, condition id, amounts...
  explain: boolean;              // should the AI add a plain-language explanation?
  explanation?: string;          // filled in (streamed) by the AI afterwards
  explanationSource?: 'ai' | 'template';
}
```

Client review events: `decision.made` with `action: 'await_approval'` marks `VERIFYING → AWAITING_APPROVAL`.
`review.report_ready` (actor `ai`, title written by code from the report counts) is emitted when QVAC's
report is stored. `review.approved` / `review.disputed` (actor `client`) and `review.expired` (actor
`system`, review window ran out) are each followed by the `decision.made` that moves the state.

WebSocket messages from the agent (`ws://<agent>:4000/ws?escrowId=<id>`; omit `escrowId` for all):

```ts
export type WsMessage =
  | { kind: 'snapshot'; escrow: Escrow; events: LogEvent[] }     // on connect
  | { kind: 'escrow'; escrow: Escrow }                           // on any escrow change
  | { kind: 'event'; event: LogEvent }                           // new log event
  | { kind: 'explanation_delta'; eventId: string; text: string } // streamed AI tokens
  | { kind: 'explanation_done'; eventId: string; text: string; source: 'ai' | 'template' };
```

## 3. Wallet interface (`packages/shared/src/wallet.ts`, implemented in `packages/wallet`)

```ts
export interface WalletInfo {
  role: Role;
  network: string;
  address: string;               // BTC deposit address (for fees)
  btcBalanceSat: string;
}

export interface AssetBalance { assetId: string; ticker?: string; settled: string; future: string; spendable: string }

export type TransferStatus = 'pending' | 'settled' | 'failed';

export interface TransferSummary {
  id: string;
  direction: 'incoming' | 'outgoing';
  assetId: string;
  amount: string;
  status: TransferStatus;
  rawStatus: string;             // whatever rgb-lib reports, for debugging
  txid?: string;
  recipientId?: string;          // lets the agent match an incoming transfer to its invoice
  createdAt?: string;
}

export interface EscrowWallet {
  init(): Promise<void>;                                   // open/create wallet, ensure UTXOs exist
  info(): Promise<WalletInfo>;
  balance(assetId: string): Promise<AssetBalance>;
  listAssets(): Promise<AssetBalance[]>;
  createInvoice(p: { assetId: string; amount: string; expiresInSec?: number }): Promise<{ invoice: string; recipientId: string; expiresAt?: string }>;
  pay(p: { invoice: string; assetId: string; amount: string }): Promise<{ txid: string }>;
  refresh(): Promise<void>;
  transfers(assetId: string): Promise<TransferSummary[]>;
  waitForTransfer(p: { assetId: string; recipientId?: string; txid?: string; timeoutMs: number }): Promise<TransferSummary>;
  sign?(message: string): Promise<{ signature: string; address: string }>;
}
```

Two implementations: `RgbWdkWallet` (real, `@utexo/wdk-wallet-rgb`) and `MockWallet` (in-memory, shares a
JSON file between processes so a mock "payment" in one process is visible in another).
Selected by `WALLET_MODE=real|mock`.

## 4. HTTP APIs

### Agent server `apps/agent` — `http://<agent>:4000`

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET  | `/health` | – | `{ ok, walletMode, aiUp, aiModel?, network, error? }` (`aiModel` from apps/ai `/health` while it is up; `ok:false` + `error` while the agent wallet is not ready) |
| GET  | `/config` | – | `{ assetId, assetTicker, precision, network }` |
| GET  | `/wallet` | – | `WalletInfo & { assets: AssetBalance[] }` (the agent's **own** wallet only; it never reads a party wallet) |
| POST | `/escrows` | `{ title, rawText, amount, deadline }` | `201 Escrow & { clientToken }` (state `DRAFT`, `fee` = `serviceFee(amount)`, parse starts async; the only response that carries `clientToken`) |
| GET  | `/escrows` | – | `Escrow[]` (the marketplace lists the `OPEN` ones) |
| GET  | `/escrows/:id` | – | `{ escrow, events }` |
| POST | `/escrows/:id/reparse` | `{ rawText?, clientToken? }` | `Escrow` (also from `OPEN`: edits unlist it and void acceptances; marketplace escrows need `clientToken`) |
| POST | `/escrows/:id/accept` | `{ role, termsHash, signature?, address? }` | `Escrow` (both-parties flow without a listing) |
| POST | `/escrows/:id/publish` | `{ termsHash, clientToken }` | `Escrow` (`PROPOSED → OPEN`; counts as the client's acceptance; `403` wrong token, `409` stale `termsHash` or no automatic check) |
| POST | `/escrows/:id/take` | `{ termsHash }` | `Escrow & { freelancerToken }` (`OPEN → AGREED → AWAITING_FUNDS`; first taker wins, `409` after) |
| POST | `/escrows/:id/offers` | `{ termsHash, amount, note? }` | `{ escrow, offerId, offerToken }` (counteroffer on an `OPEN` listing; `amount` must be lower than the listing's; `409` stale `termsHash`, not `OPEN`, past the deadline, or 20 pending offers) |
| POST | `/escrows/:id/offers/:offerId/accept` | `{ termsHash, clientToken }` | `Escrow` (`termsHash` = the offer's; `OPEN → AGREED` at the offer's amount and fee; every other pending offer is declined; `403` wrong token, `409` offer not pending/expired) |
| POST | `/escrows/:id/offers/:offerId/withdraw` | `{ offerToken }` | `Escrow` (`403` wrong token, `409` not pending) |
| POST | `/escrows/:id/cancel` | `{ role, token? }` | `Escrow` (before funding; marketplace escrows need the role's token) |
| POST | `/escrows/:id/refund-invoice` | `{ invoice, clientToken? }` | `Escrow` (client provides; marketplace escrows need `clientToken`) |
| POST | `/escrows/:id/funded` | `{ txid }` | `Escrow` (client hint; agent still verifies) |
| POST | `/escrows/:id/deliveries` | multipart: `file`, `payoutInvoice`, `freelancerToken?` | `Escrow` (max 20 MB, only in `FUNDED` before the deadline; `freelancerToken` required once the listing was taken) |
| GET  | `/escrows/:id/deliveries/:n/files` | – (header `x-escrow-token`) | `{ path, sizeBytes, previewable }[]` (the unpacked delivery) |
| GET  | `/escrows/:id/deliveries/:n/files/*` | – (header `x-escrow-token`) | the raw file, sent with `Content-Security-Policy: sandbox`. Before `RELEASED`: images only, to the client (its token) or the agent's own laptop; `403` otherwise. After: any file, to the client, the freelancer or the agent's laptop |
| POST | `/escrows/:id/approve` | `{ deliveryN, decision: 'approve' \| 'dispute', reason?, clientToken }` | `Escrow`; `403` wrong token, `409` not `AWAITING_APPROVAL` or not the latest delivery, `400` dispute without `reason` |
| POST | `/escrows/:id/dry-run` | multipart: `file` | `DryRunResponse` (verifier on a practice upload + QVAC fix hints; no state change); `409` unless `FUNDED`, after the deadline, or while one runs |
| POST | `/assist/:name` | the assist's request (`ASSIST_SCHEMAS`) | its result; `404` unknown/not proxied name, `400` invalid body, `503` AI unreachable or invalid answer |
| POST | `/escrows/:id/retry-step` | `{ force? }` | `Escrow` (re-run a stuck step now; `force` re-sends a payout/refund whose outcome is unknown after a crash — check the wallet first) |
| POST | `/dev/mine` | `{ blocks?: number }` | `{ height }` (regtest only) |
| POST | `/dev/reset` | – | clears db (dev only) |
| WS   | `/ws?escrowId=` | – | `WsMessage` stream |

**`clientToken`.** A random 32-byte hex string created with the escrow and returned once by
`POST /escrows`. The client UI keeps it; the agent stores only its sha256 and compares in constant time.
It never appears in `Escrow`, `LogEvent.data`, WebSocket messages or logs. Other routes still trust the
`role` in the body (LAN demo), but `/approve` releases money, so it needs proof that the caller is the client.

**`freelancerToken`.** The same for the freelancer: created by `POST /escrows/:id/take`, returned once, only
its sha256 stored. **Marketplace escrows** (published at least once) use the tokens everywhere: `reparse`,
`cancel`, `refund-invoice` and the file routes need the right one, and `deliveries` needs the
`freelancerToken`. Where a body can't carry it (file previews), it goes in the `x-escrow-token` header,
never in the URL: request URLs are logged.

**Marketplace timeouts** (5 s ticker, decided by `decide()`): `OPEN` past the deadline → `CANCELLED`;
`AWAITING_FUNDS` past `fundingDueAt` with no payment seen → `OPEN` (`funding.reopened`), as is a failed
funding payment. The funding invoice expires at `fundingDueAt`. A pending offer past its `expiresAt` →
`expired` (`offer.expired`).

**Counteroffers.** `POST /offers` returns a one-time `offerToken` (only its sha256 is stored): it withdraws
the offer, and if the client accepts the offer it becomes the freelancer's `freelancerToken` for the job.
Accepting sets `amount`, `fee` and `termsHash` to the offer's; the client and that freelancer have then
accepted the same hash (the freelancer's acceptance carries the offer's `at`). Every other pending offer is
declined (`offer.declined`), as are all pending offers when the listing is taken, edited or closed. A
listing that reopens after an accepted offer stays at the agreed terms.

### AI service `apps/ai` — `http://<ai-host>:4300`

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET  | `/health` | – | `{ ok, model, loaded, device }` |
| POST | `/parse` | `{ title, rawText, amountDisplay, assetTicker, deadline }` | `ParseResult` |
| POST | `/explain` | `{ event: LogEvent, escrow: Escrow }` | `text/event-stream` of `{ text }` deltas, final `{ done: true, text, source? }` (`source`: `'ai' \| 'template'`) |
| POST | `/explain/sync` | same | `{ text, source }` (non-streaming fallback) |
| POST | `/review` | `ReviewRequest` | `AiReview` (§1); advisory only |
| POST | `/assist/clarify` | `ClarifyRequest` | `ClarifyResult` (≤ 3 interview questions) |
| POST | `/assist/rewrite` | `RewriteRequest` | `RewriteResult` (verifiability score + measurable rewrites) |
| POST | `/assist/estimate` | `EstimateRequest` | `EstimateResult` (job size, typical price/time, warnings) |
| POST | `/assist/answer` | `AnswerRequest` | `AnswerResult` (answer from the terms, or `answered:false`) |
| POST | `/assist/hint` | `HintRequest` | `HintResult` (why each failed check failed + where to look) |
| POST | `/assist/match` | `MatchRequest` | `MatchResult` (jobs ranked for a freelancer's skills) |
| POST | `/assist/split` | `SplitRequest` | `SplitResult` (conditions divided among team members) |

**AI assist** (`packages/shared/src/assist.ts`, plan in `docs/AI_ASSIST_PLAN.md`): every `/assist/*` result
carries `source: 'ai' | 'fallback'` and always answers (deterministic fallback when the model is down or its
output fails the guards). All advisory; nothing here reaches `decide()`. The agent proxies the UI's calls as
`POST /assist/:name` for the names in `PROXIED_ASSISTS` (all but `hint`, which the agent calls inside
`POST /escrows/:id/dry-run`, response `DryRunResponse`). Agent → AI timeout: `AI_ASSIST_TIMEOUT_MS`.

**`examples` condition** (`packages/shared/src/examples.ts`, part of `ConditionSchema`, §1):
`{ id, kind: 'examples', description, target: { type: 'js_function', export, file? } | { type: 'command',
command }, cases: { input, expected }[] (1–10), timeoutSec }`. The verifier writes `renderExamplesTest(c)`
to a fresh temp folder outside the delivery and runs `examplesTestCommand(file)` in the delivery root. Passed =
exit code 0 **and** the test runner's final summary counts every case as passed (a delivery that exits with
code 0 on import would otherwise pass without running a single example).

```ts
export interface ParseResult {
  conditions: Condition[];       // already validated; may include client_review
  summary: string;
  clarifications: string[];      // things that can't be agreed yet (e.g. "the hash I'll send later")
  source: 'ai' | 'fallback';
  model?: string;
  ms: number;
}

export interface ReviewRequest {
  escrow: Escrow;                // rawText, conditions, deliveries (with automatic results)
  deliveryN: number;
  files: { path: string; sizeBytes: number; excerpt?: string }[]; // excerpt: first few KB of text files; absent for binaries
}
```

### Party server `apps/party` — client `:4101`, freelancer `:4102`

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET  | `/health` | – | `{ ok, role, walletMode }` |
| GET  | `/wallet` | – | `WalletInfo & { assets: AssetBalance[] }` — **own laptop only** (`403` from anywhere else) |
| POST | `/wallet/invoice` | `{ assetId, amount, expiresInSec? }` | `{ invoice, recipientId, expiresAt? }` |
| POST | `/wallet/pay` | `{ invoice, assetId, amount }` | `{ txid }` — own laptop only |
| POST | `/wallet/refresh` | – | `{ ok }` |
| GET  | `/wallet/transfers?assetId=` | – | `TransferSummary[]` — own laptop only |
| POST | `/wallet/sign` | `{ message }` | `{ signature, address }` — own laptop only |
| POST | `/autopay` | `{ escrowId, clientToken }` | `AutopayStatus` — client role, own laptop only: pre-authorises reward + fee for one listing |
| GET  | `/autopay` | – | `AutopayStatus[]` — own laptop only |

**Balances are private.** A party's balance, transfers and spending routes answer only requests from its
own laptop (loopback), so the agent and other users can never read them. Only `/health`, `/wallet/invoice`
and `/wallet/refresh` answer from the LAN.

**Auto-pay.** When the client approves a listing, its UI calls `POST /autopay`. When a freelancer takes the
job, the client's party server attaches a refund invoice valid until a day after the deadline
(`refund-invoice` with `clientToken`) and pays exactly `escrowTotal()` to the funding invoice — at most the
authorised total (an accepted counteroffer costs less), never more, never twice for one invoice.

All three servers send permissive CORS headers (LAN demo) and log every request on one line.
Errors: `400 { error, details }` (zod issues) for bad bodies, `404` unknown escrow, `409 { error, details? }`
for an action the current state does not allow (e.g. stale `termsHash`, delivery before funding).

Route constants in `@escrow/shared` double as Fastify patterns: `AGENT_ROUTES.accept(':id')` is
`/escrows/:id/accept`.

## 5. Environment variables (`.env.example`)

See `.env.example` at the repo root. Every process reads only the variables listed there.

Client review adds two agent variables (add them to `.env.example` when building):
`REVIEW_WINDOW_SEC` (how long the client has to approve or dispute before the agent releases; ~120 for
the demo) and `AI_REVIEW_TIMEOUT_MS` (agent → `apps/ai` `/review`, e.g. 30000).

The marketplace adds `FUNDING_WINDOW_SEC` (agent; default 600): how long a taken listing waits for the
client's payment before it reopens, and `OFFER_WINDOW_SEC` (agent; default 900): how long a counteroffer
waits for the client before it expires (never past the job's deadline).
