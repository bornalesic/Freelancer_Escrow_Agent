// Smoke render of the AI assist components with fixture data (no DOM: react-dom/server). Catches render-time
// crashes and checks the key words people rely on are on screen.
import { createElement as h } from 'react';
import { renderToString } from 'react-dom/server';
import { describe, expect, it, vi } from 'vitest';
import type { ClarifyQuestion, ExamplesCondition } from '@escrow/shared';
import { assistFixtureEscrow, fixtureEscrow } from '../fixtures/snapshot';

vi.stubGlobal('window', { location: { search: '' } }); // lib/api reads the screen config on import
const { TermsView, ConditionCard } = await import('./Terms');
const { InterviewCard } = await import('./Interview');
const { DryRunResult } = await import('./DryRun');
const { ExamplesTable } = await import('./Examples');
const { VerifiabilityBadge } = await import('./Verifiability');
const { AskAboutJob } = await import('./AskAboutJob');
const { TeamSplit } = await import('./TeamSplit');
const { MakeCheckable } = await import('./Checkable');

// Visible text: React's <!-- --> text-node separators vanish, element boundaries become spaces.
const text = (html: string) =>
  html.replace(/<!-- -->/g, '').replace(/<[^>]+>/g, ' ').replace(/&quot;/g, '"').replace(/&#x27;/g, "'").replace(/\s+/g, ' ');
const examples = assistFixtureEscrow.conditions[0] as unknown as ExamplesCondition;

describe('AI assist components render', () => {
  it('terms with an examples check: score, table, download, client-review items', () => {
    const out = text(renderToString(h(TermsView, { escrow: assistFixtureEscrow, role: 'client' })));
    expect(out).toContain('1 of 3 checked automatically');
    expect(out).toContain('Example outputs');
    expect(out).toContain('titleCase("hello world")');
    expect(out).toContain('"Hello World"');
    expect(out).toContain('Download acceptance test');
    expect(out).toContain('You decide: Make the docs nice.');
  });

  it('a failed examples result shows no table (the output is in the delivery details)', () => {
    const out = text(renderToString(h(ConditionCard, { condition: assistFixtureEscrow.conditions[0]!, status: 'fail' })));
    expect(out).toContain('titleCase() · 2 examples');
    expect(out).not.toContain('Download acceptance test');
  });

  it('interview questions with options', () => {
    const qs: ClarifyQuestion[] = [{ id: 'q1', topic: 'Language', question: 'Which language?', why: 'The checks run the code.', options: ['Python', 'JavaScript'] }];
    const out = text(renderToString(h(InterviewCard, { questions: qs, answers: { q1: 'Python' }, onAnswer: () => {}, onUse: () => {}, onSkip: () => {}, busy: false })));
    expect(out).toContain('QVAC has a question first');
    expect(out).toContain('Add 1 answer and turn into checks');
    expect(out).toContain('Skip, use the text as written');
  });

  it('practice check result with the QVAC hint', () => {
    const result = {
      results: [
        { conditionId: 'c1', passed: false, evidence: { exitCode: 1, durationMs: 9, stdoutTail: 'x' } },
        { conditionId: 'c2', passed: true, evidence: { durationMs: 1 } },
      ],
      passed: 1, total: 2,
      hints: { items: [{ conditionId: 'c1', why: 'The test failed: expected "hello-world".', hint: 'Look at slugify.js.' }], source: 'ai' as const, ms: 5 },
    };
    const out = text(renderToString(h(DryRunResult, { escrow: fixtureEscrow, result, fileName: 'slugify-v1.zip' })));
    expect(out).toContain('1 of 2 passed');
    expect(out).toContain('Nothing was submitted');
    expect(out).toContain('QVAC hint · advice only');
    expect(out).toContain('Look at slugify.js.');
  });

  it('the rest: badge, examples table, Q&A box, team split, rewrite row', () => {
    expect(text(renderToString(h(VerifiabilityBadge, { conditions: fixtureEscrow.conditions, compact: true })))).toContain('2/2 automatic');
    expect(text(renderToString(h(ExamplesTable, { condition: examples })))).toContain('Must give');
    expect(text(renderToString(h(AskAboutJob, { escrow: assistFixtureEscrow })))).toContain('Ask QVAC');
    expect(text(renderToString(h(TeamSplit, { escrow: assistFixtureEscrow })))).toContain('Split this job with my team');
    const s = { conditionId: 'c2', quote: 'Make the docs nice', rewrite: 'Include a README.md file.', becomes: 'file_present' as const };
    expect(text(renderToString(h(MakeCheckable, { escrow: assistFixtureEscrow, suggestion: s })))).toContain('Make it checkable: “Include a README.md file.”');
  });
});
