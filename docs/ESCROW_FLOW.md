# Escrow flow and state machine

## States

```
DRAFT ──ai parse──▶ PROPOSED ──both accept──▶ AGREED ──agent invoice──▶ AWAITING_FUNDS
                       │  ▲                                                   │
                       │  └──edit / re-parse                    client pays,  │
                       ▼                                        transfer settles
                   CANCELLED                                                  ▼
                                                                           FUNDED
                                                                              │ freelancer uploads
                                                                              ▼
                                                     ┌──── fail ──────── VERIFYING ◀── DELIVERED
                                                     ▼                        │ all pass
                                               FUNDED (retry allowed          ▼
                                               until deadline)            RELEASING ──settled──▶ RELEASED
                                                     │ deadline passed
                                                     ▼
                                                 REFUNDING ──settled──▶ REFUNDED
```

| State            | Entered when                                                        | Who acts next |
| ---------------- | ------------------------------------------------------------------- | ------------- |
| `DRAFT`          | Client submits plain-language agreement + amount + deadline        | AI            |
| `PROPOSED`       | AI returned valid conditions + summary                              | Both parties  |
| `AGREED`         | Client and freelancer both accepted the **same** `termsHash`        | Agent         |
| `AWAITING_FUNDS` | Agent wallet created a receive invoice for the amount               | Client        |
| `FUNDED`         | Agent wallet sees the incoming transfer as settled                  | Freelancer    |
| `DELIVERED`      | Freelancer uploaded a deliverable + a payout invoice                | Verifier      |
| `VERIFYING`      | Verifier running                                                    | Verifier      |
| `RELEASING`      | `decide()` returned `release`; agent wallet sent to payout invoice  | Wallet        |
| `RELEASED`       | Outgoing transfer settled                                           | done          |
| `REFUNDING`      | `decide()` returned `refund`; agent wallet sent to refund invoice   | Wallet        |
| `REFUNDED`       | Refund settled                                                      | done          |
| `CANCELLED`      | Either party cancels before funding                                 | done          |

A failed verification returns to `FUNDED` with the failure logged and explained, so the freelancer can
submit a fixed version. This fail-then-pass sequence is the heart of the demo.

## Step by step

1. **Draft.** Client UI posts `{ title, rawText, amount, deadline }`. Agent stores `DRAFT`, calls
   `apps/ai` `POST /parse`.
2. **Proposal.** AI returns `conditions[]`, a one-paragraph `summary`, and optional `clarifications[]`
   (things it could not make checkable). Agent validates with zod, computes `termsHash` =
   sha256 of the canonical JSON of `{ title, amount, assetId, deadline, conditions }`. State `PROPOSED`.
   If the AI fails twice, the agent uses the fallback parser (see `apps/ai/CLAUDE.md`).
3. **Accept.** Each party clicks Accept → `POST /escrows/:id/accept { role, termsHash, signature? }`.
   The agent rejects an accept whose `termsHash` does not match the current one. Signatures (BIP-322 via
   the party's WDK account `sign()`) are a nice-to-have; record them if present.
   When both accepted: `AGREED`.
4. **Funding invoice.** Agent wallet creates a receive invoice for `amount` of `ESCROW_ASSET_ID`
   (blind receive by default). The client also attaches a **refund invoice** from its own wallet.
   State `AWAITING_FUNDS`.
5. **Pay.** Client UI shows "Lock 50 USDT" → client party server pays the agent invoice. The agent
   polls `refresh()` + transfer list until the incoming transfer is `settled`. On regtest the agent
   auto-mines a block (`AUTO_MINE=true`). State `FUNDED`.
6. **Deliver.** Freelancer uploads a file (zip or single file) and attaches a fresh **payout invoice**
   from its own wallet. State `DELIVERED` → immediately `VERIFYING`.
7. **Verify.** The verifier evaluates every condition and returns `VerificationResult[]` with evidence
   (exit code, stdout tail, actual hash, duration).
8. **Decide.** `decide(escrow, results, now)` is a pure function:
   - all conditions passed and state is `VERIFYING` → `release`
   - some failed and `now < deadline` → `retry` (back to `FUNDED`)
   - `now >= deadline` and nothing passed → `refund`
9. **Settle.** Agent wallet pays the payout (or refund) invoice, auto-mines, waits for settlement.
   Final state `RELEASED` or `REFUNDED`.
10. **Explain.** After every log event that has `explain: true`, the agent asks `apps/ai` `POST /explain`
    and streams the explanation into that event (`event.explanation`) over WebSocket.

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
refunds if appropriate. For the demo, deadlines can be set in minutes.
