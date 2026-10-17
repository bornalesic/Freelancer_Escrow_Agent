// Pure state for everything the agent streams over its WebSocket. The UI renders only from this.
// `snapshot` replaces one escrow and its log; the other messages patch it.
import { TERMINAL_STATES, type Escrow, type EscrowState, type LogEvent, type WsMessage } from '@escrow/shared';

export interface EscrowView {
  escrow: Escrow;
  events: LogEvent[];
}

/** Keyed by escrow id. */
export type StreamState = Record<string, EscrowView>;

export const emptyStream: StreamState = {};

function patchEvent(state: StreamState, eventId: string, patch: (e: LogEvent) => LogEvent): StreamState {
  for (const [escrowId, view] of Object.entries(state)) {
    const i = view.events.findIndex((e) => e.id === eventId);
    if (i === -1) continue;
    const events = view.events.slice();
    events[i] = patch(events[i]);
    return { ...state, [escrowId]: { ...view, events } };
  }
  return state; // explanation for an event we never saw: ignore, the next snapshot fixes it
}

export function streamReducer(state: StreamState, msg: WsMessage): StreamState {
  switch (msg.kind) {
    case 'snapshot':
      return { ...state, [msg.escrow.id]: { escrow: msg.escrow, events: msg.events } };

    case 'escrow': {
      const prev = state[msg.escrow.id];
      return { ...state, [msg.escrow.id]: { escrow: msg.escrow, events: prev?.events ?? [] } };
    }

    case 'event': {
      const view = state[msg.event.escrowId];
      if (!view) return state; // no escrow yet; it arrives with the next `escrow`/`snapshot`
      const i = view.events.findIndex((e) => e.id === msg.event.id);
      const events = i === -1 ? [...view.events, msg.event] : view.events.map((e, j) => (j === i ? msg.event : e));
      return { ...state, [msg.event.escrowId]: { ...view, events } };
    }

    case 'explanation_delta':
      return patchEvent(state, msg.eventId, (e) => ({ ...e, explanation: (e.explanation ?? '') + msg.text }));

    case 'explanation_done':
      return patchEvent(state, msg.eventId, (e) => ({ ...e, explanation: msg.text, explanationSource: msg.source }));
  }
}

/** The escrow a single-escrow screen should show: the requested one, else the most recently updated. */
export function pickEscrow(state: StreamState, escrowId?: string | null): EscrowView | undefined {
  if (escrowId) return state[escrowId];
  return Object.values(state).sort((a, b) => b.escrow.updatedAt.localeCompare(a.escrow.updatedAt))[0];
}

/** Final states: nothing will happen any more, so no deadline to count down to. */
export const isClosed = (s: EscrowState) => TERMINAL_STATES.includes(s);

/**
 * The `error` the agent logged for the step it is stuck on right now, if any: logged in the current
 * state and nothing about the escrow has changed since (every escrow change moves `updatedAt`; logging
 * an event does not). Without this a party screen would just keep showing "Paying…".
 */
export function currentProblem({ escrow, events }: EscrowView): LogEvent | undefined {
  const e = events.findLast((x) => x.type === 'error');
  if (!e || isClosed(escrow.state) || e.data?.state !== escrow.state || e.at < escrow.updatedAt) return undefined;
  return e;
}
