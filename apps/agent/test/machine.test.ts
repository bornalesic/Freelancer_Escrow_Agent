import { describe, expect, it } from 'vitest';
import { EscrowStateSchema, type Escrow, type EscrowState, type LogEvent } from '@escrow/shared';
import { Hub } from '../src/hub';
import { Machine, TRANSITIONS, canTransition } from '../src/machine';
import { Store } from '../src/store';
import { HttpError } from '../src/util';
import { tmpDir } from './helpers';

// Every arrow in docs/ESCROW_FLOW.md (PROPOSED → DRAFT is a re-parse). Nothing else is allowed.
const EXPECTED: [EscrowState, EscrowState][] = [
  ['DRAFT', 'PROPOSED'], ['DRAFT', 'CANCELLED'],
  ['PROPOSED', 'DRAFT'], ['PROPOSED', 'OPEN'], ['PROPOSED', 'AGREED'], ['PROPOSED', 'CANCELLED'],
  ['OPEN', 'DRAFT'], ['OPEN', 'AGREED'], ['OPEN', 'CANCELLED'],
  ['AGREED', 'AWAITING_FUNDS'], ['AGREED', 'CANCELLED'],
  ['AWAITING_FUNDS', 'FUNDED'], ['AWAITING_FUNDS', 'OPEN'], ['AWAITING_FUNDS', 'CANCELLED'],
  ['FUNDED', 'DELIVERED'], ['FUNDED', 'REFUNDING'],
  ['DELIVERED', 'VERIFYING'],
  ['VERIFYING', 'FUNDED'], ['VERIFYING', 'AWAITING_APPROVAL'], ['VERIFYING', 'RELEASING'], ['VERIFYING', 'REFUNDING'],
  ['AWAITING_APPROVAL', 'FUNDED'], ['AWAITING_APPROVAL', 'RELEASING'], ['AWAITING_APPROVAL', 'REFUNDING'],
  ['RELEASING', 'RELEASED'],
  ['REFUNDING', 'REFUNDED'],
];
const STATES = EscrowStateSchema.options;
const allowed = new Set(EXPECTED.map(([a, b]) => `${a}>${b}`));
const ALL_PAIRS = STATES.flatMap((from) => STATES.map((to) => [from, to] as [EscrowState, EscrowState]));

describe('transition table', () => {
  it('covers every state', () => {
    expect(Object.keys(TRANSITIONS).sort()).toEqual([...STATES].sort());
  });

  it.each(ALL_PAIRS)('%s → %s', (from, to) => {
    expect(canTransition(from, to)).toBe(allowed.has(`${from}>${to}`));
  });

  it('money only leaves through RELEASING or REFUNDING, and never after the terms are open again', () => {
    const intoPayout = EXPECTED.filter(([, to]) => to === 'RELEASING' || to === 'REFUNDING').map(([from]) => from);
    expect([...new Set(intoPayout)].sort()).toEqual(['AWAITING_APPROVAL', 'FUNDED', 'VERIFYING']);
    // No way back to editable terms once money is involved.
    for (const s of ['AWAITING_FUNDS', 'FUNDED', 'VERIFYING', 'AWAITING_APPROVAL'] as EscrowState[]) {
      expect(canTransition(s, 'DRAFT') || canTransition(s, 'PROPOSED')).toBe(false);
    }
    // Back on the marketplace only while no money is held; never once funded.
    expect(EXPECTED.filter(([, to]) => to === 'OPEN').map(([from]) => from).sort()).toEqual(['AWAITING_FUNDS', 'PROPOSED']);
    for (const s of ['FUNDED', 'DELIVERED', 'VERIFYING', 'AWAITING_APPROVAL', 'RELEASING', 'REFUNDING'] as EscrowState[]) {
      expect(canTransition(s, 'OPEN')).toBe(false);
    }
  });

  it('terminal states are final', () => {
    for (const s of ['RELEASED', 'REFUNDED', 'CANCELLED'] as EscrowState[]) expect(TRANSITIONS[s]).toEqual([]);
  });
});

describe('Machine', () => {
  const setup = () => {
    const store = new Store(tmpDir());
    store.load();
    const seen: LogEvent[] = [];
    const machine = new Machine(store, new Hub(store), (e) => seen.push(e));
    const now = new Date().toISOString();
    const escrow: Escrow = {
      id: 'esc_test', title: 't', rawText: 'r', amount: '1', assetId: 'a', assetTicker: 'T', precision: 0,
      deadline: now, state: 'DRAFT', conditions: [], acceptances: [], deliveries: [], createdAt: now, updatedAt: now,
    };
    machine.create(escrow, { type: 'escrow.created', actor: 'client', title: 'created' });
    return { store, machine, seen, escrow };
  };

  it('a legal transition saves the state and emits exactly one event', () => {
    const { store, machine, seen, escrow } = setup();
    const next = machine.transition(escrow, 'PROPOSED', { type: 'terms.proposed', actor: 'ai', title: 'proposed' });
    expect(next.state).toBe('PROPOSED');
    expect(store.get('esc_test')!.state).toBe('PROPOSED');
    expect(seen.map((e) => e.type)).toEqual(['escrow.created', 'terms.proposed']);
    expect(store.eventsOf('esc_test').map((e) => e.id)).toEqual(['esc_test:0001', 'esc_test:0002']);
  });

  it('an illegal transition throws 409 and changes nothing', () => {
    const { store, machine, seen, escrow } = setup();
    let err: unknown;
    try {
      machine.transition(escrow, 'RELEASING', { type: 'decision.made', actor: 'agent', title: 'x' });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(HttpError);
    expect((err as HttpError).statusCode).toBe(409);
    expect(store.get('esc_test')!.state).toBe('DRAFT');
    expect(seen).toHaveLength(1);
  });

  it('update() changes fields without an event; undefined removes a field', () => {
    const { store, machine, seen, escrow } = setup();
    const a = machine.update(escrow, { summary: 'hello' });
    expect(store.get('esc_test')!.summary).toBe('hello');
    machine.update(a, { summary: undefined });
    expect('summary' in store.get('esc_test')!).toBe(false);
    expect(seen).toHaveLength(1);
  });
});
