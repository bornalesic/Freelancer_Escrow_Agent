import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { ConditionSchema, type ParseRequest } from '@escrow/shared';
import { checkCase, toParseRequest, type AgreementFile } from '@escrow/ai/src/evalCheck.ts';
import { REPO_ROOT } from '../src/config';
import { fallbackParse } from '../src/parse-fallback';

// The agent's fallback is what proposes the terms when the AI laptop is unreachable, so it is scored
// against the same fixtures (and with the same checker) as apps/ai's eval.
const FILE: AgreementFile = JSON.parse(fs.readFileSync(path.join(REPO_ROOT, 'fixtures/agreements.json'), 'utf8'));
const byId = (id: string) => FILE.cases.find((c) => c.id === id)!;
const req = (rawText: string, title = 'Job'): ParseRequest => ({
  title, rawText, amountDisplay: '30', assetTicker: 'TUSDT', deadline: '2026-10-18T12:00:00.000Z',
});

describe('agent fallback parser: fixtures/agreements.json', () => {
  it.each(FILE.cases.map((c) => [c.id, c] as const))('%s', (_id, c) => {
    const r = fallbackParse(toParseRequest(c), 60);
    expect(checkCase(c, r)).toEqual([]);
    expect(r.source).toBe('fallback');
    r.conditions.forEach((cond, i) => {
      expect(ConditionSchema.parse(cond)).toEqual(cond);
      expect(cond.id).toBe(`c${i + 1}`);
    });
  });
});

describe('agent fallback parser: WS4 reports', () => {
  it('landing agreement → index.html is checked, not only the README', () => {
    const r = fallbackParse(toParseRequest(byId('landing-demo')), 60);
    expect(r.conditions.map((c) => [c.kind, 'pathPattern' in c ? c.pathPattern : c.description])).toEqual([
      ['file_present', 'index.html'],
      ['file_present', 'README*'],
      ['client_review', 'The page should look clean and use warm colours.'],
    ]);
  });

  it('the summary is plain English, without the raw ISO deadline', () => {
    const r = fallbackParse(req('Build a landing page as index.html. Also include a README.', 'Bakery'), 60);
    expect(r.summary).toBe('Job "Bakery". The freelancer is paid 30 TUSDT once index.html is included and README is included.');
    expect(r.summary).not.toMatch(/\d{4}-\d{2}-\d{2}T/);
  });
});

describe('agent fallback parser: agent specifics', () => {
  it('uses VERIFY_DEFAULT_TIMEOUT_SEC when the agreement names no timeout', () => {
    const [c] = fallbackParse(req('The included tests must pass.'), 90).conditions;
    expect(c).toMatchObject({ kind: 'tests_pass', command: 'npm test', timeoutSec: 90 });
  });

  it('keeps a timeout the agreement states', () => {
    const [c] = fallbackParse(req('The tests must pass within 2 minutes.'), 90).conditions;
    expect(c).toMatchObject({ kind: 'tests_pass', timeoutSec: 120 });
  });

  it.each(['Write clean.py that removes empty rows.', 'Ship design.md and style.css.'])(
    'file names are not taste: %j',
    (text) => {
      expect(fallbackParse(req(text), 60).conditions.map((c) => c.kind)).not.toContain('client_review');
    },
  );

  it('never invents a hash: only literal 64-hex values become file_hash', () => {
    const r = fallbackParse(req('Deliver data.csv. We will check its SHA-256 hash later.'), 60);
    expect(r.conditions.some((c) => c.kind === 'file_hash')).toBe(false);
    expect(r.clarifications.length).toBeGreaterThan(0);
  });
});
