import type { ParseRequest } from '@escrow/shared';
import { describe, expect, it } from 'vitest';
import { MISSING_HASH_NOTE, NO_CONDITIONS_NOTE } from '../src/fallback.ts';
import { extractJson, postprocess } from '../src/postprocess.ts';
import { req, slugify } from './fixtures.ts';

const realHash = '9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08';
const withText = (rawText: string): ParseRequest => ({ ...slugify, rawText });

/** Runs postprocess on a parse-v3 shaped output; fills in the fields a test doesn't care about. */
function ok(raw: Record<string, unknown>, r: ParseRequest = slugify) {
  const out = postprocess({ deliverable: 'A slugify function', conditions: [], review: [], unclear: [], ...raw }, r);
  if (!out.ok) throw new Error(out.error);
  return out;
}

describe('postprocess (parse-v3)', () => {
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

  it('keeps a literal hash (case-insensitive) and adds hashes the model missed', () => {
    const hashCase = req('exact-file-hash');
    const r = ok({ conditions: [{ kind: 'file_hash', description: 'Hash.', fileName: 'contract.pdf', sha256: realHash.toUpperCase() }] }, hashCase);
    expect(r.value.conditions).toEqual([expect.objectContaining({ kind: 'file_hash', sha256: realHash, fileName: 'contract.pdf' })]);
    expect(ok({}, hashCase).value.conditions[0]).toMatchObject({ kind: 'file_hash', sha256: realHash });
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

  it('drops a made-up test command check and adds files the model missed (docker case)', () => {
    const r = ok({
      conditions: [
        { kind: 'file_present', description: 'README.', pathPattern: 'README*' },
        { kind: 'tests_pass', description: 'Valid.', command: 'docker-compose', timeoutSec: 60 },
      ],
    }, req('docker-files'));
    expect(r.value.conditions.map((c) => (c.kind === 'file_present' ? c.pathPattern : c.kind))).toEqual(['README*', 'Dockerfile', 'docker-compose.yml']);
  });

  it('drops a concrete file the agreement never names whole (2B added "tests/test.js" next to the glob)', () => {
    const r = ok({
      conditions: [
        { kind: 'file_present', description: 'A test file.', pathPattern: 'tests/test.js' },
        { kind: 'file_present', description: 'Test files.', pathPattern: 'tests/**/*.test.js' },
      ],
    }, req('glob-pattern'));
    const patterns = r.value.conditions.flatMap((c) => (c.kind === 'file_present' ? [c.pathPattern] : []));
    expect(patterns).toEqual(['tests/**/*.test.js']);
  });

  it('sharpens a fuzzy glob to the one named file and gives the hash its file (2B: "contract.*pdf", no fileName)', () => {
    const r = ok({
      conditions: [
        { kind: 'file_present', description: 'Contract.', pathPattern: 'contract.*pdf' },
        { kind: 'file_hash', description: 'Hash.', sha256: realHash },
      ],
    }, req('exact-file-hash'));
    expect(r.value.conditions).toEqual([{ id: 'c1', kind: 'file_hash', description: 'Hash.', sha256: realHash, fileName: 'contract.pdf' }]);
  });

  it('replaces a hash fileName the agreement never mentions', () => {
    const r = ok({ conditions: [{ kind: 'file_hash', description: 'Hash.', fileName: 'agreement.pdf', sha256: realHash }] }, req('exact-file-hash'));
    expect(r.value.conditions[0]).toMatchObject({ kind: 'file_hash', fileName: 'contract.pdf' });
  });

  it('keeps a glob when every literal piece of it is in the agreement', () => {
    const r = ok({ conditions: [{ kind: 'file_present', description: 'Tests.', pathPattern: 'tests/**/*.test.js' }] }, req('glob-pattern'));
    expect(r.value.conditions).toContainEqual(expect.objectContaining({ pathPattern: 'tests/**/*.test.js' }));
  });

  it('normalizes odd README patterns', () => {
    const r = ok({ conditions: [{ kind: 'file_present', description: 'README.', pathPattern: 'README*.' }] });
    expect(r.value.conditions.find((c) => c.kind === 'file_present')).toMatchObject({ pathPattern: 'README*' });
  });

  it('turns review quotes into client_review conditions; drops invented, covered and payment quotes', () => {
    const r = ok({
      conditions: [{ kind: 'tests_pass', description: 'Tests.', command: 'npm test', timeoutSec: 60 }],
      review: [
        'The code should also be clean and well organised.',
        'Make the code clean and professional', // invented
        'npm test must pass',                   // already an automatic check
        '60 USDT',                              // payment
      ],
    }, req('tests-plus-vague-part'));
    expect(r.value.conditions.filter((c) => c.kind === 'client_review')).toEqual([
      expect.objectContaining({ kind: 'client_review', description: 'The code should also be clean and well organised.' }),
    ]);
    expect(r.notes.filter((n) => n.startsWith('dropped review'))).toHaveLength(3);
  });

  it('turns unclear quotes into clarifications instead of conditions', () => {
    const r = ok({ unclear: ['We will check its SHA-256 hash against the one I send you later'] }, req('hash-sent-later'));
    expect(r.value.clarifications[0]).toMatch(/^"We will check its SHA-256 hash against the one I send you later" cannot be checked/);
    expect(r.value.clarifications).not.toContain(MISSING_HASH_NOTE); // the quote already says it
  });

  it('adds review items the model missed (web shop that used to return no conditions)', () => {
    const r = ok({ deliverable: 'A web shop for sunglasses' }, req('sunglasses-shop'));
    expect(r.value.conditions).toEqual([
      { id: 'c1', kind: 'client_review', description: 'It has to have a catalog of sunglasses, bright colors and a cart and a checkout.' },
    ]);
    expect(r.value.clarifications).toEqual([]);
    expect(r.value.summary).toBe('A web shop for sunglasses. The freelancer is paid 1500 tUSDT once the client approves what they review.');
  });

  it('keeps the longer of two overlapping review quotes', () => {
    const r = ok({ review: ['bright colors', 'It has to have a catalog of sunglasses, bright colors and a cart and a checkout'] }, req('sunglasses-shop'));
    expect(r.value.conditions.filter((c) => c.kind === 'client_review')).toHaveLength(1);
  });

  it('drops a test check when tests are never mentioned', () => {
    const r = ok({ conditions: [{ kind: 'tests_pass', description: 'Tests.', command: 'npm test', timeoutSec: 60 }] },
      withText('Design a nice logo. Pay 30 USDT.'));
    expect(r.value.conditions.some((c) => c.kind === 'tests_pass')).toBe(false);
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
