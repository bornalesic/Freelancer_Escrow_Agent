import {
  AI_ROUTES,
  AiReviewSchema,
  ExplainStreamChunkSchema,
  ParseResultSchema,
  type AiReview,
  type Escrow,
  type ExplanationSource,
  type LogEvent,
  type ParseRequest,
  type ParseResult,
  type ReviewRequest,
} from '@escrow/shared';
import type { Config } from './config';
import { log } from './log';
import { fallbackParse } from './parse-fallback';
import { errorMessage } from './util';

/** Drop file_hash conditions whose hash is not literally in the agreement text (anti-hallucination). */
function guardHashes(result: ParseResult, rawText: string): ParseResult {
  const text = rawText.toLowerCase();
  const clarifications = [...result.clarifications];
  const conditions = result.conditions.filter((c) => {
    if (c.kind !== 'file_hash' || text.includes(c.sha256)) return true;
    clarifications.push(`A file fingerprint was suggested but does not appear in the agreement, so it was left out.`);
    return false;
  });
  // Normalise ids so they are unique and stable: c1..cn.
  return { ...result, conditions: conditions.map((c, i) => ({ ...c, id: `c${i + 1}` })), clarifications };
}

export class AiClient {
  private up = false;
  private modelName?: string;
  private checkedAt = 0;
  private queue: Promise<unknown> = Promise.resolve();

  constructor(private config: Config) {}

  /** Run model calls one at a time (the model is shared on a small GPU). Never blocks the escrow flow. */
  exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const run = this.queue.then(fn, fn);
    this.queue = run.catch(() => undefined);
    return run;
  }

  /** Last known health. */
  get isUp(): boolean {
    return this.up;
  }

  /** Model name from the last successful health check. */
  get model(): string | undefined {
    return this.up ? this.modelName : undefined;
  }

  /**
   * Health, re-probed (2 s) if older than 10 s. On WSL a closed port can hang instead of refusing,
   * so without this a down AI would cost the full parse/explain timeout on every call.
   */
  async available(): Promise<boolean> {
    if (Date.now() - this.checkedAt > 10_000) await this.health();
    return this.up;
  }

  /** Parse an agreement. Never throws: falls back to the deterministic parser. */
  async parse(req: ParseRequest): Promise<ParseResult> {
    const started = Date.now();
    if (!(await this.available())) {
      log.warn('ai is down, using the fallback parser');
      return fallbackParse(req, this.config.verifyDefaultTimeoutSec, started);
    }
    for (let attempt = 1; attempt <= 2; attempt++) {
      try {
        const res = await fetch(this.config.aiUrl + AI_ROUTES.parse, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(req),
          signal: AbortSignal.timeout(this.config.aiParseTimeoutMs),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
        return guardHashes(ParseResultSchema.parse(await res.json()), req.rawText);
      } catch (err) {
        const timedOut = err instanceof Error && err.name === 'TimeoutError';
        log.warn(`ai /parse attempt ${attempt} failed: ${errorMessage(err)}`);
        if (timedOut) break; // don't wait another full timeout
      }
    }
    return fallbackParse(req, this.config.verifyDefaultTimeoutSec, started);
  }

  /**
   * Stream an explanation for one event. `onDelta` gets each text chunk. Resolves with the full text,
   * or throws (caller uses the template).
   */
  async explain(
    event: LogEvent,
    escrow: Escrow,
    onDelta: (text: string) => void,
  ): Promise<{ text: string; source: ExplanationSource }> {
    const res = await fetch(this.config.aiUrl + AI_ROUTES.explain, {
      method: 'POST',
      headers: { 'content-type': 'application/json', accept: 'text/event-stream' },
      body: JSON.stringify({ event, escrow }),
      signal: AbortSignal.timeout(this.config.aiExplainTimeoutMs),
    });
    if (!res.ok || !res.body) throw new Error(`HTTP ${res.status}`);

    const decoder = new TextDecoder();
    let pending = '';
    let full = '';
    for await (const chunk of res.body as unknown as AsyncIterable<Uint8Array>) {
      pending += decoder.decode(chunk, { stream: true }).replace(/\r\n/g, '\n');
      let sep: number;
      while ((sep = pending.indexOf('\n\n')) !== -1) {
        const frame = pending.slice(0, sep);
        pending = pending.slice(sep + 2);
        const data = frame
          .split('\n')
          .filter((l) => l.startsWith('data:'))
          .map((l) => l.slice(5).trimStart())
          .join('\n');
        if (!data) continue;
        const msg = ExplainStreamChunkSchema.parse(JSON.parse(data));
        if ('done' in msg) return { text: msg.text || full, source: msg.source ?? 'ai' };
        full += msg.text;
        onDelta(msg.text);
      }
    }
    if (!full) throw new Error('explanation stream ended without text');
    return { text: full, source: 'ai' };
  }

  /** Advisory review of the client_review conditions. Throws on any failure (caller uses the template). */
  async review(req: ReviewRequest): Promise<AiReview> {
    if (!(await this.available())) throw new Error('ai is down');
    const res = await fetch(this.config.aiUrl + AI_ROUTES.review, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(req),
      signal: AbortSignal.timeout(this.config.aiReviewTimeoutMs),
    });
    if (!res.ok) throw new Error(`HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
    return AiReviewSchema.parse(await res.json());
  }

  async health(): Promise<boolean> {
    let ok = false;
    try {
      const res = await fetch(this.config.aiUrl + AI_ROUTES.health, { signal: AbortSignal.timeout(2000) });
      // Lenient on purpose (only `ok` matters): a missing model/device must not send us to the fallback.
      const h = (res.ok ? await res.json() : {}) as { ok?: unknown; model?: unknown };
      ok = h.ok === true;
      this.modelName = typeof h.model === 'string' ? h.model : undefined;
    } catch {
      ok = false;
    }
    this.up = ok;
    this.checkedAt = Date.now();
    return ok;
  }
}

export type ExplainDone = (text: string, source: ExplanationSource) => void;

/**
 * Runs explanations one at a time (the model is shared with /parse on a small GPU) without ever
 * blocking the escrow flow. Each request has its own timeout; failures fall back to `template`.
 */
export class Explainer {
  constructor(private ai: AiClient) {}

  enqueue(
    event: LogEvent,
    escrow: Escrow,
    template: string,
    onDelta: (text: string) => void,
    onDone: ExplainDone,
  ): void {
    void this.ai.exclusive(async () => {
      if (!(await this.ai.available())) return onDone(template, 'template');
      try {
        const r = await this.ai.explain(event, escrow, onDelta);
        const text = r.text.trim();
        onDone(text || template, text ? r.source : 'template');
      } catch (err) {
        log.warn(`ai /explain for ${event.id} failed, using template: ${errorMessage(err)}`);
        onDone(template, 'template');
      }
    });
  }
}
