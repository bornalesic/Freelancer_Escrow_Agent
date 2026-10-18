import type { AnswerRequest, AnswerResult } from '@escrow/shared';
import { contentWords, inventedNumbers, norm, runAssist, sentence, str, type AssistDeps } from './assist.ts';
import { ANSWER_OUTPUT_SCHEMA, ANSWER_SYSTEM, answerUserPrompt } from './assistPrompts.ts';
import { conditionDetail } from './conditionText.ts';

// POST /assist/answer: a freelancer's question answered only from the terms. An answer counts only if its
// quote is literally in the terms (agreement, checks or open points) and it adds no numbers; otherwise the
// question should go to the client. The question is untrusted (fenced, never followed).

export const NOT_IN_TERMS = "The terms don't say. Ask the client before you accept.";
const PROMISE = /\b(?:guarantee[sd]?|will be paid|promise[sd]?|approved?)\b/i;

function corpus(req: AnswerRequest): { checks: string[]; open: string[]; all: string[] } {
  const checks = req.conditions.map((c) => `${c.description}${conditionDetail(c) ? ` (${conditionDetail(c)})` : ''}`);
  const open = req.clarifications ?? [];
  return { checks, open, all: [req.rawText, ...checks, ...open] };
}

const sentences = (text: string) => text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter((s) => s.length > 2);

/** Fallback: the terms sentence sharing the most content words with the question (at least half of them). */
export function bestSentence(req: AnswerRequest): string | undefined {
  const q = contentWords(req.question);
  if (!q.size) return undefined;
  let best: { s: string; score: number } | undefined;
  for (const s of corpus(req).all.flatMap(sentences)) {
    const words = contentWords(s);
    const score = [...q].filter((w) => words.has(w)).length;
    if (score > (best?.score ?? 0)) best = { s, score };
  }
  return best && best.score * 2 >= q.size ? best.s : undefined;
}

const notAnswered = () => ({ answered: false, answer: NOT_IN_TERMS });

export async function answerQuestion(req: AnswerRequest, deps: AssistDeps): Promise<AnswerResult> {
  const terms = corpus(req);
  /** Quote the best-matching sentence of the terms, or say they don't answer it. */
  const fromTerms = () => {
    const s = bestSentence(req);
    return s ? { answered: true, answer: `The terms say: "${s.replace(/[.!]+$/, '')}".`, quote: s } : notAnswered();
  };
  return runAssist('answer', deps, fromTerms, async (ask) => {
    const json = (await ask({
      system: ANSWER_SYSTEM,
      user: answerUserPrompt({ title: req.title, rawText: req.rawText, checks: terms.checks, open: terms.open, question: req.question }),
      schema: ANSWER_OUTPUT_SCHEMA,
      predict: 160,
    })) as { answered?: unknown; quote?: unknown; answer?: unknown };
    // The 2B sometimes misses an obvious answer ("Do I need a README?" vs "Also include a README."): backstop.
    if (json?.answered !== true) return fromTerms();
    const quote = str(json.quote).replace(/^["']|["']$/g, '');
    const answer = sentence(json.answer, 300);
    const all = norm(terms.all.join('\n'));
    const why =
      quote.length < 3 || !all.includes(norm(quote).replace(/[.!]+$/, '')) ? 'quote not in the terms'
      : !answer ? 'empty answer'
      : inventedNumbers(answer, terms.all).length ? 'number not in the terms'
      : PROMISE.test(answer) ? 'promise'
      : '';
    if (why) {
      deps.log(`answer: guard: ${why}; treated as not answered (${JSON.stringify(answer)})`);
      return notAnswered();
    }
    return { answered: true, answer, quote };
  });
}
