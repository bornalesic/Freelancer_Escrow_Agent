import { describe, expect, it } from 'vitest';
import type { Escrow, LogEvent } from '@escrow/shared';
import { emptyStream, streamReducer } from './stream';

const escrow = (id: string, createdAt = '2026-10-18T09:00:00.000Z'): Escrow => ({
  id, title: id, rawText: 'x', amount: '1', assetId: 'rgb:a', assetTicker: 'TUSDT', precision: 6,
  deadline: '2026-10-19T09:00:00.000Z', state: 'OPEN', conditions: [], acceptances: [], deliveries: [],
  createdAt, updatedAt: createdAt,
});
const event = (escrowId: string, n: number): LogEvent => ({
  id: `${escrowId}:${n}`, escrowId, at: '2026-10-18T09:00:00.000Z', actor: 'agent', type: 'escrow.created', title: 't', explain: true,
});

describe('stream', () => {
  it('drops jobs the agent no longer has (its store was reset), keeping logs of the rest', () => {
    let s = streamReducer(emptyStream, { kind: 'snapshot', escrow: escrow('old'), events: [event('old', 1)] });
    s = streamReducer(s, { kind: 'snapshot', escrow: escrow('kept'), events: [event('kept', 1)] });
    s = streamReducer(s, { kind: 'list', escrows: [escrow('kept')], requestedAt: Date.parse('2026-10-18T10:00:00.000Z') });
    expect(Object.keys(s)).toEqual(['kept']);
    expect(s['kept']!.events).toHaveLength(1);
  });

  it('keeps a job created while the list was on its way', () => {
    let s = streamReducer(emptyStream, { kind: 'escrow', escrow: escrow('new', '2026-10-18T10:00:01.000Z') });
    s = streamReducer(s, { kind: 'list', escrows: [], requestedAt: Date.parse('2026-10-18T10:00:00.000Z') });
    expect(Object.keys(s)).toEqual(['new']);
  });

  it('streams AI explanations into the event', () => {
    let s = streamReducer(emptyStream, { kind: 'snapshot', escrow: escrow('a'), events: [event('a', 1)] });
    s = streamReducer(s, { kind: 'explanation_delta', eventId: 'a:1', text: 'The client ' });
    s = streamReducer(s, { kind: 'explanation_delta', eventId: 'a:1', text: 'paid.' });
    expect(s['a']!.events[0]!.explanation).toBe('The client paid.');
    s = streamReducer(s, { kind: 'explanation_done', eventId: 'a:1', text: 'The client paid 51 tUSDT.', source: 'ai' });
    expect(s['a']!.events[0]).toMatchObject({ explanation: 'The client paid 51 tUSDT.', explanationSource: 'ai' });
  });
});
