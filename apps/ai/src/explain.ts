import type { ExplainRequest, ExplainSyncResult } from '@escrow/shared';
import { buildFacts, type EventFacts } from './facts.ts';
import type { LlmEngine } from './llm.ts';
import { EXPLAIN_SYSTEM, explainUserPrompt } from './prompts.ts';
import { templateFor } from './templates.ts';

export interface ExplainDeps {
  engine: LlmEngine | null;
  budgetMs: number;
  log: (msg: string) => void;
}

const EXPLAIN_MAX_TOKENS = 90;
const MAX_WORDS = 60;

/** Strips markdown noise from a streamed chunk. */
export function sanitizeDelta(text: string): string {
  return text.replace(/[*`#]/g, '');
}

const SENTENCE_END = /[.!?]["')\]]*(?=\s|$)/g;

/** Text up to the last sentence end, or '' if there is none. */
function upToLastSentenceEnd(t: string): string {
  const ends = [...t.matchAll(SENTENCE_END)];
  const last = ends.at(-1);
  return last ? t.slice(0, last.index! + last[0].length) : '';
}

/**
 * Final cleanup: plain text, at most MAX_WORDS words, ending on a full sentence. Only cuts when it must
 * (output cut off or too long), so quoted test names like "Hello, World!" stay intact.
 * Returns '' when nothing usable is left; the caller then uses the template.
 */
export function cleanExplanation(text: string): string {
  let t = sanitizeDelta(text).replace(/\s+/g, ' ').trim();
  if (!/[.!?]["')\]]*$/.test(t)) t = upToLastSentenceEnd(t);
  const words = t.split(' ');
  if (words.length > MAX_WORDS) t = upToLastSentenceEnd(words.slice(0, MAX_WORDS).join(' '));
  return t.trim();
}

// A money word in the explanation is only allowed if one of its stems appears in the facts.
const MONEY_WORDS: [RegExp, string[]][] = [
  [/\brefund/, ['refund']],
  [/\breleas/, ['releas']],
  [/\breceiv/, ['receiv']],
  [/\b(pay|pays|paid|paying|payment|payout)\b/, ['pay', 'paid']],
  [/\btransfer/, ['transfer']],
  [/\b(send|sends|sent)\b/, ['sent', 'send']],
  [/\b(return|returns|returned|back to)\b/, ['back']],
  [/\b(lock|locks|locked)\b/, ['lock']],
];

/**
 * Checks an explanation only restates facts: every number must appear in the facts, and money words
 * (refund, release, receive, pay, transfer, ...) only appear when the facts are about that.
 */
export function isGrounded(text: string, facts: EventFacts): boolean {
  const factText = JSON.stringify(facts).toLowerCase();
  for (const n of text.match(/\d+(?:\.\d+)?/g) ?? []) {
    if (!factText.includes(n)) return false;
  }
  const lower = text.toLowerCase();
  for (const [re, stems] of MONEY_WORDS) {
    if (re.test(lower) && !stems.some((st) => factText.includes(st))) return false;
  }
  // A missed deadline only belongs to refunds (2B once turned "before the deadline" into "because it passed").
  if (/deadline (has |had )?(passed|expired|is over|was over)|(passed|past|after|missed) the deadline/.test(lower)
    && !factText.includes('refund')) return false;
  // Pass/fail polarity must match the verifier result.
  if (facts.result) {
    const saysFail = /\b(fail|failed|fails|did not pass|didn't pass|not pass)\b/.test(lower);
    if (facts.result.passed === saysFail) return false;
  }
  return true;
}

/**
 * Explains one log event. Streams AI text through `onDelta`; the returned text is authoritative (it may be
 * the template if the AI output was cut off, ungrounded, slow or failed). Never throws.
 */
export async function explainEvent(
  req: ExplainRequest,
  deps: ExplainDeps,
  onDelta?: (text: string) => void,
  clientSignal?: AbortSignal,
): Promise<ExplainSyncResult> {
  const facts = buildFacts(req.event, req.escrow);
  const template = templateFor(facts);
  const useTemplate = (why?: string): ExplainSyncResult => {
    if (why) deps.log(`explain ${req.event.id} (${req.event.type}): template (${why})`);
    return { text: template, source: 'template' };
  };

  const engine = deps.engine;
  if (!engine || !engine.status().loaded) {
    onDelta?.(template);
    return useTemplate();
  }

  const timeout = AbortSignal.timeout(deps.budgetMs);
  const signal = clientSignal ? AbortSignal.any([timeout, clientSignal]) : timeout;
  try {
    const out = await engine.generate({
      messages: [
        { role: 'system', content: EXPLAIN_SYSTEM },
        { role: 'user', content: explainUserPrompt(facts, template) },
      ],
      predict: EXPLAIN_MAX_TOKENS,
      signal,
      onDelta: onDelta ? (t) => onDelta(sanitizeDelta(t)) : undefined,
    });
    const text = cleanExplanation(out.text);
    if (!text) return useTemplate(`unusable output: ${JSON.stringify(out.text.slice(0, 80))}`);
    if (!isGrounded(text, facts)) return useTemplate(`ungrounded output: ${JSON.stringify(text)}`);
    return { text, source: 'ai' };
  } catch (e) {
    return useTemplate(timeout.aborted ? `timeout after ${deps.budgetMs} ms` : (e as Error).message);
  }
}
