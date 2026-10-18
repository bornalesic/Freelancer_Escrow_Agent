import type { AssistSource } from '@escrow/shared';
import type { ChatMessage, LlmEngine } from './llm.ts';
import { extractJson } from './json.ts';

// Shared plumbing for the /assist/* features: one grammar-constrained model call, guards written per
// feature, and a deterministic fallback on any failure. Never throws.

export interface AssistDeps {
  engine: LlmEngine | null;
  budgetMs: number;
  log: (msg: string) => void;
}

export const ASSIST_PRIORITY = 8; // a person is waiting: after /parse (10), before /review (5) and /explain (0)

export interface AskOptions {
  system: string;
  user: string;
  schema: Record<string, unknown>;
  predict: number;
}

export type Ask = (o: AskOptions) => Promise<unknown>;
type Meta = { source: AssistSource; model?: string; ms: number };

/**
 * `viaModel` gets an `ask` function (model call → parsed JSON) and returns the guarded result, or
 * `undefined` when the guards left nothing usable. Then, and on errors/timeouts, `fallback()` answers.
 */
export async function runAssist<T extends object>(
  name: string,
  deps: AssistDeps,
  fallback: () => T,
  viaModel: (ask: Ask) => Promise<T | undefined>,
): Promise<T & Meta> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const useFallback = (why: string): T & Meta => {
    deps.log(`${name}: fallback (${why})`);
    return { ...fallback(), source: 'fallback', ms: ms() };
  };

  const engine = deps.engine;
  if (!engine || !engine.status().loaded) return useFallback('model not loaded');
  const signal = AbortSignal.timeout(deps.budgetMs);
  const ask: Ask = async (o) => {
    const messages: ChatMessage[] = [{ role: 'system', content: o.system }, { role: 'user', content: o.user }];
    const out = await engine.generate({ messages, predict: o.predict, jsonSchema: o.schema, signal, priority: ASSIST_PRIORITY });
    deps.log(`${name}: model answered in ${out.ms} ms (${out.generatedTokens ?? '?'} tokens)`);
    return extractJson(out.text);
  };
  try {
    const value = await viaModel(ask);
    if (!value) return useFallback('guards rejected the model output');
    return { ...value, source: 'ai', model: engine.status().model, ms: ms() };
  } catch (e) {
    return useFallback(signal.aborted ? `timeout after ${deps.budgetMs} ms` : `error: ${(e as Error).message}`);
  }
}

// ---- small text helpers used by several assists -----------------------------------------------------

export const str = (v: unknown): string => (typeof v === 'string' ? v.replace(/\s+/g, ' ').trim() : '');
export const norm = (t: string) => t.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();

/** One or two short sentences: markdown stripped, cut at a sentence end near `max`. */
export function sentence(v: unknown, max = 240): string {
  const t = str(v).replace(/[*_#]/g, '').replace(/^["']|["']$/g, '');
  if (t.length <= max) return t;
  const cut = t.slice(0, max);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('? '), cut.lastIndexOf('! '));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** Numbers in `text` that do not appear in any of `sources` (catches invented amounts, sizes, counts). */
export function inventedNumbers(text: string, sources: string[]): string[] {
  const numbers = (t: string) => [...t.matchAll(/\d+(?:[.,]\d+)?/g)].map((m) => m[0]);
  const known = new Set(sources.flatMap(numbers)); // whole numbers: "5" is not grounded by "50"
  return numbers(text).filter((n) => !known.has(n));
}

const STOP = new Set(('a an and are as at be but by can do does for from has have how i if in into is it its of on or ' +
  'should so that the their them then there these this to was what when where which who will with would you your ' +
  'must also any all not no yes need needs make made use used using one get it\'s job work').split(' '));

/** Lowercase content words (≥ 3 letters, no stop words), for keyword overlap. */
export function contentWords(text: string): Set<string> {
  return new Set(norm(text).split(/[^a-z0-9+#.]+/).map((w) => w.replace(/\.+$/, '')).filter((w) => w.length >= 3 && !STOP.has(w)));
}
