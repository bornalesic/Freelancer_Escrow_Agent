// fetch wrapper: every call has a timeout, and errors carry the server's `{ error, details }`.

export class HttpError extends Error {
  constructor(
    message: string,
    /** 0 = network error or timeout (server not reachable). */
    readonly status: number,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'HttpError';
  }
}

export interface RequestOptions {
  method?: 'GET' | 'POST';
  /** JSON-encoded unless it is FormData. */
  body?: unknown;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

export async function requestJson<T>(base: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const { method = opts.body === undefined ? 'GET' : 'POST', body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const isForm = body instanceof FormData;

  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers: body === undefined || isForm ? undefined : { 'content-type': 'application/json' },
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new HttpError(timedOut ? `${base} did not answer in ${timeoutMs / 1000} s` : `Cannot reach ${base}`, 0);
  }

  const text = await res.text();
  let json: unknown;
  try {
    json = text ? JSON.parse(text) : undefined;
  } catch {
    json = undefined;
  }

  if (!res.ok) {
    const e = json as { error?: string; details?: unknown } | undefined;
    throw new HttpError(e?.error ?? `${method} ${path} failed (${res.status})`, res.status, e?.details);
  }
  return json as T;
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
