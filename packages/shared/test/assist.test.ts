import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { afterAll, describe, expect, it } from 'vitest';
import {
  AGENT_ROUTES,
  AI_ROUTES,
  ASSIST_NAMES,
  ASSIST_SCHEMAS,
  ExamplesConditionSchema,
  PROXIED_ASSISTS,
  applyRewrite,
  exampleTestName,
  examplesTestCommand,
  renderExamplesTest,
  verifiability,
  withInterviewAnswers,
  type ExamplesCondition,
} from '../src/index.ts';

const FIXTURES = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../../fixtures/demo-deliverable');
const tmp = mkdtempSync(path.join(tmpdir(), 'escrow-examples-'));
afterAll(() => rmSync(tmp, { recursive: true, force: true }));

const slugifyExamples: ExamplesCondition = {
  id: 'c3',
  kind: 'examples',
  description: 'slugify returns the agreed output for 3 example inputs.',
  target: { type: 'js_function', export: 'slugify' },
  cases: [
    { input: 'Hello World', expected: 'hello-world' },
    { input: 'Hello, World!', expected: 'hello-world' },
    { input: 'Top 10 tips', expected: 'top-10-tips' },
  ],
  timeoutSec: 30,
};

/** Renders the test file outside `cwd` (like the verifier does) and runs it there. */
function run(c: ExamplesCondition, cwd: string) {
  const file = path.join(tmp, `${c.id}-${Math.random().toString(36).slice(2)}.test.mjs`);
  writeFileSync(file, renderExamplesTest(c));
  const r = spawnSync(examplesTestCommand(file), { cwd, shell: true, encoding: 'utf8', timeout: 30_000 });
  return { code: r.status, out: `${r.stdout}${r.stderr}` };
}

describe('examples condition', () => {
  it('schema accepts the documented shape and rejects a bad export name', () => {
    expect(ExamplesConditionSchema.parse(slugifyExamples)).toEqual(slugifyExamples);
    expect(ExamplesConditionSchema.safeParse({ ...slugifyExamples, target: { type: 'js_function', export: 'not a name' } }).success).toBe(false);
    expect(ExamplesConditionSchema.safeParse({ ...slugifyExamples, cases: [] }).success).toBe(false);
  });

  it('test names quote the input and the expected output', () => {
    expect(exampleTestName(slugifyExamples.target, slugifyExamples.cases[1]!)).toBe('slugify("Hello, World!") → "hello-world"');
    expect(exampleTestName({ type: 'command', command: 'python main.py' }, { input: '2 3', expected: '5' })).toBe('input "2 3" → "5"');
  });

  it('slugify-v2 passes every example (package.json main is found)', () => {
    const r = run(slugifyExamples, path.join(FIXTURES, 'slugify-v2'));
    expect(r.out).toContain('pass 3');
    expect(r.code).toBe(0);
  });

  it('slugify-v1 fails the punctuation example, with actual vs expected in the output', () => {
    const r = run(slugifyExamples, path.join(FIXTURES, 'slugify-v1'));
    expect(r.code).not.toBe(0);
    expect(r.out).toMatch(/✖ slugify\("Hello, World!"\) → "hello-world"/);
    expect(r.out).toContain("'hello-world'");
    expect(r.out).toContain('fail 1');
  });

  it('fails clearly when the function or its file is missing', () => {
    const v2 = path.join(FIXTURES, 'slugify-v2');
    const noExport = run({ ...slugifyExamples, target: { type: 'js_function', export: 'kebab' } }, v2);
    expect(noExport.code).not.toBe(0);
    expect(noExport.out).toContain('slugify.js does not export a function named kebab');
    const noFile = run({ ...slugifyExamples, target: { type: 'js_function', export: 'slugify', file: 'lib/slug.js' } }, v2);
    expect(noFile.out).toContain('Could not find the file that exports slugify (lib/slug.js)');
  });

  it('output stays short enough for the verifier tail', () => {
    const r = run(slugifyExamples, path.join(FIXTURES, 'slugify-v1'));
    expect(r.out).not.toMatch(/^\s+at /m);
    expect(r.out.trimEnd().split('\n').length).toBeLessThan(40);
  });

  it('runs a command target with stdin and compares stdout', () => {
    const dir = mkdtempSync(path.join(tmp, 'cli-'));
    writeFileSync(path.join(dir, 'sum.mjs'), "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>console.log(s.split(' ').map(Number).reduce((a,b)=>a+b,0)))");
    const c: ExamplesCondition = {
      ...slugifyExamples, target: { type: 'command', command: 'node sum.mjs' },
      cases: [{ input: '2 3', expected: '5' }, { input: '10 5', expected: '16' }],
    };
    const r = run(c, dir);
    expect(r.out).toContain('pass 1');
    expect(r.out).toContain('fail 1');
  });

  it('a file outside the delivery is refused', () => {
    const r = run({ ...slugifyExamples, target: { type: 'js_function', export: 'slugify', file: '../slugify-v2/slugify.js' } }, path.join(FIXTURES, 'slugify-v1'));
    expect(r.code).not.toBe(0);
  });
});

describe('assist helpers', () => {
  it('withInterviewAnswers appends answered topics only', () => {
    const text = withInterviewAnswers('Build a slugify function.', [
      { topic: 'Language', answer: ' JavaScript ' },
      { topic: 'Input size', answer: '' },
    ]);
    expect(text).toBe('Build a slugify function.\n\nDetails:\n- Language: JavaScript');
    expect(withInterviewAnswers('x', [])).toBe('x');
  });

  it('applyRewrite replaces the quote, or appends when it is gone', () => {
    expect(applyRewrite('Write a CLI. Make the docs nice. Pay 5.', 'make the docs nice', 'Include a README.md file.'))
      .toBe('Write a CLI. Include a README.md file. Pay 5.');
    expect(applyRewrite('Write a CLI.', 'nope', 'Include a README.md file.')).toBe('Write a CLI.\nInclude a README.md file.');
  });

  it('verifiability counts everything but client_review as automatic', () => {
    expect(verifiability([{ kind: 'tests_pass' }, { kind: 'examples' }, { kind: 'client_review' }])).toEqual({ automatic: 2, total: 3 });
  });

  it('every assist has schemas and an AI route; hint is not proxied', () => {
    for (const name of ASSIST_NAMES) {
      expect(ASSIST_SCHEMAS[name].request).toBeDefined();
      expect(AI_ROUTES.assist(name)).toBe(`/assist/${name}`);
    }
    expect(PROXIED_ASSISTS).not.toContain('hint');
    expect(AGENT_ROUTES.assist(':name')).toBe('/assist/:name');
    expect(AGENT_ROUTES.dryRun(':id')).toBe('/escrows/:id/dry-run');
  });
});
