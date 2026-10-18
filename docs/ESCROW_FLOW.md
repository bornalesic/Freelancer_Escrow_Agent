# Escrow flow and state machine

## States

```
DRAFT ──ai parse──▶ PROPOSED ──both accept──▶ AGREED ──agent invoice──▶ AWAITING_FUNDS
                       │  ▲                                                   │
                       │  └──edit / re-parse                    client pays,  │
                       ▼                                        transfer settles
                   CANCELLED                                                  ▼
                      REFUNDED ◀──settled── REFUNDING ◀──deadline passed── FUNDED ◀───────────────────────────┐
                                                                              │ freelancer uploads            │
                                                                              ▼                               │
                                                                          DELIVERED                           │
                                                                              │                               │
                                                                              ▼                               │
                                                                          VERIFYING ── a check fails ─────────┤
                                                                              │ all automatic checks pass     │
                                                                      ┌───────┴───────┐                       │
                                                     no client_review │               ▼ has client_review     │
                                                                      │       AWAITING_APPROVAL ── dispute ───┘
                                                                      │               │ approve, or the review
                                                                      │               │ window expires
                                                                      ▼               │
                                                                  RELEASING ◀─────────┘
                                                                      │ settled
                                                                      ▼
                                                                  RELEASED
```

Going back to `FUNDED` (a failed check or a dispute) only happens before the deadline. A dispute after
the deadline goes straight to `REFUNDING`. The deadline alone never refunds an escrow in
`AWAITING_APPROVAL`: that work passed every automatic check in time.

| State               | Entered when                                                                 | Who acts next |
| ------------------- | ---------------------------------------------------------------------------- | ------------- |
| `DRAFT`             | Client submits plain-language agreement + amount + deadline                  | AI            |
| `PROPOSED`          | AI returned valid conditions + summary                                       | Both parties  |
| `AGREED`            | Client and freelancer both accepted the **same** `termsHash`                 | Agent         |
| `AWAITING_FUNDS`    | Agent wallet created a receive invoice for the amount                        | Client        |
| `FUNDED`            | Agent wallet sees the incoming transfer as settled                           | Freelancer    |
| `DELIVERED`         | Freelancer uploaded a deliverable + a payout invoice                         | Verifier      |
| `VERIFYING`         | Verifier running                                                             | Verifier      |
| `AWAITING_APPROVAL` | All automatic checks passed and the terms have at least one `client_review`  | Client        |
| `RELEASING`         | `decide()` returned `release`; agent wallet sent to payout invoice           | Wallet        |
| `RELEASED`          | Outgoing transfer settled                                                    | done          |
| `REFUNDING`         | `decide()` returned `refund`; agent wallet sent to refund invoice            | Wallet        |
| `REFUNDED`          | Refund settled                                                               | done          |
| `CANCELLED`         | Either party cancels before funding                                          | done          |

A failed verification returns to `FUNDED` with the failure logged and explained, so the freelancer can
submit a fixed version. This fail-then-pass sequence is the heart of the demo.

## Marketplace flow (apps/market)

The marketplace UI uses the same machine with one extra state, `OPEN`: the client publishes a job and any
freelancer can take it. The two-party flow above (both accept, then fund) still works unchanged.

```
PROPOSED ──client approves (publish)──▶ OPEN ──a freelancer takes it──▶ AGREED ──▶ AWAITING_FUNDS ──▶ FUNDED …
   ▲                                     │  │                                          │
   └────────── client edits (re-parse) ──┘  └─ client withdraws, or deadline ─▶ CANCELLED
                                                                                       │
                     OPEN ◀── not funded within FUNDING_WINDOW_SEC, or the payment failed
```

| Arrow | When | Event |
| ----- | ---- | ----- |
| `PROPOSED → OPEN` | `POST /escrows/:id/publish { termsHash, clientToken }`. Counts as the client's acceptance. A job with no automatic conditions can be published too: every delivery then goes to client review (`AWAITING_APPROVAL`). | `listing.published` |
| `OPEN → DRAFT` | The client edits the description (`/reparse` with its `clientToken`): new terms, unlisted until approved again. | `terms.reparse_requested` |
| `OPEN → AGREED` | `POST /escrows/:id/take { termsHash }`: the first freelancer wins and gets a one-time `freelancerToken`. `fundingDueAt` = now + `FUNDING_WINDOW_SEC` (600). | `terms.agreed` |
| `OPEN → CANCELLED` | The client withdraws, or `decide()` returns `cancel` at the deadline. | `escrow.cancelled` / `decision.made` |
| `AWAITING_FUNDS → OPEN` | `decide()` returns `reopen`: not funded by `fundingDueAt`, or the payment failed. The freelancer's acceptance and token are dropped; the client's approval stays. | `funding.reopened` |

- **Fee.** `fee = serviceFee(amount)`: 2% of the reward, rounded up, at least 1 base unit. It is part of
  `termsHash`. The client escrows `amount + fee`; release pays the freelancer `amount` and the service
  keeps `fee`; a refund returns `amount + fee`.
- **Auto-pay.** When the client publishes, its UI pre-authorises its own party server (`POST /autopay`).
  When the job is taken, that server attaches a refund invoice valid past the deadline and pays exactly
  `amount + fee`. Nobody clicks "pay"; settlement never waits for anyone later.
- **Tokens.** Marketplace jobs require the `clientToken` (edit, cancel, refund invoice, approve) and the
  `freelancerToken` (deliver, cancel) in the body, or in the `x-escrow-token` header for files.
- **Previews.** Before release the client and the service screen (the agent's own laptop) see image
  previews only; everything after release. The freelancer always sees its own files.
- **Private balances.** The agent never reads a party's wallet. Each party server answers balance, history
  and spending only to a page served from `localhost` on its own laptop.

## Two kinds of conditions

- **Automatic** (`tests_pass`, `file_hash`, `file_present`): the verifier checks them. Same as before.
- **Client review** (`client_review`): a criterion a person has to judge, e.g. "The logo uses warm
  colours". QVAC reads the delivery and writes an **advisory** report; the client then approves or
  disputes. `client_review` conditions are part of `conditions`, so they are inside `termsHash` and both
  parties agree up front on exactly what the client will judge.

The AI never decides. `decide()` never reads the AI report; it only sees the automatic results, the
client's answer, the escrow state and the clock.

## Step by step

1. **Draft.** Client UI posts `{ title, rawText, amount, deadline }`. Agent stores `DRAFT`, returns the
   escrow plus a one-time `clientToken` (the client UI keeps it), and calls `apps/ai` `POST /parse`.
2. **Proposal.** AI returns `conditions[]`, a one-paragraph `summary`, and optional `clarifications[]`.
   Subjective requirements a person can judge ("looks professional") become `client_review` conditions;
   `clarifications` are for things that can't be agreed yet ("the hash I'll send later"). Agent validates
   with zod, computes `termsHash` = sha256 of the canonical JSON of
   `{ title, amount, fee, assetId, deadline, conditions }` (an escrow without a fee hashes as before).
   State `PROPOSED`.
   If the AI fails twice, the agent uses the fallback parser (see `apps/ai/CLAUDE.md`).
3. **Accept.** Each party clicks Accept → `POST /escrows/:id/accept { role, termsHash, signature? }`.
   The agent rejects an accept whose `termsHash` does not match the current one. Signatures (BIP-322 via
   the party's WDK account `sign()`) are a nice-to-have; record them if present.
   When both accepted: `AGREED`.
4. **Funding invoice.** Agent wallet creates a receive invoice for `amount + fee` of `ESCROW_ASSET_ID`
   (blind receive by default). The client also attaches a **refund invoice** from its own wallet.
   State `AWAITING_FUNDS`.
5. **Pay.** Client UI shows "Lock 50 USDT" → client party server pays the agent invoice. The agent
   polls `refresh()` + transfer list until the incoming transfer is `settled`. On regtest the agent
   auto-mines a block (`AUTO_MINE=true`). State `FUNDED`.
6. **Deliver.** Freelancer uploads a file (zip or single file) and attaches a fresh **payout invoice**
   from its own wallet. State `DELIVERED` → immediately `VERIFYING`.
7. **Verify.** The verifier evaluates every **automatic** condition and returns `VerificationResult[]`
   with evidence (exit code, stdout tail, actual hash, duration). `client_review` conditions are skipped.
8. **Decide.** `decide(escrow, results, now)` is a pure function:
   - all automatic conditions passed, no `client_review`, state `VERIFYING` → `release`
   - all automatic conditions passed, has `client_review`, state `VERIFYING` → `await_approval`
     (state `AWAITING_APPROVAL`, see step 9)
   - some failed and `now < deadline` → `retry` (back to `FUNDED`)
   - `now >= deadline` and nothing passed → `refund`
   - in `AWAITING_APPROVAL` (latest delivery):
     - client approved → `release`
     - client disputed and `now < deadline` → `retry` (`failed` = the `client_review` ids)
     - client disputed and `now >= deadline` → `refund`
     - no answer and `now >= reviewDueAt` → `release` (the client did not object in time)
   - anything else → `wait`
9. **Client review** (only when the terms have a `client_review`).
   - The agent sets `delivery.reviewDueAt = now + REVIEW_WINDOW_SEC`.
   - Without blocking the flow, it builds file excerpts (file tree + first few KB of each text file) and
     calls `apps/ai` `POST /review`. It stores the `AiReview` on the delivery and emits
     `review.report_ready`. On timeout or error the report is a template with every item `unsure`.
   - The client browses the delivered files (`GET /escrows/:id/deliveries/:n/files/*`, served sandboxed),
     reads the report (labelled "AI opinion, you make the call"), and calls
     `POST /escrows/:id/approve { deliveryN, decision, reason?, clientToken }`.
   - Approve → `review.approved`; dispute → `review.disputed` (the reason is shown to the freelancer);
     no answer by `reviewDueAt` → `review.expired`. Each is followed by `decide()` and `decision.made`.
10. **Settle.** Agent wallet pays the payout invoice (`amount`; it keeps the `fee`) or the refund invoice
    (`amount + fee`), auto-mines, waits for settlement. Final state `RELEASED` or `REFUNDED`.
11. **Explain.** After every log event that has `explain: true`, the agent asks `apps/ai` `POST /explain`
    and streams the explanation into that event (`event.explanation`) over WebSocket.

## Client review: rules

- **Only the client can approve.** `/approve` needs the `clientToken` from step 1. Every other route
  trusts the `role` in the body, but this one releases money.
- **No answer means release.** If the client does not answer by `reviewDueAt`, the agent releases.
  Otherwise a client could ignore the review, keep the work and get the money back at the deadline.
- **The AI report is advice.** It can be wrong or manipulated by the delivery's content (prompt
  injection); the worst case is a misleading report the client still has to agree with.
- **Known limit:** a client can dispute every delivery until the deadline and get a refund. Real
  platforms use human arbitration for this; it is out of scope.

## Invoices: practical rules

- RGB invoices are **single-use**. Create a new one for every payment, never reuse.
- Create the invoice as close as possible to when it will be paid, and check its expiry
  (confirm the default expiry with UTEXO mentors).
- Always use the **asset id**, never the ticker, when creating invoices or sending.
- Before a wallet can receive or issue, it needs colorable UTXOs: call `createUtxos` during setup.
- Both sides must `refresh()` for a transfer to progress. The party servers and the agent poll
  every few seconds while any transfer is pending.

## Deadline handling

The agent runs a 5-second ticker. For each `FUNDED` escrow past its deadline, it calls `decide()` and
refunds if appropriate. For each `AWAITING_APPROVAL` escrow past its latest delivery's `reviewDueAt`, it
emits `review.expired`, calls `decide()` and releases. An `OPEN` listing past its deadline is cancelled,
and an `AWAITING_FUNDS` marketplace job past `fundingDueAt` (or whose payment failed) goes back to `OPEN`.
For the demo, deadlines can be set in minutes and `REVIEW_WINDOW_SEC` to about two minutes.

The agent keeps every job in `AGENT_DATA_DIR/db.json` across restarts on purpose (money in escrow must
survive a crash). To start a demo with no old jobs: stop the servers, then `npm run demo:clear-jobs`
(jobs only) or `npm run demo:reset` (jobs and wallets).
