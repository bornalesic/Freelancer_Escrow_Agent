import { describe, expect, it } from 'vitest';
import { checkCase } from '../src/evalCheck.ts';
import { MISSING_HASH_NOTE, fallbackParse } from '../src/fallback.ts';
import { agreements, slugify } from './fixtures.ts';

describe('fallbackParse', () => {
  it('turns the demo agreement into tests_pass + README', () => {
    const r = fallbackParse(slugify);
    expect(r.source).toBe('fallback');
    expect(r.conditions).toEqual([
      { id: 'c1', kind: 'tests_pass', description: 'All the included tests must pass.', command: 'npm test', timeoutSec: 60 },
      { id: 'c2', kind: 'file_present', description: 'A file named README must be included.', pathPattern: 'README*' },
    ]);
    expect(r.clarifications).toEqual([]);
  });

  it.each(agreements.map((c) => [c.id, c] as const))('meets eval expectations: %s', (_id, c) => {
    expect(checkCase(c, fallbackParse(c))).toEqual([]);
  });

  it('never invents a hash', () => {
    const r = fallbackParse({ ...slugify, rawText: 'The zip must match the agreed SHA-256 hash. Pay 5 USDT.' });
    expect(r.conditions.filter((c) => c.kind === 'file_hash')).toEqual([]);
    expect(r.clarifications).toContain(MISSING_HASH_NOTE);
  });

  it('keeps "nice, modern" as one clarification', () => {
    const r = fallbackParse({ ...slugify, rawText: 'Design a nice, modern logo for my bakery.' });
    expect(r.clarifications[0]).toBe('"Design a nice, modern logo for my bakery" is subjective, so it cannot be checked automatically.');
  });
});
