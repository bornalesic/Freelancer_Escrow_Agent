// Pure display rules: plain-English labels for internal states and checks, money, time, marketplace
// sorting/filtering, frozen funds, and the "under the hood" RGB trail of a job. No React, so unit-tested.
import {
  escrowTotal,
  formatAmount,
  isAutomaticCondition,
  type Condition,
  type Escrow,
  type EscrowState,
  type LogEvent,
  type LogEventType,
  type Offer,
  type OfferStatus,
} from '@escrow/shared';

// ---- counteroffers --------------------------------------------------------------------------------

/** Offers the client can still accept (the ticker marks expired ones within seconds; hide them already). */
export const openOffers = (e: Pick<Escrow, 'offers'>, now: number): Offer[] =>
  (e.offers ?? []).filter((o) => o.status === 'pending' && Date.parse(o.expiresAt) > now);

export const OFFER_STATUS_LABEL: Record<OfferStatus, string> = {
  pending: 'Waiting for the client',
  accepted: 'Accepted',
  declined: 'Declined',
  expired: 'Expired',
  withdrawn: 'Withdrawn',
};

// ---- states ---------------------------------------------------------------------------------------

export const STATE_LABEL: Record<EscrowState, string> = {
  DRAFT: 'Draft',
  PROPOSED: 'Reviewing requirements',
  OPEN: 'Open',
  AGREED: 'Funding',
  AWAITING_FUNDS: 'Funding',
  FUNDED: 'In progress',
  DELIVERED: 'Checking work',
  VERIFYING: 'Checking work',
  AWAITING_APPROVAL: 'Waiting for client',
  RELEASING: 'Paid',
  RELEASED: 'Paid',
  REFUNDING: 'Refunded',
  REFUNDED: 'Refunded',
  CANCELLED: 'Cancelled',
};

export type Tone = 'grey' | 'blue' | 'amber' | 'violet' | 'green' | 'orange';

export const STATE_TONE: Record<EscrowState, Tone> = {
  DRAFT: 'grey',
  PROPOSED: 'blue',
  OPEN: 'blue',
  AGREED: 'amber',
  AWAITING_FUNDS: 'amber',
  FUNDED: 'violet',
  DELIVERED: 'violet',
  VERIFYING: 'violet',
  AWAITING_APPROVAL: 'amber',
  RELEASING: 'green',
  RELEASED: 'green',
  REFUNDING: 'orange',
  REFUNDED: 'orange',
  CANCELLED: 'grey',
};

/** Money is on its way out on Bitcoin, not yet confirmed. */
export const isSettling = (s: EscrowState) => s === 'RELEASING' || s === 'REFUNDING';

/** The agent holds the client's money in these states (and only these). */
export const FROZEN_STATES: readonly EscrowState[] = ['FUNDED', 'DELIVERED', 'VERIFYING', 'AWAITING_APPROVAL', 'RELEASING', 'REFUNDING'];

/** Base units frozen in escrow for this job right now: reward + fee while held, else 0. */
export const frozen = (e: Escrow): string => (FROZEN_STATES.includes(e.state) ? escrowTotal(e) : '0');

// ---- money and time -------------------------------------------------------------------------------

export interface AssetDisplay {
  precision: number;
  assetTicker: string;
}

/** rgb-lib only takes upper-case tickers (TUSDT); people read "tUSDT". */
export const displayTicker = (ticker: string) => (ticker === 'TUSDT' ? 'tUSDT' : ticker);

export const money = (units: string | bigint, a: AssetDisplay) => `${formatAmount(units, a.precision)} ${displayTicker(a.assetTicker)}`;

/** Log titles and AI explanations name the asset by its rgb-lib ticker; show it as people read it. */
export const displayText = (s: string) => s.replace(/\bTUSDT\b/g, 'tUSDT');

export function relativeTime(iso: string, now: number): string {
  const diff = Date.parse(iso) - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return diff >= 0 ? 'in under a minute' : 'just now';
  const min = Math.round(abs / 60_000);
  const text = min < 60 ? `${min} min` : min < 48 * 60 ? `${Math.round(min / 60)} h` : `${Math.round(min / 1440)} days`;
  return diff >= 0 ? `in ${text}` : `${text} ago`;
}

/** "9:41" style countdown for short windows (funding, client review). */
export function countdown(iso: string, now: number): string {
  const left = Math.max(0, Math.ceil((Date.parse(iso) - now) / 1000));
  return `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`;
}

// ---- requirements ---------------------------------------------------------------------------------

export interface ConditionInfo {
  label: string;
  /** Checked by the deterministic verifier (true) or judged by the client (false). */
  automatic: boolean;
  detail?: string;
}

export function conditionInfo(c: Condition): ConditionInfo {
  if (!isAutomaticCondition(c)) return { label: 'Client reviews', automatic: false };
  switch (c.kind) {
    case 'tests_pass':
      return { label: 'Tests must pass', automatic: true, detail: `Runs \`${c.command}\`` };
    case 'file_present':
      return { label: 'Required file', automatic: true, detail: `Needs ${c.pathPattern}` };
    case 'file_hash':
      return { label: 'Exact file', automatic: true, detail: `${c.fileName ?? 'The upload'} must match fingerprint ${c.sha256.slice(0, 8)}…` };
    case 'examples':
      return { label: 'Examples must match', automatic: true, detail: `${c.cases.length} agreed input → output example${c.cases.length === 1 ? '' : 's'}` };
  }
}

export const automaticCount = (e: Pick<Escrow, 'conditions'>) => e.conditions.filter(isAutomaticCondition).length;

// ---- marketplace ----------------------------------------------------------------------------------

export type ListingSort = 'reward-desc' | 'reward-asc' | 'deadline-asc';

export function sortListings(list: readonly Escrow[], by: ListingSort): Escrow[] {
  const reward = (e: Escrow) => BigInt(e.amount);
  return [...list].sort((a, b) => {
    if (by === 'deadline-asc') return Date.parse(a.deadline) - Date.parse(b.deadline);
    const d = reward(a) - reward(b);
    const cmp = d === 0n ? 0 : d > 0n ? 1 : -1;
    return by === 'reward-asc' ? cmp : -cmp;
  });
}

export function filterListings(
  list: readonly Escrow[],
  f: { minReward?: string | undefined; dueWithinMs?: number | undefined; now: number },
): Escrow[] {
  return list.filter((e) =>
    e.state === 'OPEN' &&
    Date.parse(e.deadline) > f.now &&
    (f.minReward === undefined || BigInt(e.amount) >= BigInt(f.minReward)) &&
    (f.dueWithinMs === undefined || Date.parse(e.deadline) - f.now <= f.dueWithinMs));
}

// ---- RGB under the hood -----------------------------------------------------------------------------

export interface RgbStep {
  title: string;
  /** What RGB does at this step, in plain words. */
  detail: string;
  /** The invoice or Bitcoin txid involved, shown shortened. */
  value?: string | undefined;
  /** rgb-lib's own status for the transfer, when the agent logged it. */
  status?: string | undefined;
  at?: string | undefined;
  done: boolean;
}

const str = (v: unknown) => (typeof v === 'string' ? v : undefined);

function lastEvent(events: readonly LogEvent[], ...types: LogEventType[]): LogEvent | undefined {
  for (let i = events.length - 1; i >= 0; i--) if (types.includes(events[i]!.type)) return events[i];
  return undefined;
}

/** How this job's money moved on RGB, step by step, from the agent's own log. */
export function rgbTrail(e: Escrow, events: readonly LogEvent[]): RgbStep[] {
  const invoiceEvent = lastEvent(events, 'funding.invoice_created');
  const seen = lastEvent(events, 'funding.payment_seen');
  const locked = lastEvent(events, 'funding.settled');
  const sent = lastEvent(events, 'payout.sent', 'refund.sent');
  const settled = lastEvent(events, 'payout.settled', 'refund.settled');
  const refund = sent?.type === 'refund.sent';
  const steps: RgbStep[] = [
    {
      title: 'Single-use RGB invoice from the escrow wallet',
      detail: "The agent's own WDK wallet asked for reward + fee. An RGB invoice names the asset, the amount, a blinded " +
        'Bitcoin output to receive on and the RGB proxy that carries the payment data. It can be paid exactly once.',
      value: e.fundingInvoice ?? str(invoiceEvent?.data?.['invoice']),
      at: invoiceEvent?.at,
      done: invoiceEvent !== undefined,
    },
    {
      title: "Client's refund invoice attached",
      detail: "Created by the client's own wallet when it pays, valid past the deadline: a refund never needs the client again.",
      value: e.refundInvoice,
      done: e.refundInvoice !== undefined,
    },
    {
      title: 'Payment data validated by the receiver',
      detail: "The client's wallet sent the transfer's consignment (the asset's history up to this payment) through the " +
        "proxy. The escrow wallet checked it itself: RGB is validated client-side, by whoever receives.",
      value: str(seen?.data?.['txid']),
      status: str(seen?.data?.['rawStatus']),
      at: seen?.at,
      done: seen !== undefined,
    },
    {
      title: 'Anchored in a Bitcoin transaction',
      detail: 'The transfer is committed inside a Bitcoin transaction. Once it confirms, the tUSDT is locked in escrow.',
      value: str(locked?.data?.['txid']),
      at: locked?.at,
      done: locked !== undefined,
    },
  ];
  if (e.payoutInvoice !== undefined && !refund) {
    steps.push({
      title: "Freelancer's payout invoice",
      detail: "Attached with the delivery by the freelancer's own wallet, so the agent can pay without asking anyone.",
      value: e.payoutInvoice,
      done: true,
    });
  }
  if (sent !== undefined) {
    steps.push({
      title: refund ? 'Refund sent to the client' : 'Reward sent to the freelancer',
      detail: refund
        ? "The escrow wallet paid reward + fee to the client's refund invoice."
        : "The escrow wallet paid the reward to the freelancer's invoice; the 2% service fee stays in the escrow wallet.",
      value: str(sent.data?.['txid']),
      at: sent.at,
      done: true,
    });
    steps.push({
      title: 'Confirmed on Bitcoin',
      detail: 'The payout transaction confirmed and both wallets recorded the transfer as settled.',
      value: str(settled?.data?.['txid']),
      at: settled?.at,
      done: settled !== undefined,
    });
  }
  return steps;
}

/** "rgb:2dkS…M98k" — invoices and txids are long; the full value stays in the title attribute. */
export const shorten = (s: string, keep = 10) => (s.length <= keep * 2 + 1 ? s : `${s.slice(0, keep)}…${s.slice(-keep)}`);
