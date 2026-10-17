import type { ParseRequest } from '@escrow/shared';
import { describe, expect, it } from 'vitest';
import { MISSING_HASH_NOTE, NO_CONDITIONS_NOTE } from '../src/fallback.ts';
import { extractJson, postprocess } from '../src/postprocess.ts';
import { agreements, slugify } from './fixtures.ts';

const hashCase = agreements.find((c) => c.id === 'report-hash')!;
const realHash = '3a7bd3e2360a3d29eea436fcfb7e44c735d117c42d1c1835420b6b9942dd4f1b';
const withText = (rawText: string): ParseRequest => ({ ...slugify, rawText });

function ok(raw: Record<string, unknown>, req: ParseRequest = slugify) {
  const r = postprocess({ deliverable: 'A slugify function', unclear: [], ...raw }, req);
  if (!r.ok) throw new Error(r.error);
  return r;
}

describe('postprocess', () => {
  it('assigns ids, normalizes, and writes the payment part of the summary', () => {
    const r = ok({
      conditions: [
        { kind: 'tests_pass', description: 'Tests pass.', command: '', timeoutSec: 0 },
        { kind: 'file_present', description: 'README.', pathPattern: './README' },
      ],
    });
    expect(r.value.summary).toBe('A slugify function. The freelancer is paid 50 tUSDT once the tests pass and README is included.');
    expect(r.value.conditions).toEqual([
      { id: 'c1', kind: 'tests_pass', description: 'Tests pass.', command: 'npm test', timeoutSec: 60 },
      { id: 'c2', kind: 'file_present', description: 'README.', pathPattern: 'README*' },
    ]);
  });

  it('drops an invented hash; mentions the missing value only if the agreement talks about a hash', () => {
    const r = ok({ conditions: [{ kind: 'file_hash', description: 'Hash.', sha256: 'b'.repeat(64) }] },
      withText('The zip must match the agreed SHA-256 hash. Pay 5 USDT.'));
    expect(r.value.conditions).toEqual([]);
    expect(r.value.clarifications).toEqual([MISSING_HASH_NOTE, NO_CONDITIONS_NOTE]);

    const silent = ok({ conditions: [{ kind: 'file_hash', description: 'Hash.', sha256: 'b'.repeat(64) }] });
    expect(silent.value.clarifications).not.toContain(MISSING_HASH_NOTE);
  });

  it('drops a made-up test command check and adds files the model missed (docker case)', () => {
    const r = ok({
      conditions: [
        { kind: 'file_present', description: 'README.', pathPattern: 'README*' },
        { kind: 'tests_pass', description: 'Valid.', command: 'docker-compose', timeoutSec: 60 },
      ],
    }, agreements.find((c) => c.id === 'docker-files')!);
    expect(r.value.conditions.map((c) => (c.kind === 'file_present' ? c.pathPattern : c.kind))).toEqual(['README*', 'Dockerfile', 'docker-compose.yml']);
  });

  it('normalizes odd README patterns', () => {
    const r = ok({ conditions: [{ kind: 'file_present', description: 'README.', pathPattern: 'README*.' }] });
    expect(r.value.conditions.find((c) => c.kind === 'file_present')).toMatchObject({ pathPattern: 'README*' });
  });

  it('adds subjective items the model missed', () => {
    const r = ok({ conditions: [] }, agreements.find((c) => c.id === 'rate-limiter')!);
    expect(r.value.clarifications).toContain('"The code should be clean and well documented" is subjective, so it cannot be checked automatically.');
  });

  it('keeps a literal hash (case-insensitive) and adds hashes the model missed', () => {
    const r = ok({ conditions: [{ kind: 'file_hash', description: 'Hash.', fileName: 'report.pdf', sha256: realHash.toUpperCase() }] }, hashCase);
    expect(r.value.conditions).toHaveLength(1);
    expect(r.value.conditions[0]).toMatchObject({ kind: 'file_hash', sha256: realHash, fileName: 'report.pdf' });

    const missed = ok({ conditions: [] }, hashCase);
    expect(missed.value.conditions[0]).toMatchObject({ kind: 'file_hash', sha256: realHash });
  });

  it('drops files and commands the agreement never names', () => {
    const r = ok({
      conditions: [
        { kind: 'file_present', description: 'Code.', pathPattern: 'src/slugify.js' },
        { kind: 'tests_pass', description: 'Jest.', command: 'npx jest', timeoutSec: 60 },
      ],
    });
    expect(r.value.conditions).toEqual([
      { id: 'c1', kind: 'tests_pass', description: 'Jest.', command: 'npm test', timeoutSec: 60 },
      { id: 'c2', kind: 'file_present', description: 'A file named README must be included.', pathPattern: 'README*' },
    ]);
  });

  it('drops a test check when tests are never mentioned', () => {
    const r = ok({ conditions: [{ kind: 'tests_pass', description: 'Tests.', command: 'npm test', timeoutSec: 60 }] },
      withText('Design a nice logo. Pay 30 USDT.'));
    expect(r.value.conditions).toEqual([]);
  });

  it('keeps only unclear quotes that are literally in the agreement and not already checked', () => {
    const r = ok({
      conditions: [{ kind: 'tests_pass', description: 'Tests.', command: 'npm test', timeoutSec: 60 }],
      unclear: [
        { quote: 'the UI should feel smooth.', reason: 'subjective' },
        { quote: 'Make the code clean and professional', reason: 'subjective' }, // invented
        { quote: 'All unit tests (npm test) must pass', reason: 'subjective' },   // already a check
        { quote: '100 USDT', reason: 'not_checkable' },                           // payment
      ],
    }, agreements.find((c) => c.id === 'bugfix-mixed')!);
    expect(r.value.clarifications).toEqual(['"The UI should feel smooth" is subjective, so it cannot be checked automatically.']);
    expect(r.notes).toHaveLength(3);
  });

  it('dedupes identical conditions', () => {
    const c = { kind: 'tests_pass', description: 'Tests.', command: 'npm test', timeoutSec: 60 };
    expect(ok({ conditions: [c, c] }).value.conditions.filter((x) => x.kind === 'tests_pass')).toHaveLength(1);
  });

  it('rejects malformed output with a useful error', () => {
    expect(postprocess({ conditions: [] }, slugify)).toMatchObject({ ok: false });
    expect(postprocess({ deliverable: 'x', conditions: [{ kind: 'vibes' }] }, slugify)).toMatchObject({ ok: false });
    expect(postprocess({ deliverable: 'x', conditions: 'none' }, slugify)).toMatchObject({ ok: false });
  });

  it('extracts JSON from fenced or chatty output', () => {
    expect(extractJson('Sure!\n```json\n{"a":1}\n```')).toEqual({ a: 1 });
    expect(extractJson('{"a":"}{","b":{"c":2}}\n}\n{"again":true}')).toEqual({ a: '}{', b: { c: 2 } });
    expect(() => extractJson('{"a":1')).toThrow(/cut off/);
    expect(() => extractJson('no json here')).toThrow();
  });
});
