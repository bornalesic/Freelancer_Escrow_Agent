import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  ASSIST_SCHEMAS, DryRunResponseSchema, ExamplesConditionSchema, applyRewrite, verifiability,
} from '@escrow/shared';
import { fixtureAssist, fixtureDryRun } from '../fixtures/assist';
import { assistFixtureEscrow, fixtureEscrow } from '../fixtures/snapshot';
import { DEMO_AGREEMENT } from './demo';
import { asAny, isExamples, termsMatch } from './terms';

// lib/assist reads the screen config (window.location) when imported; tests run without a DOM.
vi.stubGlobal('window', { location: { search: '' } });
const { assist, dryRun, isUnavailable, AssistUnavailable } = await import('./assist');

beforeEach(() => vi.useFakeTimers());
afterEach(() => {
  vi.useRealTimers();
  vi.unstubAllGlobals();
  vi.stubGlobal('window', { location: { search: '' } });
});

/** Runs a fixture call through its built-in delay. */
async function settle<T>(p: Promise<T>): Promise<T> {
  await vi.advanceTimersByTimeAsync(2_000);
  return p;
}

const terms = { title: assistFixtureEscrow.title, rawText: assistFixtureEscrow.rawText, conditions: assistFixtureEscrow.conditions };

describe('fixture assist answers match the contract', () => {
  it('every proxied assist', async () => {
    const results = {
      clarify: await settle(fixtureAssist('clarify', { title: 'x', rawText: 'Make me a tool that turns my notes into a report.' })),
      rewrite: await settle(fixtureAssist('rewrite', terms)),
      estimate: await settle(fixtureAssist('estimate', { title: 'x', rawText: DEMO_AGREEMENT.rawText, amountDisplay: '50', assetTicker: 'tUSDT', deadlineMinutes: 30 })),
      answer: await settle(fixtureAssist('answer', { ...terms, question: 'Do the docs need a README?' })),
      match: await settle(fixtureAssist('match', { skills: 'JavaScript, testing', jobs: [{ id: 'a', ...terms }] })),
      split: await settle(fixtureAssist('split', { ...terms, members: [{ name: 'Ana', skills: 'CSS, design' }, { name: 'Ben', skills: 'JavaScript' }] })),
    };
    for (const [name, r] of Object.entries(results)) {
      expect(() => ASSIST_SCHEMAS[name as keyof typeof results].result.parse(r), name).not.toThrow();
    }
    expect(results.clarify.questions.length).toBeGreaterThan(0);
    expect(results.split.assignments.flatMap((a) => a.conditionIds).sort()).toEqual(['c1', 'c2', 'c3']);
  });

  it('the rehearsed demo agreement gets no interview questions', async () => {
    const r = await settle(fixtureAssist('clarify', { title: DEMO_AGREEMENT.title, rawText: DEMO_AGREEMENT.rawText }));
    expect(r.questions).toEqual([]);
  });

  it('rewrites point at words that are in the agreement', async () => {
    const r = await settle(fixtureAssist('rewrite', terms));
    expect(r).toMatchObject({ automatic: 1, total: 3 });
    expect(r.suggestions.map((s) => s.becomes)).toEqual(['file_present', 'tests_pass']);
    const next = applyRewrite(terms.rawText, r.suggestions[0]!.quote, r.suggestions[0]!.rewrite);
    expect(next).toContain('Include a README.md file');
    expect(next).not.toContain('Make the docs nice');
  });

  it('a v1 practice upload fails the first check with a hint; anything else passes', async () => {
    const v1 = DryRunResponseSchema.parse(await settle(fixtureDryRun(fixtureEscrow.id, 'slugify-v1.zip')));
    expect(v1).toMatchObject({ passed: 1, total: 2 });
    expect(v1.hints?.items[0]).toMatchObject({ conditionId: 'c1', why: expect.stringContaining('hello,-world!') });
    const v2 = await settle(fixtureDryRun(fixtureEscrow.id, 'slugify-v2.zip'));
    expect(v2).toMatchObject({ passed: 2, total: 2 });
    expect(v2.hints).toBeUndefined();
  });
});

describe('the titleCase fixture (examples + client review)', () => {
  it('its termsHash is what the browser recomputes, examples included', () => {
    expect(termsMatch(assistFixtureEscrow)).toBe(true);
  });

  it('holds a valid examples condition and scores 1 of 3', () => {
    const c = asAny(assistFixtureEscrow.conditions[0]!);
    expect(isExamples(c)).toBe(true);
    expect(() => ExamplesConditionSchema.parse(c)).not.toThrow();
    expect(verifiability(assistFixtureEscrow.conditions)).toEqual({ automatic: 1, total: 3 });
  });
});

describe('assist() against an agent', () => {
  const reply = (status: number, body: unknown) => vi.fn(async () => new Response(JSON.stringify(body), { status }));

  it('passes a result through', async () => {
    vi.stubGlobal('fetch', reply(200, { questions: [], source: 'ai', ms: 1 }));
    await expect(assist('clarify', { title: 'x', rawText: 'y' })).resolves.toMatchObject({ source: 'ai' });
  });

  it('no route yet (404) → unavailable, and the route is not asked again', async () => {
    const fetch = reply(404, { error: 'Not Found' });
    vi.stubGlobal('fetch', fetch);
    const req = { title: 'x', rawText: 'y', amountDisplay: '1', assetTicker: 't', deadlineMinutes: 1 };
    const err = await assist('estimate', req).catch((e: unknown) => e);
    expect(isUnavailable(err) && (err as InstanceType<typeof AssistUnavailable>).permanent).toBe(true);
    await expect(assist('estimate', req)).rejects.toBeInstanceOf(AssistUnavailable);
    expect(fetch).toHaveBeenCalledTimes(1);
  });

  it('AI down (503) → unavailable for now; a bad request (400) is a real error', async () => {
    vi.stubGlobal('fetch', reply(503, { error: 'The AI assistant is not available right now' }));
    const err = await assist('answer', { ...terms, question: 'why?' }).catch((e: unknown) => e);
    expect(isUnavailable(err) && !(err as InstanceType<typeof AssistUnavailable>).permanent).toBe(true);
    vi.stubGlobal('fetch', reply(400, { error: 'invalid request body' }));
    await expect(assist('answer', { ...terms, question: 'why?' })).rejects.toThrow('invalid request body');
  });

  it('dry run: "Escrow not found" is an error, a missing route is unavailable', async () => {
    const file = new File(['x'], 'v1.zip');
    vi.stubGlobal('fetch', reply(404, { error: 'Escrow not found' }));
    await expect(dryRun('esc_x', file)).rejects.toThrow('Escrow not found');
    vi.stubGlobal('fetch', reply(404, { error: 'Not Found' }));
    await expect(dryRun('esc_x', file)).rejects.toBeInstanceOf(AssistUnavailable);
  });
});
