import { CONDITION_KINDS, ExamplesConditionSchema, type ParseRequest } from '@escrow/shared';
import { describe, expect, it } from 'vitest';
import {
  cleanCases, coveredByExamples, examplesDraft, examplesInContract, findTarget, literalExamples, outputRules, proposeExamples,
} from '../src/examples.ts';
import { fallbackParse } from '../src/fallback.ts';
import type { GenerateOptions, LlmEngine } from '../src/llm.ts';
import { parseAgreement } from '../src/parse.ts';
import { slugify } from './fixtures.ts';

const req = (rawText: string): ParseRequest => ({ ...slugify, rawText });

/** Fake model: answers the parse call and the two examples-v3 calls (inputs, then outputs) with fixed JSON. */
function fakeEngine(parts: { parse?: unknown; inputs?: unknown | Error; outputs?: unknown }) {
  const calls: string[] = [];
  const engine: LlmEngine = {
    status: () => ({ model: 'fake', device: 'cpu', loaded: true, loading: false, queued: 0 }),
    async generate(o: GenerateOptions) {
      const schema = JSON.stringify(o.jsonSchema);
      const which = schema.includes('"acts_on"') ? 'inputs' : schema.includes('"steps"') ? 'outputs' : 'parse';
      calls.push(which);
      const reply = parts[which];
      if (reply instanceof Error) throw reply;
      return { text: JSON.stringify(reply ?? {}), ms: 3 };
    },
  };
  return { engine, calls };
}

/** examples-v3 replies for the demo's three rules: one input per rule, then every rule applied step by step. */
const step = (a: string, b: string, c: string) => ({ steps: [`lowercases text: ${a}`, `replaces spaces with dashes: ${b}`, `strips anything else: ${c}`], expected: c });
const SLUGIFY_INPUTS = { r1: { acts_on: 'capitals', input: 'HELLO' }, r2: { acts_on: 'spaces', input: 'Top 10 tips' }, r3: { acts_on: 'punctuation', input: 'Hello, World!' } };
const SLUGIFY_OUTPUTS = {
  i1: step('hello', 'hello', 'hello'),
  i2: step('top 10 tips', 'top-10-tips', 'top-10-tips'),
  i3: step('hello, world!', 'hello,-world!', 'hello-world'),
};

const SLUGIFY_PARSE = {
  deliverable: 'A JavaScript slugify function.',
  conditions: [
    { kind: 'tests_pass', description: 'All the included tests must pass.', command: 'npm test', timeoutSec: 60 },
    { kind: 'file_present', description: 'A README file must be included.', pathPattern: 'README*' },
  ],
  review: [], unclear: [],
};

describe('examples: what is checked', () => {
  it('finds the JS function of the demo agreement', () => {
    expect(findTarget(slugify.rawText)).toEqual({ type: 'js_function', export: 'slugify' });
  });

  it('takes the one named .js file, ignoring test files', () => {
    expect(findTarget('Write a JavaScript function `toSlug` in lib/slug.js. Tests go in slug.test.js.'))
      .toEqual({ type: 'js_function', export: 'toSlug', file: 'lib/slug.js' });
  });

  it('needs JavaScript (the verifier imports it with Node) and a written name', () => {
    expect(findTarget('Write a Python function `slugify` that lowercases text.')).toBeUndefined();
    expect(findTarget('Write a JavaScript function that lowercases text.')).toBeUndefined();
  });

  it('finds a CLI command written in backticks, but never a test command', () => {
    expect(findTarget('A CLI `node sum.js` reads two numbers on stdin and prints the sum.')).toEqual({ type: 'command', command: 'node sum.js' });
    expect(findTarget('`node --test` must pass and it prints a report.')).toBeUndefined();
  });

  it('is on exactly when WS3 has added the kind to ConditionSchema', () => {
    expect(examplesInContract()).toBe((CONDITION_KINDS as readonly string[]).includes('examples'));
  });
});

describe('examples: literal ones from the agreement', () => {
  const t = { type: 'js_function', export: 'slugify' } as const;
  it('reads quoted pairs with an arrow or a verb', () => {
    expect(literalExamples('So "Hello World" → "hello-world" and \'A B\' becomes \'a-b\'.', t)).toEqual([
      { input: 'Hello World', expected: 'hello-world' },
      { input: 'A B', expected: 'a-b' },
    ]);
  });

  it('reads calls: slugify("X") returns "x" and `slugify("X Y")` → `"x-y"`', () => {
    expect(literalExamples('slugify("Top 10") returns "top-10"; `slugify("X Y")` → `"x-y"`.', t)).toEqual([
      { input: 'Top 10', expected: 'top-10' },
      { input: 'X Y', expected: 'x-y' },
    ]);
  });

  it('ignores apostrophes and quotes without an arrow', () => {
    expect(literalExamples(slugify.rawText, t)).toEqual([]);
    expect(literalExamples("It isn't a 'thing' that's fixed. Use \"npm test\".", t)).toEqual([]);
  });
});

describe('examples: model guards', () => {
  it('drops copied prompt examples, unsettled inputs, duplicates of literal examples', () => {
    const notes: string[] = [];
    const cases = cleanCases({
      cases: [
        { input: 'Hello World', expected: 'hello-world' },
        { input: 'ada lovelace', expected: 'AL' },
        { input: '  padded ', expected: 'padded' },
        { input: 'Crème brûlée', expected: 'crme-brle' },
        { input: 'A B', expected: 'a-b' },
        { input: 'Empty out', expected: '' },
        { input: 'Hello World', expected: 'hello-world' },
        { input: 'Top 10 tips', expected: '"top-10-tips"' },
      ],
    }, [{ input: 'A B', expected: 'a-b' }], slugify.rawText, notes);
    expect(cases).toEqual([{ input: 'Hello World', expected: 'hello-world' }, { input: 'Top 10 tips', expected: 'top-10-tips' }]);
    expect(notes.join('\n')).toMatch(/prompt example/);
    expect(notes.join('\n')).toMatch(/extra spaces/);
  });

  it('drops a case whose expected output disagrees with its own last step (examples-v2)', () => {
    const notes: string[] = [];
    const cases = cleanCases({
      cases: [
        { rule: 'replaces spaces with dashes', input: 'Hello World 123', steps: ['lowercases text: hello world 123', 'replaces spaces with dashes: hello-world-123'], expected: 'hello-world123' },
        { rule: 'strips anything else', input: 'Hello, World!', steps: ['lowercases text: hello, world!', 'replaces spaces with dashes: hello,-world!', 'strips anything else: hello-world'], expected: 'hello-world' },
      ],
    }, [], slugify.rawText, notes);
    expect(cases).toEqual([{ input: 'Hello, World!', expected: 'hello-world' }]);
    expect(notes[0]).toContain('its last step says "hello-world-123"');
  });

  it('builds a valid condition with literal examples first', async () => {
    const { engine, calls } = fakeEngine({
      inputs: { r1: { acts_on: 'punctuation', input: 'Hello, World!' }, r2: { acts_on: 'x', input: 'Hello, World!' }, r3: { acts_on: 'x', input: 'Hello World' } },
      outputs: { i1: step('hello, world!', 'hello,-world!', 'hello-world'), i2: step('hello world', 'hello-world', 'hello-world') },
    });
    const d = await proposeExamples(req(`${slugify.rawText} For example "Hello World" → "hello-world".`), engine, AbortSignal.timeout(1000), () => {});
    expect(calls).toEqual(['inputs', 'outputs']);
    expect(d?.cases).toEqual([{ input: 'Hello World', expected: 'hello-world' }, { input: 'Hello, World!', expected: 'hello-world' }]);
    expect(ExamplesConditionSchema.parse({ ...d, id: 'c3' }).description).toBe('slugify returns the agreed output for 2 example inputs.');
  });

  it('lists the output rules of the sentence that names the function', () => {
    expect(outputRules(slugify.rawText, { type: 'js_function', export: 'slugify' })).toEqual([
      'lowercases text', 'replaces spaces with dashes', "strips anything that isn't a letter, number or dash",
    ]);
    expect(outputRules('Write a JS function `initials` that keeps the first letter of each word and makes it upper case.', { type: 'js_function', export: 'initials' }))
      .toEqual(['keeps the first letter of each word', 'makes it upper case']);
  });

  it('keeps only the literal examples when the model call fails', async () => {
    const { engine } = fakeEngine({ inputs: new Error('boom') });
    const d = await proposeExamples(req(`${slugify.rawText} "A B" → "a-b".`), engine, AbortSignal.timeout(1000), () => {});
    expect(d?.cases).toEqual([{ input: 'A B', expected: 'a-b' }]);
  });
});

describe('examples in /parse', () => {
  it('default: only the examples written in the agreement, no extra model call', async () => {
    const { engine, calls } = fakeEngine({ parse: SLUGIFY_PARSE, inputs: SLUGIFY_INPUTS, outputs: SLUGIFY_OUTPUTS });
    const r = await parseAgreement(req(`${slugify.rawText} For example, "Hello, World!" becomes "hello-world".`), { engine, budgetMs: 2000, log: () => {}, examples: true });
    expect(calls).toEqual(['parse']);
    expect(r.conditions[2]).toMatchObject({ kind: 'examples', cases: [{ input: 'Hello, World!', expected: 'hello-world' }] });
    const none = await parseAgreement(slugify, { engine, budgetMs: 2000, log: () => {}, examples: true });
    expect(none.conditions.map((c) => c.kind)).toEqual(['tests_pass', 'file_present']);
  });

  it('AI_EXAMPLES=model: the model proposes cases too (both calls run)', async () => {
    const { engine, calls } = fakeEngine({ parse: SLUGIFY_PARSE, inputs: SLUGIFY_INPUTS, outputs: SLUGIFY_OUTPUTS });
    const r = await parseAgreement(slugify, { engine, budgetMs: 2000, log: () => {}, examples: true, exampleModel: true });
    expect(r.source).toBe('ai');
    expect(calls.sort()).toEqual(['inputs', 'outputs', 'parse']);
    expect(r.conditions.map((c) => c.kind)).toEqual(['tests_pass', 'file_present', 'examples']);
    expect(r.conditions[2]).toMatchObject({ id: 'c3', target: { type: 'js_function', export: 'slugify' } });
    expect(r.summary).toContain('slugify gives the agreed output for every example');
  });

  it('never calls the examples model when the feature is off', async () => {
    const { engine, calls } = fakeEngine({ parse: SLUGIFY_PARSE });
    const r = await parseAgreement(slugify, { engine, budgetMs: 2000, log: () => {} });
    expect(calls).toEqual(['parse']);
    expect(r.conditions.map((c) => c.kind)).toEqual(['tests_pass', 'file_present']);
  });

  it('a client-review item about the same function becomes an automatic check', () => {
    const text = 'Write a JavaScript function `celsius` that converts Celsius to Fahrenheit. For example "100" → "212" and "0" → "32".';
    const off = fallbackParse(req(text));
    expect(off.conditions.map((c) => c.kind)).toEqual(['client_review']);
    const on = fallbackParse(req(text), { examples: true });
    expect(on.conditions).toEqual([expect.objectContaining({ kind: 'examples', cases: [{ input: '100', expected: '212' }, { input: '0', expected: '32' }] })]);
  });

  it('coveredByExamples matches the whole function name only', () => {
    const d = examplesDraft({ type: 'js_function', export: 'slug' }, [{ input: 'a', expected: 'a' }]);
    expect(coveredByExamples('slug must handle dashes', d)).toBe(true);
    expect(coveredByExamples('slugify must be fast', d)).toBe(false);
  });
});
