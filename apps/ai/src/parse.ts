import type { ParseRequest, ParseResult } from '@escrow/shared';
import { literalExamplesDraft, proposeExamples, type ExamplesDraft } from './examples.ts';
import { fallbackParse } from './fallback.ts';
import type { ChatMessage, LlmEngine } from './llm.ts';
import { extractJson, postprocess } from './postprocess.ts';
import { PARSE_OUTPUT_SCHEMA, PARSE_SYSTEM, parseRetryPrompt, parseUserPrompt } from './prompts.ts';

export interface ParseDeps {
  engine: LlmEngine | null;
  budgetMs: number;          // whole request, both attempts included
  log: (msg: string) => void;
  /** Add `examples` checks: AI_EXAMPLES is not off and ConditionSchema has the kind (examplesInContract()). */
  examples?: boolean;
  /** Also let the model propose cases (AI_EXAMPLES=model). Off by default: the 2B writes wrong outputs. */
  exampleModel?: boolean;
}

const PARSE_MAX_TOKENS = 700;
const PARSE_PRIORITY = 10;   // parses jump ahead of queued explanations

/**
 * Model attempt → (one retry with the validation error) → deterministic fallback. Never throws.
 * With `examples`, the examples written in the agreement become one automatic check; with `exampleModel`
 * a second model call (in parallel, second slot) adds proposed cases.
 */
export async function parseAgreement(req: ParseRequest, deps: ParseDeps): Promise<ParseResult> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const fallback = (why: string, draft?: ExamplesDraft): ParseResult => {
    deps.log(`parse: using fallback parser (${why})`);
    return { ...fallbackParse(req, { examples: deps.examples, draft }), ms: ms() };
  };

  const engine = deps.engine;
  if (!engine || !engine.status().loaded) return fallback('model not loaded');

  const signal = AbortSignal.timeout(deps.budgetMs);
  const examples = !deps.examples ? Promise.resolve(undefined)
    : deps.exampleModel ? proposeExamples(req, engine, signal, deps.log)
    : Promise.resolve(literalExamplesDraft(req.rawText));
  const messages: ChatMessage[] = [
    { role: 'system', content: PARSE_SYSTEM },
    { role: 'user', content: parseUserPrompt(req) },
  ];
  try {
    for (let attempt = 1; attempt <= 2; attempt++) {
      const out = await engine.generate({
        messages, predict: PARSE_MAX_TOKENS, jsonSchema: PARSE_OUTPUT_SCHEMA, signal, priority: PARSE_PRIORITY,
      });
      const draft = await examples; // never rejects
      let error: string;
      try {
        const post = postprocess(extractJson(out.text), req, draft);
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
    return fallback('model output invalid twice', await examples);
  } catch (e) {
    return fallback(signal.aborted ? `timeout after ${deps.budgetMs} ms` : `error: ${(e as Error).message}`);
  }
}
