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
  headers?: Record<string, string> | undefined;
  timeoutMs?: number;
}

const DEFAULT_TIMEOUT_MS = 10_000;

async function send(base: string, path: string, opts: RequestOptions): Promise<Response> {
  const { method = opts.body === undefined ? 'GET' : 'POST', body, timeoutMs = DEFAULT_TIMEOUT_MS } = opts;
  const isForm = body instanceof FormData;
  const headers: Record<string, string> = { ...(opts.headers ?? {}) };
  if (body !== undefined && !isForm) headers['content-type'] = 'application/json';
  let res: Response;
  try {
    res = await fetch(base + path, {
      method,
      headers,
      body: body === undefined ? undefined : isForm ? body : JSON.stringify(body),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (err) {
    const timedOut = err instanceof DOMException && err.name === 'TimeoutError';
    throw new HttpError(timedOut ? `${base} did not answer in ${timeoutMs / 1000} s` : `Cannot reach ${base}`, 0);
  }
  if (!res.ok) {
    let e: { error?: string; details?: unknown } | undefined;
    try {
      e = (await res.json()) as typeof e;
    } catch {
      e = undefined;
    }
    throw new HttpError(e?.error ?? `${method} ${path} failed (${res.status})`, res.status, e?.details);
  }
  return res;
}

export async function requestJson<T>(base: string, path: string, opts: RequestOptions = {}): Promise<T> {
  const res = await send(base, path, opts);
  const text = await res.text();
  return (text ? JSON.parse(text) : undefined) as T;
}

/** A file as a blob URL: lets an <img> show a file that needs a token header. Revoke it when done. */
/** Raster images are safe to show; they can't run code even when opened on their own. */
const SAFE_BLOB_TYPES = new Set(['image/png', 'image/jpeg', 'image/gif', 'image/webp']);

/**
 * A delivered file as a blob URL. Blob URLs belong to this page's origin, and the agent's
 * `Content-Security-Policy: sandbox` header does not come with them. A delivered SVG or HTML file opened
 * from such a URL ("Open image in new tab") would run as this app, on localhost, which the party servers
 * trust: it could spend the wallet. So anything but a plain raster image is typed as a download.
 */
export async function requestBlobUrl(base: string, path: string, headers?: Record<string, string>): Promise<string> {
  const res = await send(base, path, { headers, timeoutMs: 30_000 });
  const blob = await res.blob();
  const type = blob.type.split(';')[0]!.trim().toLowerCase();
  return URL.createObjectURL(SAFE_BLOB_TYPES.has(type) ? blob : new Blob([blob], { type: 'application/octet-stream' }));
}

export function errorMessage(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
