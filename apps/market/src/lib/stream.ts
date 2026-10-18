// Everything the agent streams over its WebSocket, as pure state (apps/web's reducer plus `list`). The UI
// renders only from this. `snapshot` replaces one escrow and its log; the other messages patch it.
import type { Escrow, LogEvent, WsMessage } from '@escrow/shared';

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
    events[i] = patch(events[i]!);
    return { ...state, [escrowId]: { ...view, events } };
  }
  return state; // explanation for an event we never saw: the next snapshot fixes it
}

/**
 * `list`: the agent's full `GET /escrows`, fetched at `requestedAt`. It also drops jobs the agent no longer
 * has (its store was reset), so a restarted demo never shows old jobs. Jobs created after the request
 * started are kept: the list may simply predate them.
 */
export type StreamAction = WsMessage | { kind: 'list'; escrows: Escrow[]; requestedAt: number };

export function streamReducer(state: StreamState, msg: StreamAction): StreamState {
  switch (msg.kind) {
    case 'list': {
      const next: StreamState = {};
      for (const escrow of msg.escrows) next[escrow.id] = { escrow, events: state[escrow.id]?.events ?? [] };
      for (const [id, view] of Object.entries(state)) {
        if (!next[id] && Date.parse(view.escrow.createdAt) >= msg.requestedAt) next[id] = view;
      }
      return next;
    }

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
