import { describe, expect, it } from 'vitest';
import type { LogEvent } from '@escrow/shared';
import { fixtureEscrow, fixtureEvents } from '../fixtures/snapshot';
import { emptyStream, pickEscrow, streamReducer } from './escrowStore';

const snap = streamReducer(emptyStream, { kind: 'snapshot', escrow: fixtureEscrow, events: fixtureEvents });
const id = fixtureEscrow.id;

const newEvent: LogEvent = {
  id: `${id}:0099`,
  escrowId: id,
  at: '2026-10-17T10:20:00.000Z',
  actor: 'agent',
  type: 'decision.made',
  title: 'Decision: release',
  explain: true,
};

describe('streamReducer', () => {
  it('snapshot replaces the escrow and its log', () => {
    const next = streamReducer(snap, { kind: 'snapshot', escrow: fixtureEscrow, events: [] });
    expect(next[id].events).toEqual([]);
  });

  it('escrow update keeps the log', () => {
    const next = streamReducer(snap, { kind: 'escrow', escrow: { ...fixtureEscrow, state: 'RELEASED' } });
    expect(next[id].escrow.state).toBe('RELEASED');
    expect(next[id].events).toHaveLength(fixtureEvents.length);
  });

  it('appends new events and replaces ones it already has', () => {
    const once = streamReducer(snap, { kind: 'event', event: newEvent });
    const twice = streamReducer(once, { kind: 'event', event: { ...newEvent, title: 'changed' } });
    expect(twice[id].events).toHaveLength(fixtureEvents.length + 1);
    expect(twice[id].events.at(-1)?.title).toBe('changed');
  });

  it('streams explanation deltas, then the final text replaces them', () => {
    let s = streamReducer(snap, { kind: 'event', event: newEvent });
    s = streamReducer(s, { kind: 'explanation_delta', eventId: newEvent.id, text: 'All checks ' });
    s = streamReducer(s, { kind: 'explanation_delta', eventId: newEvent.id, text: 'passed.' });
    expect(s[id].events.at(-1)?.explanation).toBe('All checks passed.');
    expect(s[id].events.at(-1)?.explanationSource).toBeUndefined();
    s = streamReducer(s, { kind: 'explanation_done', eventId: newEvent.id, text: 'Done.', source: 'template' });
    expect(s[id].events.at(-1)).toMatchObject({ explanation: 'Done.', explanationSource: 'template' });
  });

  it('ignores explanations for unknown events', () => {
    expect(streamReducer(snap, { kind: 'explanation_delta', eventId: 'nope', text: 'x' })).toBe(snap);
  });
});

describe('pickEscrow', () => {
  it('returns the most recently updated escrow when none is requested', () => {
    const other = { ...fixtureEscrow, id: 'esc_0000', updatedAt: '2000-01-01T00:00:00.000Z' };
    const s = streamReducer(snap, { kind: 'escrow', escrow: other });
    expect(pickEscrow(s)?.escrow.id).toBe(id);
    expect(pickEscrow(s, 'esc_0000')?.escrow.id).toBe('esc_0000');
  });
});
