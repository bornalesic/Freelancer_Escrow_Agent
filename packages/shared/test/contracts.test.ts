import { describe, expect, it } from 'vitest';
import {
  AGENT_ROUTES,
  AI_ROUTES,
  AiReviewSchema,
  ApproveRequestSchema,
  CONDITION_KINDS,
  ConditionSchema,
  CreateEscrowRequestSchema,
  CreateEscrowResponseSchema,
  DecisionSchema,
  DeliverySchema,
  EscrowSchema,
  LOG_EVENT_TYPES,
  ReviewRequestSchema,
  isAutomaticCondition,
  termsHash,
  type Condition,
  type Escrow,
} from '../src/index.ts';

const now = '2026-10-18T10:00:00.000Z';
const escrow: Escrow = {
  id: 'esc_7f3a', title: 'Landing', rawText: 'r', amount: '30000000', assetId: 'rgb:abc', assetTicker: 'tUSDT',
  precision: 6, deadline: '2026-10-18T12:00:00.000Z', state: 'AWAITING_APPROVAL',
  conditions: [
    { id: 'c1', kind: 'file_present', description: 'index.html', pathPattern: 'index.html' },
    { id: 'c2', kind: 'client_review', description: 'Warm colours' },
  ],
  acceptances: [], deliveries: [], createdAt: now, updatedAt: now,
};
const TOKEN = 'ab'.repeat(32);

describe('conditions', () => {
  it.each<[string, unknown, boolean]>([
    ['tests_pass', { id: 'c1', kind: 'tests_pass', description: 'd', command: 'npm test', timeoutSec: 60 }, true],
    ['tests_pass timeout over 600 s', { id: 'c1', kind: 'tests_pass', description: 'd', command: 'npm test', timeoutSec: 601 }, false],
    ['file_hash', { id: 'c1', kind: 'file_hash', description: 'd', sha256: 'a'.repeat(64) }, true],
    ['file_hash uppercase hex', { id: 'c1', kind: 'file_hash', description: 'd', sha256: 'A'.repeat(64) }, false],
    ['file_present', { id: 'c1', kind: 'file_present', description: 'd', pathPattern: 'README*' }, true],
    ['client_review', { id: 'c1', kind: 'client_review', description: 'Warm colours' }, true],
    ['client_review without description', { id: 'c1', kind: 'client_review', description: '' }, false],
    ['unknown kind', { id: 'c1', kind: 'vibes', description: 'd' }, false],
  ])('%s → valid=%s', (_name, input, ok) => {
    expect(ConditionSchema.safeParse(input).success).toBe(ok);
  });

  it('CONDITION_KINDS lists every kind; only client_review is not automatic', () => {
    expect([...CONDITION_KINDS].sort()).toEqual(['client_review', 'file_hash', 'file_present', 'tests_pass']);
    expect(escrow.conditions.map(isAutomaticCondition)).toEqual([true, false]);
  });

  it('termsHash covers client_review wording, so both parties agree on exactly what the client judges', () => {
    const terms = (conditions: Condition[]) => termsHash({ ...escrow, conditions });
    const reworded = escrow.conditions.map((c) => (c.kind === 'client_review' ? { ...c, description: 'Cold colours' } : c));
    expect(terms(reworded)).not.toBe(terms(escrow.conditions));
    expect(terms(escrow.conditions.slice(0, 1))).not.toBe(terms(escrow.conditions));
    expect(terms(escrow.conditions)).toBe(terms(structuredClone(escrow.conditions)));
  });
});

describe('client review contracts', () => {
  it('AWAITING_APPROVAL escrow with a full delivery round-trips through EscrowSchema', () => {
    const delivery = {
      n: 1, fileName: 'v1.zip', sha256: 'c'.repeat(64), sizeBytes: 10, at: now,
      results: [{ conditionId: 'c1', passed: true, evidence: { durationMs: 1 } }],
      reviewDueAt: '2026-10-18T10:02:00.000Z',
      review: { items: [{ conditionId: 'c2', opinion: 'looks_unmet', note: 'Header is dark blue.' }], source: 'ai', model: 'm', ms: 900 },
      approval: { decision: 'dispute', at: now, reason: 'Make it warm' },
    };
    const e = { ...escrow, deliveries: [delivery] };
    expect(EscrowSchema.parse(e)).toEqual(e);
  });

  it.each<[string, unknown, boolean]>([
    ['bad opinion', { items: [{ conditionId: 'c2', opinion: 'great', note: 'n' }], source: 'ai', ms: 1 }, false],
    ['bad source', { items: [], source: 'gpt', ms: 1 }, false],
    ['template, no model', { items: [{ conditionId: 'c2', opinion: 'unsure', note: 'n' }], source: 'template', ms: 0 }, true],
  ])('AiReview %s → valid=%s', (_name, input, ok) => {
    expect(AiReviewSchema.safeParse(input).success).toBe(ok);
  });

  it('Delivery rejects a non-ISO reviewDueAt', () => {
    const d = { n: 1, fileName: 'f', sha256: 'c'.repeat(64), sizeBytes: 1, at: now, reviewDueAt: 'in two minutes' };
    expect(DeliverySchema.safeParse(d).success).toBe(false);
  });

  it.each<[string, unknown, boolean]>([
    ['approve', { deliveryN: 1, decision: 'approve', clientToken: TOKEN }, true],
    ['approve with a reason', { deliveryN: 1, decision: 'approve', reason: 'great', clientToken: TOKEN }, true],
    ['dispute with reason', { deliveryN: 2, decision: 'dispute', reason: 'Header is blue', clientToken: TOKEN }, true],
    ['dispute without reason', { deliveryN: 1, decision: 'dispute', clientToken: TOKEN }, false],
    ['dispute with only spaces', { deliveryN: 1, decision: 'dispute', reason: '   ', clientToken: TOKEN }, false],
    ['no token', { deliveryN: 1, decision: 'approve' }, false],
    ['deliveryN 0', { deliveryN: 0, decision: 'approve', clientToken: TOKEN }, false],
    ['deliveryN as string', { deliveryN: '1', decision: 'approve', clientToken: TOKEN }, false],
    ['unknown decision', { deliveryN: 1, decision: 'maybe', clientToken: TOKEN }, false],
  ])('ApproveRequest %s → valid=%s', (_name, input, ok) => {
    expect(ApproveRequestSchema.safeParse(input).success).toBe(ok);
  });

  it('a dispute without a reason points at the reason field', () => {
    const r = ApproveRequestSchema.safeParse({ deliveryN: 1, decision: 'dispute', clientToken: TOKEN });
    expect(r.success).toBe(false);
    expect(r.error!.issues[0]!.path).toEqual(['reason']);
  });

  it('clientToken is in the create response only, never in Escrow (escrows are broadcast)', () => {
    const created = CreateEscrowResponseSchema.parse({ ...escrow, clientToken: TOKEN });
    expect(created.clientToken).toBe(TOKEN);
    expect('clientToken' in EscrowSchema.parse(created)).toBe(false);
    expect(Object.keys(EscrowSchema.shape)).not.toContain('clientToken');
    expect(CreateEscrowResponseSchema.safeParse({ ...escrow, clientToken: 'short' }).success).toBe(false);
  });

  it('await_approval decision lists the pending client_review ids', () => {
    expect(DecisionSchema.safeParse({ action: 'await_approval', reason: 'r', pending: ['c2'] }).success).toBe(true);
    expect(DecisionSchema.safeParse({ action: 'await_approval', reason: 'r' }).success).toBe(false);
  });

  it('ReviewRequest: excerpt is optional (absent for binaries)', () => {
    const files = [{ path: 'index.html', sizeBytes: 5, excerpt: '<h1>' }, { path: 'logo.png', sizeBytes: 9 }];
    expect(ReviewRequestSchema.safeParse({ escrow, deliveryN: 1, files }).success).toBe(true);
  });

  it('the four review.* events exist', () => {
    expect(LOG_EVENT_TYPES).toEqual(
      expect.arrayContaining(['review.report_ready', 'review.approved', 'review.disputed', 'review.expired']),
    );
  });
});

describe('routes', () => {
  it.each([
    [AGENT_ROUTES.approve('esc_1'), '/escrows/esc_1/approve'],
    [AGENT_ROUTES.approve(':id'), '/escrows/:id/approve'],
    [AGENT_ROUTES.deliveryFiles('esc_1', 2), '/escrows/esc_1/deliveries/2/files'],
    [AGENT_ROUTES.deliveryFiles(':id', ':n'), '/escrows/:id/deliveries/:n/files'],
    [AGENT_ROUTES.deliveryFile(':id', ':n', '*'), '/escrows/:id/deliveries/:n/files/*'],
    [AGENT_ROUTES.deliveryFile('esc_1', 1, 'css/main.css'), '/escrows/esc_1/deliveries/1/files/css/main.css'],
    [AGENT_ROUTES.deliveryFile('esc_1', 1, 'my page#1.html'), '/escrows/esc_1/deliveries/1/files/my%20page%231.html'],
    [AI_ROUTES.review, '/review'],
  ])('%s', (actual, expected) => {
    expect(actual).toBe(expected);
  });
});

describe('create request', () => {
  it.each<[string, unknown, boolean]>([
    ['valid', { title: 'T', rawText: 'R', amount: '50000000', deadline: '2026-10-18T12:00:00Z' }, true],
    ['zero amount', { title: 'T', rawText: 'R', amount: '0', deadline: '2026-10-18T12:00:00Z' }, false],
    ['decimal amount', { title: 'T', rawText: 'R', amount: '1.5', deadline: '2026-10-18T12:00:00Z' }, false],
    ['number amount', { title: 'T', rawText: 'R', amount: 50, deadline: '2026-10-18T12:00:00Z' }, false],
    ['blank title', { title: '  ', rawText: 'R', amount: '1', deadline: '2026-10-18T12:00:00Z' }, false],
    ['no timezone', { title: 'T', rawText: 'R', amount: '1', deadline: '2026-10-18T12:00:00' }, false],
  ])('%s → valid=%s', (_name, input, ok) => {
    expect(CreateEscrowRequestSchema.safeParse(input).success).toBe(ok);
  });
});
