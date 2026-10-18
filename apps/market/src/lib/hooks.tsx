import { createContext, useCallback, useContext, useEffect, useReducer, useRef, useState, type ReactNode } from 'react';
import type { ConfigResponse, PartyRole, WalletResponse, WsMessage } from '@escrow/shared';
import { agentApi, partyApi } from './api';
import { assist, type AssistName, type AssistTypes } from './assist';
import { agentWsUrl } from './config';
import { errorMessage } from './http';
import { emptyStream, streamReducer, type StreamState } from './stream';

export interface Poll<T> {
  data?: T;
  error?: string;
  /** true until the first answer (success or failure). */
  loading: boolean;
}

/** Calls `fn` now and every `ms`, paused while the tab is hidden. Keeps the last good data on errors. */
export function usePoll<T>(fn: (() => Promise<T>) | null, ms: number, key = ''): Poll<T> {
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
      if (document.visibilityState !== 'visible') return;
      clearTimeout(timer);
      void tick();
    };
    void tick();
    document.addEventListener('visibilitychange', onVisible);
    return () => {
      stopped = true;
      clearTimeout(timer);
      document.removeEventListener('visibilitychange', onVisible);
    };
  }, [enabled, ms, key]);

  return state;
}

/** Date.now(), re-rendered every `ms` (countdowns). */
export function useNow(ms = 1_000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [ms]);
  return now;
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
  return { run, busy, error, clearError: () => setError(undefined) };
}

export interface AssistResult<T> {
  data?: T;
  loading: boolean;
  unavailable: boolean;
}

/** Runs an assist once per `key` (null = not now). Advice only: failures leave `data` empty. */
export function useAssistResult<N extends AssistName>(name: N, body: AssistTypes[N][0] | null, key: string | null): AssistResult<AssistTypes[N][1]> {
  const [state, setState] = useState<AssistResult<AssistTypes[N][1]> & { key?: string }>({ loading: false, unavailable: false });
  const bodyRef = useRef(body);
  bodyRef.current = body;

  useEffect(() => {
    const req = bodyRef.current;
    if (key === null || !req) return;
    let stopped = false;
    setState({ key, loading: true, unavailable: false });
    assist(name, req)
      .then((data) => !stopped && setState({ key, data, loading: false, unavailable: false }))
      .catch(() => !stopped && setState({ key, loading: false, unavailable: true })); // any failure: just no advice
    return () => {
      stopped = true;
    };
  }, [name, key]);

  return state.key === key && key !== null ? state : { loading: key !== null, unavailable: false };
}

// ---- the agent: one WebSocket and /config for the whole app -------------------------------------------

export type StreamStatus = 'connecting' | 'live' | 'reconnecting';

interface Market {
  jobs: StreamState;
  status: StreamStatus;
  /** The agent's full job list arrived at least once: a job missing from `jobs` really does not exist. */
  loaded: boolean;
  /** The agent's /config; undefined until the agent answered once. */
  asset?: ConfigResponse;
  /** Fetch the full job list now (e.g. after clearing the agent's store). */
  refresh: () => void;
}

const MarketContext = createContext<Market>({ jobs: emptyStream, status: 'connecting', loaded: false, refresh: () => {} });

const BACKOFF_MS = [500, 1_000, 2_000, 4_000, 8_000];
const LIST_EVERY_MS = 15_000;

/**
 * Follows every job on the agent: one WebSocket (snapshots, then live changes and AI explanations) and
 * `GET /escrows` on every connect and every 15 s, which also drops jobs the agent no longer has.
 */
export function MarketProvider({ children }: { children: ReactNode }) {
  const [jobs, dispatch] = useReducer(streamReducer, emptyStream);
  const [status, setStatus] = useState<StreamStatus>('connecting');
  const [loaded, setLoaded] = useState(false);
  const [asset, setAsset] = useState<ConfigResponse>();
  const listRef = useRef<() => void>(() => {});
  const refresh = useCallback(() => listRef.current(), []);

  useEffect(() => {
    let ws: WebSocket | undefined;
    let attempt = 0;
    let reconnect: ReturnType<typeof setTimeout> | undefined;
    let stopped = false;

    const list = () => {
      const requestedAt = Date.now();
      agentApi.list().then(
        (escrows) => {
          if (stopped) return;
          dispatch({ kind: 'list', escrows, requestedAt });
          setLoaded(true);
        },
        () => {}, // the live dot already shows an unreachable agent
      );
    };
    listRef.current = list;
    const connect = () => {
      ws = new WebSocket(agentWsUrl());
      ws.onopen = () => {
        attempt = 0;
        setStatus('live');
        list();
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
        reconnect = setTimeout(connect, BACKOFF_MS[Math.min(attempt++, BACKOFF_MS.length - 1)]);
      };
    };
    connect();
    const listing = setInterval(list, LIST_EVERY_MS);
    return () => {
      stopped = true;
      clearTimeout(reconnect);
      clearInterval(listing);
      ws?.close();
    };
  }, []);

  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const load = () =>
      agentApi.config().then(
        (c) => !stopped && setAsset(c),
        () => {
          if (!stopped) timer = setTimeout(load, 3_000);
        },
      );
    void load();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);

  return <MarketContext.Provider value={{ jobs, status, loaded, refresh, ...(asset ? { asset } : {}) }}>{children}</MarketContext.Provider>;
}

export const useMarket = () => useContext(MarketContext);

/** This laptop's own wallet for `role`. Only the party server on this laptop answers it. */
export function useOwnWallet(role: PartyRole | null): Poll<WalletResponse> {
  return usePoll(role ? () => partyApi(role).wallet() : null, 5_000, role ?? '');
}
