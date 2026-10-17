import { describe, expect, it } from 'vitest';
import type { AiReview, Condition, Delivery, EscrowState, VerificationResult } from '@escrow/shared';
import { decide } from '../src/decide';

const DEADLINE = '2026-10-18T12:00:00.000Z';
const BEFORE = new Date('2026-10-18T11:59:59.999Z');
const AT = new Date(DEADLINE);
const AFTER = new Date('2026-10-18T12:00:00.001Z');

const conditions: Condition[] = [
  { id: 'c1', kind: 'tests_pass', description: 'Tests pass', command: 'npm test', timeoutSec: 60 },
  { id: 'c2', kind: 'file_present', description: 'README included', pathPattern: 'README*' },
];

const r = (conditionId: string, passed: boolean): VerificationResult => ({
  conditionId,
  passed,
  evidence: { durationMs: 1 },
});

const ALL_PASS = [r('c1', true), r('c2', true)];
const ONE_FAIL = [r('c1', false), r('c2', true)];
const ALL_FAIL = [r('c1', false), r('c2', false)];
const MISSING = [r('c1', true)];
const EXTRA_UNKNOWN = [r('c1', true), r('c2', true), r('zz', false)];

type Case = [string, EscrowState, readonly VerificationResult[], Date, string, string[]?];

const cases: Case[] = [
  // VERIFYING
  ['all pass before deadline', 'VERIFYING', ALL_PASS, BEFORE, 'release'],
  ['all pass exactly at deadline', 'VERIFYING', ALL_PASS, AT, 'release'],
  ['all pass after deadline', 'VERIFYING', ALL_PASS, AFTER, 'release'],
  ['unknown extra result is ignored', 'VERIFYING', EXTRA_UNKNOWN, BEFORE, 'release'],
  ['one fails before deadline', 'VERIFYING', ONE_FAIL, BEFORE, 'retry', ['c1']],
  ['all fail before deadline', 'VERIFYING', ALL_FAIL, BEFORE, 'retry', ['c1', 'c2']],
  ['missing result counts as failed', 'VERIFYING', MISSING, BEFORE, 'retry', ['c2']],
  ['no results before deadline', 'VERIFYING', [], BEFORE, 'retry', ['c1', 'c2']],
  ['one fails exactly at deadline', 'VERIFYING', ONE_FAIL, AT, 'refund'],
  ['one fails after deadline', 'VERIFYING', ONE_FAIL, AFTER, 'refund'],
  ['missing result after deadline', 'VERIFYING', MISSING, AFTER, 'refund'],
  // FUNDED (deadline ticker)
  ['funded before deadline', 'FUNDED', [], BEFORE, 'wait'],
  ['funded exactly at deadline', 'FUNDED', [], AT, 'refund'],
  ['funded after deadline', 'FUNDED', [], AFTER, 'refund'],
  ['funded ignores results', 'FUNDED', ALL_PASS, BEFORE, 'wait'],
];

const otherStates: EscrowState[] = [
  'DRAFT', 'PROPOSED', 'AGREED', 'AWAITING_FUNDS', 'DELIVERED', 'AWAITING_APPROVAL',
  'RELEASING', 'RELEASED', 'REFUNDING', 'REFUNDED', 'CANCELLED',
];
for (const s of otherStates) {
  cases.push([`${s} with all passing, after deadline`, s, ALL_PASS, AFTER, 'wait']);
  cases.push([`${s} with failures, before deadline`, s, ONE_FAIL, BEFORE, 'wait']);
}

describe('decide', () => {
  it.each(cases)('%s → %s', (_name, state, results, now, action, failed) => {
    const d = decide({ state, deadline: DEADLINE, conditions }, results, now);
    expect(d.action).toBe(action);
    expect(d.reason).toBeTruthy();
    if (failed) expect(d).toMatchObject({ failed });
  });

  it('never releases an escrow without conditions', () => {
    const e = { state: 'VERIFYING' as const, deadline: DEADLINE, conditions: [] };
    expect(decide(e, [], BEFORE)).toMatchObject({ action: 'retry', failed: [] });
    expect(decide(e, [], AFTER).action).toBe('refund');
  });

  it('is pure: same input, same output', () => {
    const e = { state: 'VERIFYING' as const, deadline: DEADLINE, conditions };
    expect(decide(e, ONE_FAIL, BEFORE)).toEqual(decide(e, ONE_FAIL, BEFORE));
  });
});

// ---- client review ----------------------------------------------------------------------------

const withReview: Condition[] = [
  ...conditions,
  { id: 'c3', kind: 'client_review', description: 'The page uses warm colours' },
];
const REVIEW_DUE = '2026-10-18T11:00:00.000Z';
const BEFORE_DUE = new Date('2026-10-18T10:59:59.999Z');
const AT_DUE = new Date(REVIEW_DUE);

const delivery = (n: number, extra: Partial<Delivery> = {}): Delivery => ({
  n,
  fileName: 'x.zip',
  sha256: 'a'.repeat(64),
  sizeBytes: 1,
  at: '2026-10-18T10:00:00.000Z',
  reviewDueAt: REVIEW_DUE,
  ...extra,
});
const approve = { decision: 'approve' as const, at: '2026-10-18T10:30:00.000Z' };
const dispute = { decision: 'dispute' as const, at: '2026-10-18T10:30:00.000Z', reason: 'Header is blue' };

describe('decide with client review', () => {
  type ReviewCase = [string, EscrowState, Delivery[], readonly VerificationResult[], Date, string, Record<string, unknown>?];
  const reviewCases: ReviewCase[] = [
    // VERIFYING: only automatic results count; client_review never gets one
    ['automatic pass → await approval', 'VERIFYING', [delivery(1)], ALL_PASS, BEFORE, 'await_approval', { pending: ['c3'] }],
    ['automatic pass after deadline → still await approval', 'VERIFYING', [delivery(1)], ALL_PASS, AFTER, 'await_approval'],
    ['automatic fail → retry, only automatic ids', 'VERIFYING', [delivery(1)], ONE_FAIL, BEFORE, 'retry', { failed: ['c1'] }],
    ['automatic fail after deadline → refund', 'VERIFYING', [delivery(1)], ONE_FAIL, AFTER, 'refund'],
    // AWAITING_APPROVAL
    ['approved', 'AWAITING_APPROVAL', [delivery(1, { approval: approve })], [], BEFORE_DUE, 'release'],
    ['approved after deadline', 'AWAITING_APPROVAL', [delivery(1, { approval: approve })], [], AFTER, 'release'],
    ['disputed before deadline', 'AWAITING_APPROVAL', [delivery(1, { approval: dispute })], [], BEFORE, 'retry', { failed: ['c3'] }],
    ['disputed exactly at deadline', 'AWAITING_APPROVAL', [delivery(1, { approval: dispute })], [], AT, 'refund'],
    ['disputed after deadline', 'AWAITING_APPROVAL', [delivery(1, { approval: dispute })], [], AFTER, 'refund'],
    ['no answer, window open', 'AWAITING_APPROVAL', [delivery(1)], [], BEFORE_DUE, 'wait'],
    ['no answer, window closed', 'AWAITING_APPROVAL', [delivery(1)], [], AT_DUE, 'release'],
    ['deadline alone never refunds', 'AWAITING_APPROVAL', [delivery(1, { reviewDueAt: '2026-10-18T13:00:00.000Z' })], [], AFTER, 'wait'],
    ['no reviewDueAt → wait', 'AWAITING_APPROVAL', [delivery(1, { reviewDueAt: undefined })], [], AFTER, 'wait'],
    ['no delivery → wait', 'AWAITING_APPROVAL', [], [], AFTER, 'wait'],
    ['only the latest delivery counts', 'AWAITING_APPROVAL', [delivery(1, { approval: approve }), delivery(2)], [], BEFORE_DUE, 'wait'],
    ['results are ignored', 'AWAITING_APPROVAL', [delivery(1)], ALL_FAIL, BEFORE_DUE, 'wait'],
  ];

  it.each(reviewCases)('%s → %s', (_name, state, deliveries, results, now, action, extra) => {
    const d = decide({ state, deadline: DEADLINE, conditions: withReview, deliveries }, results, now);
    expect(d.action).toBe(action);
    expect(d.reason).toBeTruthy();
    if (extra) expect(d).toMatchObject(extra);
  });

  it('only client_review conditions → await approval (client decides everything)', () => {
    const only: Condition[] = [{ id: 'c1', kind: 'client_review', description: 'Looks clean' }];
    expect(decide({ state: 'VERIFYING', deadline: DEADLINE, conditions: only }, [], BEFORE)).toMatchObject({
      action: 'await_approval',
      pending: ['c1'],
    });
  });

  it('never reads the AI review: flipping every opinion changes nothing', () => {
    const opinions = ['looks_met', 'looks_unmet', 'unsure'] as const;
    const review = (opinion: (typeof opinions)[number], source: AiReview['source']): AiReview => ({
      items: [{ conditionId: 'c3', opinion, note: 'n' }],
      source,
      ms: 1,
    });
    const states: EscrowState[] = ['VERIFYING', 'AWAITING_APPROVAL'];
    const approvals = [undefined, approve, dispute];
    for (const state of states) {
      for (const approval of approvals) {
        for (const now of [BEFORE_DUE, AT_DUE, BEFORE, AFTER]) {
          for (const results of [ALL_PASS, ONE_FAIL]) {
            const base = delivery(1, approval ? { approval } : {});
            const expected = decide({ state, deadline: DEADLINE, conditions: withReview, deliveries: [base] }, results, now);
            for (const opinion of opinions) {
              for (const source of ['ai', 'template'] as const) {
                const withAi = { ...base, review: review(opinion, source) };
                expect(decide({ state, deadline: DEADLINE, conditions: withReview, deliveries: [withAi] }, results, now)).toEqual(expected);
              }
            }
          }
        }
      }
    }
  });
});
