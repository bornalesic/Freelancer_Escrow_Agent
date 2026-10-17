import type { ParseRequest, ParseResult } from '@escrow/shared';
import { fallbackParse } from './fallback.ts';
import type { ChatMessage, LlmEngine } from './llm.ts';
import { extractJson, postprocess } from './postprocess.ts';
import { PARSE_OUTPUT_SCHEMA, PARSE_SYSTEM, parseRetryPrompt, parseUserPrompt } from './prompts.ts';

export interface ParseDeps {
  engine: LlmEngine | null;
  budgetMs: number;          // whole request, both attempts included
  log: (msg: string) => void;
}

const PARSE_MAX_TOKENS = 700;
const PARSE_PRIORITY = 10;   // parses jump ahead of queued explanations

/** Model attempt → (one retry with the validation error) → deterministic fallback. Never throws. */
export async function parseAgreement(req: ParseRequest, deps: ParseDeps): Promise<ParseResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const fallback = (why: string): ParseResult => {
    deps.log(`parse: using fallback parser (${why})`);
    return { ...fallbackParse(req), ms: ms() };
  };

  const engine = deps.engine;
  if (!engine || !engine.status().loaded) return fallback('model not loaded');

  const signal = AbortSignal.timeout(deps.budgetMs);
  const messages: ChatMessage[] = [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: parseUserPrompt(req) },
  ];
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await engine.generate({
        messages, predict: PARSE_MAX_TOKENS, jsonSchema: PARSE_OUTPUT_SCHEMA, signal, priority: PARSE_PRIORITY,
      });
      let error: string;
      try {
        const post = postprocess(extractJson(out.text), req);
        if (post.ok) {
          for (const n of post.notes) deps.log(`parse: guard: ${n}`);
          deps.log(`parse: ok on attempt ${attempt} (${out.ms} ms, ${out.generatedTokens ?? '?'} tokens)`);
          return { ...post.value, source: 'ai', model: engine.status().model, ms: ms() };
        }
        error = post.error;
      } catch (e) {
        error = `output is not valid JSON (${(e as Error).message})${out.stopReason === 'length' ? ', it was cut off; be shorter' : ''}`;
      }
      deps.log(`parse: attempt ${attempt} rejected: ${error}; raw output (${out.stopReason ?? '?'}): ${JSON.stringify(out.text.slice(0, 1200))}`);
      messages.push({ role: 'assistant', content: out.text }, { role: 'user', content: parseRetryPrompt(error) });
    }
    return fallback('model output invalid twice');
  } catch (e) {
    return fallback(signal.aborted ? `timeout after ${deps.budgetMs} ms` : `error: ${(e as Error).message}`);
  }
}
