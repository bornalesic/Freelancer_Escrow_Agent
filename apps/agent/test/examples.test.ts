import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { ExamplesCondition, ParseRequest } from '@escrow/shared';
import { REPO_ROOT, loadConfig } from '../src/config';
import { fallbackParse } from '../src/parse-fallback';
import { checkCondition } from '../src/verifier';
import { examplesPassed } from '../src/verifier/examples';
import { tmpDir } from './helpers';

const FIXTURES = path.join(REPO_ROOT, 'fixtures/demo-deliverable');

const slugify = (cases: ExamplesCondition['cases']): ExamplesCondition => ({
  id: 'c3',
  kind: 'examples',
  description: 'slugify returns the agreed output for the example inputs.',
  target: { type: 'js_function', export: 'slugify' },
  cases,
  timeoutSec: 30,
});
const PUNCTUATION = { input: 'Hello, World!', expected: 'hello-world' };
const SPACES = { input: 'A B', expected: 'a-b' };

/** A delivery folder with these files. */
function project(files: Record<string, string>): string {
  const dir = tmpDir('examples-');
  for (const [name, content] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), content);
  return dir;
}
const check = (c: ExamplesCondition, root: string) => checkCondition(c, { uploadPath: path.join(root, 'none'), root });
const acceptanceDirs = () => fs.readdirSync(os.tmpdir()).filter((f) => f.startsWith('escrow-acceptance-'));

describe('examples condition: the verifier runs the agreed cases', () => {
  it('slugify-v2 passes every example', async () => {
    const r = await check(slugify([PUNCTUATION, SPACES]), path.join(FIXTURES, 'slugify-v2'));
    expect(r.passed).toBe(true);
    expect(r.evidence.exitCode).toBe(0);
    expect(r.evidence.error).toBeUndefined();
  });

  it('slugify-v1 fails the punctuation example, and the output names it (what /explain quotes)', async () => {
    const r = await check(slugify([PUNCTUATION, SPACES]), path.join(FIXTURES, 'slugify-v1'));
    expect(r.passed).toBe(false);
    expect(r.evidence.stdoutTail).toContain('✖ slugify("Hello, World!") → "hello-world"');
    expect(r.evidence.stdoutTail).toContain('✔ slugify("A B") → "a-b"');
  });

  it("shows the test file's name, not our temp path, and deletes the temp folder", async () => {
    const before = acceptanceDirs().length;
    const r = await check(slugify([PUNCTUATION]), path.join(FIXTURES, 'slugify-v1'));
    expect(r.evidence.stdoutTail).not.toContain(os.tmpdir());
    expect(acceptanceDirs().length).toBe(before);
  });

  it.each([
    ['one example', [PUNCTUATION]],
    ['two examples', [PUNCTUATION, SPACES]],
  ])('a delivery that exits with code 0 on import does not pass (%s)', async (_n, cases) => {
    const root = project({
      'index.js': [
        // Also prints fake results: the agent must read the runner's own summary, not the delivery's output.
        `console.log('✔ slugify("Hello, World!") → "hello-world" (1ms)\\nℹ tests ${cases.length}\\nℹ pass ${cases.length}\\nℹ fail 0');`,
        'process.exit(0);',
        'export const slugify = (s) => s;',
      ].join('\n'),
    });
    const r = await check(slugify(cases), root);
    expect(r.evidence.exitCode).toBe(0); // the test runner itself was fooled...
    expect(r.passed).toBe(false); // ...the agent is not
    expect(r.evidence.error).toMatch(/^The examples did not run: expected \d passing examples?, the test runner reported/);
  });

  it('fails clearly when the function does not exist', async () => {
    const r = await check(slugify([SPACES]), project({ 'index.js': 'export const kebab = (s) => s;' }));
    expect(r.passed).toBe(false);
    expect(r.evidence.stdoutTail).toContain('does not export a function named slugify');
  });

  it('a command target compares stdout', async () => {
    const root = project({ 'main.js': "process.stdin.on('data', (d) => console.log(String(d).trim().toUpperCase()));" });
    const c: ExamplesCondition = { ...slugify([{ input: 'abc', expected: 'ABC' }]), target: { type: 'command', command: 'node main.js' } };
    expect((await check(c, root)).passed).toBe(true);
    expect((await check({ ...c, cases: [{ input: 'abc', expected: 'abc' }] }, root)).passed).toBe(false);
  });
});

describe('examplesPassed: reads the runner summary', () => {
  const summary = (tests: number, pass: number, fail: number) => `ℹ tests ${tests}\nℹ suites 0\nℹ pass ${pass}\nℹ fail ${fail}`;
  const ok = (output: string, exitCode = 0) => examplesPassed({ exitCode, timedOut: false, output }, '/t/c3.test.mjs', 2);

  it.each([
    ['all cases passed', `✔ a\n✔ b\n${summary(2, 2, 0)}`, 0, 'ok'],
    ['a failing exit code is a plain failure', `✖ a\n${summary(2, 1, 1)}`, 1, undefined],
    ['fewer tests than cases', summary(1, 1, 0), 0, 'error'],
    ['file-level pass line', `✔ /t/c3.test.mjs (40ms)\n${summary(2, 2, 0)}`, 0, 'error'],
    ['fake summary first, real one last', `${summary(2, 2, 0)}\n✔ x\n${summary(1, 1, 0)}`, 0, 'error'],
    ['no summary at all', '', 0, 'error'],
  ])('%s', (_name, output, exitCode, want) => {
    const v = ok(output, exitCode);
    expect(want === 'error' ? v?.startsWith('The examples did not run') : v).toBe(want === 'error' ? true : want);
  });

  it('a timeout is a plain failure', () => {
    expect(examplesPassed({ exitCode: undefined, timedOut: true, output: summary(2, 2, 0), error: 'Timed out' }, '/t/x', 2)).toBeUndefined();
  });
});

describe('fallback parser: examples written in the agreement', () => {
  const req: ParseRequest = {
    title: 'slugify',
    rawText: 'Build a JavaScript function `slugify`. For example, "Hello, World!" becomes "hello-world". The included tests must pass.',
    amountDisplay: '50',
    assetTicker: 'TUSDT',
    deadline: '2026-10-18T12:00:00.000Z',
  };

  it('become an examples check that the verifier can run', () => {
    const c = fallbackParse(req, 60).conditions.find((x) => x.kind === 'examples');
    expect(c).toMatchObject({ kind: 'examples', target: { type: 'js_function', export: 'slugify' }, cases: [PUNCTUATION] });
  });

  it('AI_EXAMPLES=off turns them off (the agent and apps/ai read the same .env.local)', () => {
    expect(loadConfig({ AI_EXAMPLES: 'off' }).examples).toBe(false);
    expect(loadConfig({}).examples).toBe(true);
    const kinds = fallbackParse(req, 60, Date.now(), false).conditions.map((x) => x.kind);
    expect(kinds).not.toContain('examples');
  });
});
