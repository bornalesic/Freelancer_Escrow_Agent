import { describe, expect, it } from 'vitest';
import { EscrowStateSchema, type Escrow, type EscrowState, type LogEvent, type Offer } from '@escrow/shared';
import {
  STATE_LABEL,
  conditionInfo,
  countdown,
  displayText,
  filterListings,
  frozen,
  money,
  openOffers,
  relativeTime,
  rgbTrail,
  shorten,
  sortListings,
} from './format';

const NOW = Date.parse('2026-10-18T10:00:00.000Z');
const asset = { precision: 6, assetTicker: 'TUSDT' };

function escrow(over: Partial<Escrow>): Escrow {
  return {
    id: 'esc_1', title: 'Job', rawText: 'x', amount: '50000000', fee: '1000000', assetId: 'rgb:a', assetTicker: 'TUSDT',
    precision: 6, deadline: '2026-10-18T12:00:00.000Z', state: 'OPEN', conditions: [], acceptances: [], deliveries: [],
    createdAt: '2026-10-18T09:00:00.000Z', updatedAt: '2026-10-18T09:00:00.000Z', ...over,
  };
}

const event = (type: LogEvent['type'], data: Record<string, unknown> = {}): LogEvent => ({
  id: `esc_1:${type}`, escrowId: 'esc_1', at: '2026-10-18T10:00:00.000Z', actor: 'agent', type, title: type, data, explain: false,
});

describe('plain labels', () => {
  it('uses the plain labels from the change request for every state (Split comes with the 90/10 rule)', () => {
    expect(new Set(EscrowStateSchema.options.map((s) => STATE_LABEL[s]))).toEqual(new Set([
      'Draft', 'Reviewing requirements', 'Open', 'Funding', 'In progress', 'Checking work', 'Waiting for client',
      'Paid', 'Refunded', 'Cancelled',
    ]));
  });

  it('shows tUSDT, not the upper-case ticker rgb-lib needs', () => {
    expect(money('51000000', asset)).toBe('51 tUSDT');
    expect(money('1500000', asset)).toBe('1.5 tUSDT');
    expect(displayText('51 TUSDT locked in escrow')).toBe('51 tUSDT locked in escrow');
  });

  it('marks which requirements the verifier checks and which the client reviews', () => {
    expect(conditionInfo({ id: 'c1', kind: 'tests_pass', description: 'd', command: 'npm test', timeoutSec: 60 })).toMatchObject({ automatic: true, label: 'Tests must pass' });
    expect(conditionInfo({ id: 'c2', kind: 'client_review', description: 'Looks clean' })).toMatchObject({ automatic: false, label: 'Client reviews' });
  });
});

describe('time', () => {
  it('says when, in words', () => {
    expect(relativeTime('2026-10-18T10:20:00.000Z', NOW)).toBe('in 20 min');
    expect(relativeTime('2026-10-18T09:57:00.000Z', NOW)).toBe('3 min ago');
    expect(relativeTime('2026-10-18T13:00:00.000Z', NOW)).toBe('in 3 h');
  });
  it('counts down short windows and never below zero', () => {
    expect(countdown('2026-10-18T10:09:41.000Z', NOW)).toBe('9:41');
    expect(countdown('2026-10-18T09:00:00.000Z', NOW)).toBe('0:00');
  });
});

describe('frozen funds (what the agent may see)', () => {
  it('is reward + fee only while the agent holds the money', () => {
    const held: EscrowState[] = ['FUNDED', 'DELIVERED', 'VERIFYING', 'AWAITING_APPROVAL', 'RELEASING', 'REFUNDING'];
    for (const state of EscrowStateSchema.options) {
      expect(frozen(escrow({ state }))).toBe(held.includes(state) ? '51000000' : '0');
    }
  });
});

describe('marketplace', () => {
  const a = escrow({ id: 'a', amount: '10000000', deadline: '2026-10-18T11:00:00.000Z' });
  const b = escrow({ id: 'b', amount: '90000000', deadline: '2026-10-18T15:00:00.000Z' });
  const c = escrow({ id: 'c', amount: '50000000', deadline: '2026-10-18T10:30:00.000Z' });

  it('sorts by reward and by deadline', () => {
    expect(sortListings([a, b, c], 'reward-desc').map((e) => e.id)).toEqual(['b', 'c', 'a']);
    expect(sortListings([a, b, c], 'reward-asc').map((e) => e.id)).toEqual(['a', 'c', 'b']);
    expect(sortListings([a, b, c], 'deadline-asc').map((e) => e.id)).toEqual(['c', 'a', 'b']);
  });

  it('shows only open jobs that are still takeable, filtered by reward and deadline', () => {
    const taken = escrow({ id: 't', state: 'AWAITING_FUNDS' });
    const expired = escrow({ id: 'x', deadline: '2026-10-18T09:00:00.000Z' });
    expect(filterListings([a, b, c, taken, expired], { now: NOW }).map((e) => e.id)).toEqual(['a', 'b', 'c']);
    expect(filterListings([a, b, c], { now: NOW, minReward: '50000000' }).map((e) => e.id)).toEqual(['b', 'c']);
    expect(filterListings([a, b, c], { now: NOW, dueWithinMs: 2 * 3600_000 }).map((e) => e.id)).toEqual(['a', 'c']);
  });
});

describe('counteroffers', () => {
  const offer = (id: string, over: Partial<Offer> = {}): Offer => ({
    id, amount: '40000000', fee: '800000', termsHash: 'a'.repeat(64), at: '2026-10-18T09:55:00.000Z',
    expiresAt: '2026-10-18T10:10:00.000Z', status: 'pending', ...over,
  });

  it('lists only offers the client can still accept', () => {
    const e = escrow({ offers: [offer('o1'), offer('o2', { status: 'withdrawn' }), offer('o3', { expiresAt: '2026-10-18T09:59:59.000Z' })] });
    expect(openOffers(e, NOW).map((o) => o.id)).toEqual(['o1']);
    expect(openOffers(escrow({}), NOW)).toEqual([]);
  });
});

describe('RGB under the hood', () => {
  it('follows the money from the agent log: invoice → consignment → Bitcoin anchor → payout', () => {
    const e = escrow({ state: 'RELEASED', fundingInvoice: 'rgb:fund', refundInvoice: 'rgb:refund', payoutInvoice: 'rgb:payout' });
    const steps = rgbTrail(e, [
      event('funding.invoice_created', { invoice: 'rgb:fund' }),
      event('funding.payment_seen', { txid: 'aa', rawStatus: 'WaitingConfirmations' }),
      event('funding.settled', { txid: 'aa' }),
      event('payout.sent', { txid: 'bb' }),
      event('payout.settled', { txid: 'bb' }),
    ]);
    expect(steps.map((s) => s.done)).toEqual([true, true, true, true, true, true, true]);
    expect(steps.find((s) => s.title.startsWith('Payment data'))).toMatchObject({ value: 'aa', status: 'WaitingConfirmations' });
    expect(steps.at(-2)!.detail).toMatch(/service fee stays/);
  });

  it('shows the steps still to come, and a refund instead of a payout', () => {
    expect(rgbTrail(escrow({ state: 'OPEN' }), []).every((s) => !s.done)).toBe(true);
    const refunded = rgbTrail(escrow({ state: 'REFUNDED', payoutInvoice: 'rgb:payout' }), [event('refund.sent', { txid: 'cc' })]);
    expect(refunded.map((s) => s.title)).toContain('Refund sent to the client');
    expect(refunded.map((s) => s.title)).not.toContain("Freelancer's payout invoice");
  });

  it('shortens long invoices and txids', () => {
    expect(shorten('a'.repeat(64), 6)).toBe('aaaaaa…aaaaaa');
    expect(shorten('short')).toBe('short');
  });
});
