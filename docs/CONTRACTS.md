# Contracts between components

This file is the **specification for `packages/shared`**. At hour 0 the whole team turns it into code
(`packages/shared/src/*.ts`, with zod schemas). After that, `packages/shared` is the source of truth and
this file is updated alongside it. Changing a contract follows `.claude/commands/contract-change.md`.

All JSON amounts are integer base units as **decimal strings**. All timestamps are ISO-8601 strings (UTC).

## 1. Core domain types (`packages/shared/src/domain.ts`)

```ts
export type Role = 'client' | 'freelancer' | 'agent';

export type EscrowState =
  | 'DRAFT' | 'PROPOSED' | 'AGREED' | 'AWAITING_FUNDS' | 'FUNDED'
  | 'DELIVERED' | 'VERIFYING' | 'RELEASING' | 'RELEASED'
  | 'REFUNDING' | 'REFUNDED' | 'CANCELLED';

/** A machine-checkable acceptance condition. Discriminated on `kind`. */
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
  amount: string;                // base units
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
  deliveries: Delivery[];
  createdAt: string;
  updatedAt: string;
}

export interface Delivery {
  n: number;                     // 1, 2, 3...
  fileName: string;
  sha256: string;
  sizeBytes: number;
  at: string;
  results?: VerificationResult[];
}

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
  | { action: 'wait'; reason: string };
```

## 2. Decision log (`packages/shared/src/events.ts`)

```ts
export type Actor = 'client' | 'freelancer' | 'agent' | 'ai' | 'verifier' | 'wallet' | 'system';

export type LogEventType =
  | 'escrow.created' | 'terms.proposed' | 'terms.accepted' | 'terms.agreed'
  | 'funding.invoice_created' | 'funding.payment_seen' | 'funding.settled'
  | 'delivery.received' | 'verify.started' | 'verify.condition_result' | 'verify.finished'
  | 'decision.made'
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
  createInvoice(p: { assetId: string; amount: string }): Promise<{ invoice: string; recipientId: string; expiresAt?: string }>;
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
| GET  | `/health` | – | `{ ok, walletMode, aiUp, network }` |
| GET  | `/config` | – | `{ assetId, assetTicker, precision, network }` |
| POST | `/escrows` | `{ title, rawText, amount, deadline }` | `Escrow` (state `DRAFT`, parse starts async) |
| GET  | `/escrows` | – | `Escrow[]` |
| GET  | `/escrows/:id` | – | `{ escrow, events }` |
| POST | `/escrows/:id/reparse` | `{ rawText? }` | `Escrow` |
| POST | `/escrows/:id/accept` | `{ role, termsHash, signature?, address? }` | `Escrow` |
| POST | `/escrows/:id/cancel` | `{ role }` | `Escrow` |
| POST | `/escrows/:id/refund-invoice` | `{ invoice }` | `Escrow` (client provides) |
| POST | `/escrows/:id/funded` | `{ txid }` | `Escrow` (client hint; agent still verifies) |
| POST | `/escrows/:id/deliveries` | multipart: `file`, `payoutInvoice` | `Escrow` |
| POST | `/dev/mine` | `{ blocks?: number }` | `{ height }` (regtest only) |
| POST | `/dev/reset` | – | clears db (dev only) |
| WS   | `/ws?escrowId=` | – | `WsMessage` stream |

### AI service `apps/ai` — `http://<ai-host>:4300`

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET  | `/health` | – | `{ ok, model, loaded, device }` |
| POST | `/parse` | `{ title, rawText, amountDisplay, assetTicker, deadline }` | `ParseResult` |
| POST | `/explain` | `{ event: LogEvent, escrow: Escrow }` | `text/event-stream` of `{ text }` deltas, final `{ done: true, text, source? }` (`source`: `'ai' \| 'template'`) |
| POST | `/explain/sync` | same | `{ text, source }` (non-streaming fallback) |

```ts
export interface ParseResult {
  conditions: Condition[];       // already validated
  summary: string;
  clarifications: string[];
  source: 'ai' | 'fallback';
  model?: string;
  ms: number;
}
```

### Party server `apps/party` — client `:4101`, freelancer `:4102`

| Method | Path | Body | Returns |
| ------ | ---- | ---- | ------- |
| GET  | `/health` | – | `{ ok, role, walletMode }` |
| GET  | `/wallet` | – | `WalletInfo & { assets: AssetBalance[] }` |
| POST | `/wallet/invoice` | `{ assetId, amount }` | `{ invoice, recipientId, expiresAt? }` |
| POST | `/wallet/pay` | `{ invoice, assetId, amount }` | `{ txid }` |
| POST | `/wallet/refresh` | – | `{ ok }` |
| GET  | `/wallet/transfers?assetId=` | – | `TransferSummary[]` |
| POST | `/wallet/sign` | `{ message }` | `{ signature, address }` |

All three servers send permissive CORS headers (LAN demo) and log every request on one line.

## 5. Environment variables (`.env.example`)

See `.env.example` at the repo root. Every process reads only the variables listed there.
