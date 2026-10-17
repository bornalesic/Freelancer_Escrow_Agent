import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import type { Condition } from '@escrow/shared';
import { REPO_ROOT } from '../src/config';
import { decide } from '../src/decide';
import { checkCondition, prepareWorkspace } from '../src/verifier';
import { tmpDir, writeZip } from './helpers';

// The real stage deliverables from fixtures/demo-deliverable, zipped the way the freelancer uploads them.
const demo = (version: 1 | 2) => {
  const dir = path.join(REPO_ROOT, 'fixtures/demo-deliverable', `slugify-v${version}`);
  const files = Object.fromEntries(fs.readdirSync(dir).map((f) => [f, fs.readFileSync(path.join(dir, f), 'utf8')]));
  const work = tmpDir();
  const zip = writeZip(work, `slugify-v${version}.zip`, files, `slugify-v${version}/`);
  return prepareWorkspace(zip, `slugify-v${version}.zip`, path.join(work, 'unpacked'));
};

// What the AI (or the fallback parser) proposes for the stage agreement.
const conditions: Condition[] = [
  { id: 'c1', kind: 'tests_pass', description: 'The included tests pass (npm test).', command: 'npm test', timeoutSec: 60 },
  { id: 'c2', kind: 'file_present', description: 'A README file is included.', pathPattern: 'README*' },
];
const DEADLINE = new Date(Date.now() + 30 * 60_000).toISOString();

describe('stage deliverables (fixtures/demo-deliverable)', () => {
  it('v1 → the punctuation test fails, README present → retry', async () => {
    const ws = demo(1);
    const results = await Promise.all(conditions.map((c) => checkCondition(c, ws)));
    expect(results.map((r) => r.passed)).toEqual([false, true]);
    expect(results[0]!.evidence.exitCode).not.toBe(0);
    expect(results[0]!.evidence.stdoutTail).toContain('strips punctuation');
    expect(results[1]!.evidence.matched).toEqual(['README.md']);
    expect(decide({ state: 'VERIFYING', deadline: DEADLINE, conditions }, results, new Date())).toMatchObject({
      action: 'retry',
      failed: ['c1'],
    });
  }, 30_000);

  it('v2 → every check passes → release', async () => {
    const ws = demo(2);
    const results = await Promise.all(conditions.map((c) => checkCondition(c, ws)));
    expect(results.map((r) => r.passed)).toEqual([true, true]);
    expect(results[0]!.evidence.exitCode).toBe(0);
    expect(decide({ state: 'VERIFYING', deadline: DEADLINE, conditions }, results, new Date()).action).toBe('release');
  }, 30_000);
});
