import { describe, expect, it } from 'vitest';
import { checkCase, toParseRequest } from '../src/evalCheck.ts';
import { MISSING_HASH_NOTE, NO_CONDITIONS_NOTE, fallbackParse } from '../src/fallback.ts';
import { agreements, req, slugify } from './fixtures.ts';

const withText = (rawText: string) => ({ ...slugify, rawText });

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
    expect(checkCase(c, fallbackParse(toParseRequest(c)))).toEqual([]);
  });

  it('never invents a hash', () => {
    const r = fallbackParse(withText('The zip must match the agreed SHA-256 hash. Pay 5 USDT.'));
    expect(r.conditions.filter((c) => c.kind === 'file_hash')).toEqual([]);
    expect(r.clarifications).toContain(MISSING_HASH_NOTE);
  });

  it('turns subjective wishes into client_review conditions in the agreement\'s own words', () => {
    const r = fallbackParse(withText('Design a nice, modern logo for my bakery.'));
    expect(r.conditions).toEqual([{ id: 'c1', kind: 'client_review', description: 'Design a nice, modern logo for my bakery.' }]);
    expect(r.clarifications).toEqual([]);
  });

  it('turns required features into client_review conditions (web shops used to return nothing)', () => {
    for (const id of ['sunglasses-shop', 'dinamo-shop']) {
      const r = fallbackParse(req(id));
      expect(r.conditions.length, id).toBeGreaterThan(0);
      expect(r.conditions.every((c) => c.kind === 'client_review'), id).toBe(true);
      expect(r.clarifications, id).not.toContain(NO_CONDITIONS_NOTE);
    }
    expect(fallbackParse(req('sunglasses-shop')).conditions[0]).toMatchObject({
      description: 'It has to have a catalog of sunglasses, bright colors and a cart and a checkout.',
    });
  });

  it('falls back to the main deliverable when nothing else can be judged', () => {
    const r = fallbackParse(withText('Create a mobile app for my gym. Pay 300 USDT.'));
    expect(r.conditions).toEqual([{ id: 'c1', kind: 'client_review', description: 'Create a mobile app for my gym.' }]);
  });

  it('does not read a file name as a wish ("clean.py" is not "clean code")', () => {
    const r = fallbackParse(req('custom-test-command'));
    expect(r.conditions.map((c) => c.kind)).toEqual(['file_present', 'tests_pass']);
  });

  it('does not read English as a command ("make sure npm test passes")', () => {
    const r = fallbackParse(req('glob-pattern'));
    expect(r.conditions).toContainEqual(expect.objectContaining({ kind: 'tests_pass', command: 'npm test' }));
    expect(r.conditions).toContainEqual(expect.objectContaining({ kind: 'file_present', pathPattern: 'tests/**/*.test.js' }));
  });

  it('keeps "send later" items as clarifications, not conditions', () => {
    const r = fallbackParse(withText('Deliver logo.svg. The print size will be decided later. Pay 20 USDT.'));
    expect(r.clarifications[0]).toMatch(/cannot be checked or judged as written/);
  });
});
