import {
  eventId,
  type Actor,
  type Escrow,
  type EscrowState,
  type LogEvent,
  type LogEventType,
} from '@escrow/shared';
import type { Hub } from './hub';
import type { Store } from './store';
import { conflict, nowIso } from './util';

/** Allowed transitions, as in docs/ESCROW_FLOW.md. PROPOSED → DRAFT is a re-parse. */
export const TRANSITIONS: Record<EscrowState, readonly EscrowState[]> = {
  DRAFT: ['PROPOSED', 'CANCELLED'],
  PROPOSED: ['DRAFT', 'OPEN', 'AGREED', 'CANCELLED'], // OPEN = published listing; AGREED = both-parties flow
  OPEN: ['DRAFT', 'AGREED', 'CANCELLED'],             // edited, taken, cancelled or expired
  AGREED: ['AWAITING_FUNDS', 'CANCELLED'],
  AWAITING_FUNDS: ['FUNDED', 'OPEN', 'CANCELLED'],    // OPEN: not funded in time / payment failed
  FUNDED: ['DELIVERED', 'REFUNDING'],
  DELIVERED: ['VERIFYING'],
  VERIFYING: ['FUNDED', 'AWAITING_APPROVAL', 'RELEASING', 'REFUNDING'],
  AWAITING_APPROVAL: ['FUNDED', 'RELEASING', 'REFUNDING'],
  RELEASING: ['RELEASED'],
  REFUNDING: ['REFUNDED'],
  RELEASED: [],
  REFUNDED: [],
  CANCELLED: [],
};

export function canTransition(from: EscrowState, to: EscrowState): boolean {
  return TRANSITIONS[from].includes(to);
}

export interface EventSpec {
  type: LogEventType;
  actor: Actor;
  /** Short, deterministic, written by code. Never by the LLM. */
  title: string;
  data?: Record<string, unknown>;
  explain?: boolean;
}

export type EscrowPatch = Partial<Omit<Escrow, 'id' | 'state' | 'createdAt' | 'updatedAt'>>;

/**
 * The only writer of escrows and log events. Every state change goes through `transition()`, which
 * validates it and emits exactly one LogEvent. Callers hold the escrow's mutex.
 */
export class Machine {
  constructor(
    private store: Store,
    private hub: Hub,
    private onEvent: (event: LogEvent, escrow: Escrow) => void,
  ) {}

  create(escrow: Escrow, spec: EventSpec): Escrow {
    this.store.putEscrow(escrow);
    this.hub.broadcast(escrow.id, { kind: 'escrow', escrow });
    this.record(escrow, spec);
    return escrow;
  }

  transition(escrow: Escrow, to: EscrowState, spec: EventSpec, patch: EscrowPatch = {}): Escrow {
    if (!canTransition(escrow.state, to)) {
      throw conflict(`Cannot go from ${escrow.state} to ${to}`, { from: escrow.state, to });
    }
    const next = this.save(escrow, { ...patch, state: to });
    this.store.patchInternal(escrow.id, { lastError: undefined });
    this.record(next, spec);
    return next;
  }

  /** Change fields without a state change (no event). */
  update(escrow: Escrow, patch: EscrowPatch): Escrow {
    return this.save(escrow, patch);
  }

  /** Append a log event that is not a state change (e.g. terms.accepted, verify.condition_result). */
  record(escrow: Escrow, spec: EventSpec): LogEvent {
    const event: LogEvent = {
      id: eventId(escrow.id, this.store.nextSeq(escrow.id)),
      escrowId: escrow.id,
      at: nowIso(),
      actor: spec.actor,
      type: spec.type,
      title: spec.title,
      ...(spec.data ? { data: spec.data } : {}),
      explain: spec.explain ?? false,
    };
    this.store.addEvent(event);
    this.hub.broadcast(escrow.id, { kind: 'event', event });
    this.onEvent(event, escrow);
    return event;
  }

  private save(escrow: Escrow, patch: EscrowPatch & { state?: EscrowState }): Escrow {
    const next: Escrow = { ...escrow, ...patch, updatedAt: nowIso() };
    // Patching a field to undefined removes it, so it does not linger in JSON.
    for (const k of Object.keys(next) as (keyof Escrow)[]) if (next[k] === undefined) delete next[k];
    this.store.putEscrow(next);
    this.hub.broadcast(next.id, { kind: 'escrow', escrow: next });
    return next;
  }
}
