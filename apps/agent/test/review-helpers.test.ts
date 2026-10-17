import { describe, expect, it } from 'vitest';
import { LOG_EVENT_TYPES, type AiReview, type Escrow, type LogEvent } from '@escrow/shared';
import { checkClientToken, hashClientToken, newClientToken } from '../src/client-token';
import { explanationTemplate, normalizeReview, templateReview } from '../src/templates';

describe('clientToken', () => {
  it('is 32 random bytes as hex, and only its sha256 is meant to be stored', () => {
    const a = newClientToken();
    const b = newClientToken();
    expect(a.token).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).toMatch(/^[0-9a-f]{64}$/);
    expect(a.hash).not.toBe(a.token);
    expect(a.token).not.toBe(b.token);
    expect(a.hash).toBe(hashClientToken(a.token));
  });

  it('accepts the right token only', () => {
    const { token, hash } = newClientToken();
    expect(checkClientToken(token, hash)).toBe(true);
    expect(checkClientToken(token.toUpperCase(), hash)).toBe(false);
    expect(checkClientToken(`${token} `, hash)).toBe(false);
    expect(checkClientToken(newClientToken().token, hash)).toBe(false);
    expect(checkClientToken('', hash)).toBe(false);
    expect(checkClientToken(hash, hash)).toBe(false); // knowing the stored hash is not enough
  });

  it('rejects everything when no hash is stored (escrows created before client review)', () => {
    expect(checkClientToken(newClientToken().token, undefined)).toBe(false);
    expect(checkClientToken('x', 'not-hex')).toBe(false);
  });
});

const conditions: Escrow['conditions'] = [
  { id: 'c1', kind: 'file_present', description: 'index.html', pathPattern: 'index.html' },
  { id: 'c2', kind: 'client_review', description: 'Warm colours' },
  { id: 'c3', kind: 'client_review', description: 'Looks clean' },
];

describe('AI review helpers', () => {
  it('templateReview: one unsure item per client_review, in term order', () => {
    expect(templateReview({ conditions }, 7)).toEqual({
      items: [
        { conditionId: 'c2', opinion: 'unsure', note: expect.any(String) },
        { conditionId: 'c3', opinion: 'unsure', note: expect.any(String) },
      ],
      source: 'template',
      ms: 7,
    });
  });

  it('normalizeReview: drops unknown and automatic ids, de-duplicates, fills gaps, keeps term order', () => {
    const ai: AiReview = {
      items: [
        { conditionId: 'c3', opinion: 'looks_met', note: 'clean' },
        { conditionId: 'c1', opinion: 'looks_met', note: 'automatic, not for the AI' },
        { conditionId: 'zz', opinion: 'looks_met', note: 'unknown' },
      ],
      source: 'ai',
      model: 'm',
      ms: 3,
    };
    expect(normalizeReview(ai, { conditions })).toEqual({
      items: [
        { conditionId: 'c2', opinion: 'unsure', note: 'The AI gave no opinion on this item.' },
        { conditionId: 'c3', opinion: 'looks_met', note: 'clean' },
      ],
      source: 'ai',
      model: 'm',
      ms: 3,
    });
  });
});

describe('explanation templates', () => {
  const escrow = {
    id: 'esc_1', title: 'Landing', rawText: 'r', amount: '30000000', assetId: 'a', assetTicker: 'tUSDT', precision: 6,
    deadline: '2026-10-18T12:00:00.000Z', state: 'FUNDED', conditions, acceptances: [], deliveries: [],
    createdAt: '2026-10-18T10:00:00.000Z', updatedAt: '2026-10-18T10:00:00.000Z',
  } satisfies Escrow;
  const ev = (type: LogEvent['type'], data?: Record<string, unknown>): LogEvent => ({
    id: 'esc_1:0001', escrowId: 'esc_1', at: escrow.createdAt, actor: 'agent', type, title: `title of ${type}`, explain: true,
    ...(data ? { data } : {}),
  });

  it.each(LOG_EVENT_TYPES.map((t) => [t]))('%s → a non-empty sentence', (type) => {
    expect(explanationTemplate(ev(type), escrow).trim().length).toBeGreaterThan(5);
  });

  it.each([
    ['release', { action: 'release', reason: 'The client approved the work.' }, 'The client approved the work. The agent pays 30 tUSDT to the freelancer.'],
    ['refund', { action: 'refund', reason: 'The client disputed the work and the deadline has passed.' }, 'The client disputed the work and the deadline has passed. The agent returns 30 tUSDT to the client.'],
    ['retry', { action: 'retry', reason: '1 of 2 checks failed.', failed: ['c1'] }, '1 of 2 checks failed. The money stays locked until a delivery is accepted or the deadline passes.'],
  ])('decision.made %s restates the reason and the money', (_name, data, text) => {
    expect(explanationTemplate(ev('decision.made', data), escrow)).toBe(text);
  });

  it('terms.proposed counts automatic checks and client-judged items separately', () => {
    expect(explanationTemplate(ev('terms.proposed'), escrow)).toMatch(/^The agreement was turned into 1 automatic checks and 2 item\(s\) the client judges\./);
  });
});
