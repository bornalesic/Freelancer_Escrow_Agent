import { LOG_EVENT_TYPES } from '@escrow/shared';
import { describe, expect, it } from 'vitest';
import { cleanExplanation, explainEvent, isGrounded } from '../src/explain.ts';
import { buildFacts, failingTestNames } from '../src/facts.ts';
import type { GenerateOptions, LlmEngine } from '../src/llm.ts';
import { templateFor } from '../src/templates.ts';
import { NODE_TEST_FAILURE, escrow, event, landingEscrow } from './fixtures.ts';

const failResult = { conditionId: 'c1', passed: false, evidence: { exitCode: 1, stdoutTail: NODE_TEST_FAILURE, durationMs: 900 } };

function fakeEngine(reply: string | Error, delayMs = 0): LlmEngine {
  return {
    status: () => ({ model: 'fake', device: 'cpu', loaded: true, loading: false, queued: 0 }),
    async generate(o: GenerateOptions) {
      await new Promise<void>((resolve, reject) => {
        const t = setTimeout(resolve, delayMs);
        o.signal.addEventListener('abort', () => { clearTimeout(t); reject(o.signal.reason); }, { once: true });
      });
      if (reply instanceof Error) throw reply;
      o.onDelta?.(reply);
      return { text: reply, ms: delayMs };
    },
  };
}
const deps = (engine: LlmEngine | null, budgetMs = 1000) => ({ engine, budgetMs, log: () => {} });

describe('facts + templates', () => {
  it('extracts failing test names from node --test output', () => {
    expect(failingTestNames(NODE_TEST_FAILURE)).toEqual(['strips punctuation: "Hello, World!" → "hello-world"']);
    expect(failingTestNames('✖ strips punctuation (1.2ms)\n✔ lowercases')).toEqual(['strips punctuation']);
  });

  it('has a short sentence for every event type', () => {
    for (const type of LOG_EVENT_TYPES) {
      const text = templateFor(buildFacts(event(type), escrow()));
      expect(text.length, type).toBeGreaterThan(10);
      expect(text.split(' ').length, type).toBeLessThanOrEqual(50);
      expect(text, type).not.toMatch(/undefined|NaN|\[object/);
    }
  });

  it('names the failing test in the condition result template', () => {
    const text = templateFor(buildFacts(event('verify.condition_result', { ...failResult }), escrow()));
    expect(text).toBe('The check "All the included tests must pass" failed: the test "strips punctuation: "Hello, World!" → "hello-world"" did not pass.');
  });

  it('quotes expected vs actual when the spec reporter shows them (the demo line)', () => {
    const tail = `✖ strips punctuation: "Hello, World!" → "hello-world" (0.8ms)\n  AssertionError [ERR_ASSERTION]: Expected values to be strictly equal:\n    actual: 'hello,-world!',\n    expected: 'hello-world',`;
    const facts = buildFacts(event('verify.condition_result', { ...failResult, evidence: { exitCode: 1, stdoutTail: tail, durationMs: 9 } }), escrow());
    expect(facts.result).toMatchObject({ expected: 'hello-world', actual: 'hello,-world!' });
    expect(templateFor(facts)).toMatch(/did not pass \(it expected "hello-world" but got "hello,-world!"\)\.$/);
  });

  it('formats amounts with precision and ticker', () => {
    const text = templateFor(buildFacts(event('funding.settled'), escrow()));
    expect(text).toContain('50 tUSDT');
  });

  it('uses the decision action', () => {
    const f = (action: string) => templateFor(buildFacts(event('decision.made', { decision: { action, reason: 'r' } }), escrow()));
    expect(f('release')).toContain('release 50 tUSDT to the freelancer');
    expect(f('retry')).toContain('stays locked');
    expect(f('refund')).toContain('refund 50 tUSDT to the client');
  });

  it('explains client review steps from the escrow, not from guesses', () => {
    const t = (e: ReturnType<typeof event>, esc = landingEscrow()) => templateFor(buildFacts(e, esc));
    expect(t(event('decision.made', { decision: { action: 'await_approval', reason: 'r', pending: ['c3'] } })))
      .toBe('Every automatic check passed, so the 50 tUSDT stays locked while the client reviews 1 item.');

    const approved = landingEscrow({ deliveries: [{ ...landingEscrow().deliveries[0]!, approval: { decision: 'approve', at: '2026-10-17T12:05:00Z' } }] });
    expect(t(event('decision.made', { decision: { action: 'release', reason: 'r' } }), approved)).toMatch(/^The client approved the delivery/);

    const disputed = landingEscrow({ deliveries: [{ ...landingEscrow().deliveries[0]!, approval: { decision: 'dispute', at: '2026-10-17T12:05:00Z', reason: 'header should be warm' } }] });
    expect(t(event('decision.made', { decision: { action: 'retry', reason: 'r', failed: ['c3'] } }), disputed)).toMatch(/^The client disputed the delivery/);
    expect(t(event('review.disputed', { n: 1 }), disputed)).toBe('The client disputed delivery #1: "header should be warm".');

    const reviewed = landingEscrow({ deliveries: [{ ...landingEscrow().deliveries[0]!, review: { items: [{ conditionId: 'c3', opinion: 'looks_unmet', note: 'Dark blue header.' }], source: 'ai', ms: 900 } }] });
    expect(t(event('review.report_ready', { n: 1 }), reviewed)).toBe("QVAC's advisory review of delivery #1 is ready (1 looks unmet); the client makes the call.");
    expect(t(event('terms.reparse_requested'))).toBe('The client asked for the agreement to be read again, so new terms will be proposed.');
  });
});

describe('cleanExplanation / isGrounded', () => {
  it('keeps quoted test names intact and strips markdown', () => {
    expect(cleanExplanation('**The test** "Hello, World!" → "hello-world" failed.')).toBe('The test "Hello, World!" → "hello-world" failed.');
  });

  it('cuts a truncated tail back to the last full sentence', () => {
    expect(cleanExplanation('The check failed. The freelancer can')).toBe('The check failed.');
    expect(cleanExplanation('The check failed because')).toBe('');
  });

  it('rejects numbers and money outcomes not in the facts', () => {
    const facts = buildFacts(event('funding.settled'), escrow());
    expect(isGrounded('50 tUSDT is now locked.', facts)).toBe(true);
    expect(isGrounded('60 tUSDT is now locked.', facts)).toBe(false);
    expect(isGrounded('The money will be released soon.', facts)).toBe(false);
  });

  it('rejects money talk on a step that is not about money (seen from the 2B model)', () => {
    const facts = buildFacts(event('verify.condition_result', { ...failResult }), escrow());
    expect(facts.amount).toBeUndefined();
    expect(isGrounded('The test "strips punctuation" did not pass. The client will receive 50 tUSDT.', facts)).toBe(false);
    expect(isGrounded('The test "strips punctuation" did not pass, so the check failed.', facts)).toBe(true);
    expect(isGrounded('The tests check passed.', facts)).toBe(false); // polarity flipped
  });

  it('rejects a missed deadline on a retry decision (seen from the 2B model)', () => {
    const retry = buildFacts(event('decision.made', { decision: { action: 'retry', reason: 'c1 failed' } }), escrow());
    expect(isGrounded('The 50 tUSDT stays locked because the deadline passed, so the freelancer can submit a fixed version.', retry)).toBe(false);
    expect(isGrounded('The 50 tUSDT stays locked, and the freelancer can submit a fixed version before the deadline.', retry)).toBe(true);
  });
});

describe('explainEvent', () => {
  const req = { event: event('funding.settled'), escrow: escrow() };

  it('returns grounded AI text', async () => {
    const deltas: string[] = [];
    const r = await explainEvent(req, deps(fakeEngine('The client locked 50 tUSDT in escrow.')), (t) => deltas.push(t));
    expect(r).toEqual({ text: 'The client locked 50 tUSDT in escrow.', source: 'ai' });
    expect(deltas.join('')).toBe(r.text);
  });

  it('falls back to the template on timeout, error, ungrounded output, or no model', async () => {
    const template = templateFor(buildFacts(req.event, req.escrow));
    expect(await explainEvent(req, deps(fakeEngine('slow.', 500), 50))).toEqual({ text: template, source: 'template' });
    expect(await explainEvent(req, deps(fakeEngine(new Error('boom'))))).toEqual({ text: template, source: 'template' });
    expect(await explainEvent(req, deps(fakeEngine('You will get 99 tUSDT.')))).toEqual({ text: template, source: 'template' });
    expect(await explainEvent(req, deps(null))).toEqual({ text: template, source: 'template' });
  });
});
