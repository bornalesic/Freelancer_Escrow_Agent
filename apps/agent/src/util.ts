/** Errors with an HTTP status; the error handler turns them into `{ error, details }`. */
export class HttpError extends Error {
  constructor(public statusCode: number, message: string, public details?: unknown) {
    super(message);
  }
}

export const notFound = (what: string) => new HttpError(404, `${what} not found`);
export const conflict = (message: string, details?: unknown) => new HttpError(409, message, details);

/**
 * A step failed in a way worth showing in the decision log. `title` is short plain English and
 * becomes the `error` event title; `message` keeps technical detail for `data`.
 */
export class StepError extends Error {
  constructor(public title: string, public actor: 'ai' | 'wallet' | 'verifier' | 'system', detail?: string) {
    super(detail ?? title);
  }
}

export class TimeoutError extends Error {}

/** Reject if `p` does not settle within `ms`. Every network call goes through this or AbortSignal.timeout. */
export function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: NodeJS.Timeout;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new TimeoutError(`${label} timed out after ${ms} ms`)), ms);
  });
  return Promise.race([p, timeout]).finally(() => clearTimeout(timer));
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

export const nowIso = () => new Date().toISOString();

/** "a3f9c0…" → first 4 chars + ellipsis, for log titles. */
export const short = (s: string | undefined, n = 4) => (s ? `${s.slice(0, n)}…` : '?');

/** Per-key async mutex: `run(key, fn)` runs fn after every earlier fn for the same key. */
export class KeyedMutex {
  private tails = new Map<string, Promise<unknown>>();

  run<T>(key: string, fn: () => Promise<T> | T): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const next = prev.then(fn, fn);
    const tail = next.catch(() => undefined);
    this.tails.set(key, tail);
    void tail.then(() => {
      if (this.tails.get(key) === tail) this.tails.delete(key);
    });
    return next;
  }
}
