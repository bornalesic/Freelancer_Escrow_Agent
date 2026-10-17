import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { WsMessage } from '@escrow/shared';
import { agentWsUrl, config } from '../config';
import { fixtureEscrow, fixtureEvents } from '../fixtures/snapshot';
import { agentApi } from './api';
import { emptyStream, streamReducer, type StreamState } from './escrowStore';
import { errorMessage } from './http';

export interface Poll<T> {
  data?: T;
  error?: string;
  /** true until the first answer (success or failure). */
  loading: boolean;
}

/** Calls `fn` now and every `ms`, paused while the tab is hidden. Keeps the last good data on errors. */
export function usePoll<T>(fn: (() => Promise<T>) | null, ms: number): Poll<T> {
  const [state, setState] = useState<Poll<T>>({ loading: fn !== null });
  const fnRef = useRef(fn);
  fnRef.current = fn;
  const enabled = fn !== null;

  useEffect(() => {
    if (!enabled) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      if (stopped) return;
      if (document.visibilityState === 'visible' && fnRef.current) {
        try {
          const data = await fnRef.current();
          if (!stopped) setState({ data, loading: false });
        } catch (err) {
          if (!stopped) setState((s) => ({ data: s.data, error: errorMessage(err), loading: false }));
        }
      }
      if (!stopped) timer = setTimeout(tick, ms);
    };
    const onVisible = () => {
      if (document.visibilityState === 'visible') {
        clearTimeout(timer);
        void tick();
      }
    };

    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, ms]);

  return state;
}

export type StreamStatus = 'connecting' | 'live' | 'reconnecting' | 'fixture';

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];

/**
 * One WebSocket to the agent for this view. Without `escrowId` it follows every escrow and also
 * loads `GET /escrows` once per connection, so lists are complete even before any change is streamed.
 */
export function useEscrowStream(escrowId?: string): { state: StreamState; status: StreamStatus } {
  const [state, dispatch] = useReducer(streamReducer, emptyStream);
  const [status, setStatus] = useState<StreamStatus>(config.fixture ? 'fixture' : 'connecting');

  useEffect(() => {
    if (config.fixture) {
      dispatch({ kind: 'snapshot', escrow: fixtureEscrow, events: fixtureEvents });
      return;
    }

    let ws: WebSocket | undefined;
    let attempt = 0;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const connect = () => {
      ws = new WebSocket(agentWsUrl(escrowId));
      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
        if (!escrowId) {
          agentApi
            .listEscrows()
            .then((list) => list.forEach((escrow) => dispatch({ kind: 'escrow', escrow })))
            .catch(() => {}); // the health dots already show an unreachable agent
        }
      };
      ws.onmessage = (m) => {
        try {
          dispatch(JSON.parse(String(m.data)) as WsMessage);
        } catch {
          // malformed frame: skip it rather than break the screen
        }
      };
      ws.onclose = () => {
        if (stopped) return;
        setStatus('reconnecting');
        timer = setTimeout(connect, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
      };
    };

    connect();
    return () => {
      stopped = true;
      clearTimeout(timer);
      ws?.close();
    };
  }, [escrowId]);

  return { state, status };
}


/** Wraps an async action with busy/error state for buttons. */
export function useAction<A extends unknown[]>(fn: (...args: A) => Promise<unknown>) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const run = useCallback(
    async (...args: A) => {
      setBusy(true);
      setError(undefined);
      try {
        await fn(...args);
      } catch (err) {
        setError(errorMessage(err));
      } finally {
        setBusy(false);
      }
    },
    [fn],
  );
  return { run, busy, error };
}
