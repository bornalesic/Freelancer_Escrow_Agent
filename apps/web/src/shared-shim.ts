// TEMPORARY stand-in for `@escrow/shared` until packages/shared lands on main (WS3).
// Mirrors docs/CONTRACTS.md 1:1, types only plus the amount helpers the UI needs.
// The alias in vite.config.ts / tsconfig.json switches to the real package as soon as it exists;
// then delete this file and the aliases. Do not add anything here that is not in CONTRACTS.md.

// ---- domain.ts -------------------------------------------------------------------------------
export type Role = 'client' | 'freelancer' | 'agent';

export type EscrowState =
  | 'DRAFT' | 'PROPOSED' | 'AGREED' | 'AWAITING_FUNDS' | 'FUNDED'
  | 'DELIVERED' | 'VERIFYING' | 'RELEASING' | 'RELEASED'
  | 'REFUNDING' | 'REFUNDED' | 'CANCELLED';

export type Condition =
  | { id: string; kind: 'tests_pass'; description: string; command: string; timeoutSec: number }
  | { id: string; kind: 'file_hash'; description: string; fileName?: string; sha256: string }
  | { id: string; kind: 'file_present'; description: string; pathPattern: string };

export interface Acceptance {
  role: 'client' | 'freelancer';
  termsHash: string;
  at: string;
  signature?: string;
  address?: string;
}

export interface VerificationResult {
  conditionId: string;
  passed: boolean;
  evidence: {
    exitCode?: number;
    stdoutTail?: string;
    actualSha256?: string;
    matched?: string[];
    durationMs: number;
    error?: string;
  };
}

export interface Delivery {
  n: number;
  fileName: string;
  sha256: string;
  sizeBytes: number;
  at: string;
  results?: VerificationResult[];
}

export interface Escrow {
  id: string;
  title: string;
  rawText: string;
  amount: string;
  assetId: string;
  assetTicker: string;
  precision: number;
  deadline: string;
  state: EscrowState;
  summary?: string;
  clarifications?: string[];
  conditions: Condition[];
  termsHash?: string;
  acceptances: Acceptance[];
  fundingInvoice?: string;
  refundInvoice?: string;
  payoutInvoice?: string;
  deliveries: Delivery[];
  createdAt: string;
  updatedAt: string;
}

// ---- events.ts -------------------------------------------------------------------------------
export type Actor = 'client' | 'freelancer' | 'agent' | 'ai' | 'verifier' | 'wallet' | 'system';

export type LogEventType =
  | 'escrow.created' | 'terms.proposed' | 'terms.accepted' | 'terms.agreed'
  | 'funding.invoice_created' | 'funding.payment_seen' | 'funding.settled'
  | 'delivery.received' | 'verify.started' | 'verify.condition_result' | 'verify.finished'
  | 'decision.made'
  | 'payout.sent' | 'payout.settled' | 'refund.sent' | 'refund.settled'
  | 'escrow.cancelled' | 'error';

export interface LogEvent {
  id: string;
  escrowId: string;
  at: string;
  actor: Actor;
  type: LogEventType;
  title: string;
  data?: Record<string, unknown>;
  explain: boolean;
  explanation?: string;
  explanationSource?: 'ai' | 'template';
}

export type WsMessage =
  | { kind: 'snapshot'; escrow: Escrow; events: LogEvent[] }
  | { kind: 'escrow'; escrow: Escrow }
  | { kind: 'event'; event: LogEvent }
  | { kind: 'explanation_delta'; eventId: string; text: string }
  | { kind: 'explanation_done'; eventId: string; text: string; source: 'ai' | 'template' };

// ---- wallet.ts -------------------------------------------------------------------------------
export interface WalletInfo {
  role: Role;
  network: string;
  address: string;
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
  rawStatus: string;
  txid?: string;
  recipientId?: string;
  createdAt?: string;
}

// ---- api.ts (response shapes from CONTRACTS.md §4; names are a guess until WS3 lands api.ts) --
export interface AgentHealth { ok: boolean; walletMode: string; aiUp: boolean; network: string }
export interface AgentConfig { assetId: string; assetTicker: string; precision: number; network: string }
export interface PartyHealth { ok: boolean; role: Role; walletMode: string }
export type PartyWallet = WalletInfo & { assets: AssetBalance[] };

// ---- amount.ts -------------------------------------------------------------------------------
/** "50000000", 6 -> "50"; "1500000", 6 -> "1.5". bigint-safe, no floats. */
export function formatAmount(base: string, precision: number): string {
  const v = BigInt(base);
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const scale = 10n ** BigInt(precision);
  const whole = abs / scale;
  const frac = (abs % scale).toString().padStart(precision, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}

/** "50", 6 -> "50000000"; "1.5", 6 -> "1500000". Throws on bad input or too many decimals. */
export function toBaseUnits(display: string, precision: number): string {
  const m = /^(\d+)(?:\.(\d*))?$/.exec(display.trim());
  if (!m) throw new Error(`Not an amount: "${display}"`);
  const frac = m[2] ?? '';
  if (frac.length > precision) throw new Error(`At most ${precision} decimals`);
  return (BigInt(m[1]) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, '0') || '0')).toString();
}
