import { z } from 'zod';
import { DeliveryFileSchema } from './ai.ts';
import { ConditionSchema, EscrowSchema, VerificationResultSchema } from './domain.ts';

// AI assist features (apps/ai `/assist/*`). All advisory: they help people write and check terms, and
// never move money or feed decide(). Every one answers with a deterministic fallback (`source: 'fallback'`)
// when the model is down or its output fails the guards. The agent proxies the UI's calls through
// `POST /assist/:name` (PROXIED_ASSISTS); `hint` is called by the agent itself inside the dry run.

export const AssistSourceSchema = z.enum(['ai', 'fallback']);
export type AssistSource = z.infer<typeof AssistSourceSchema>;

const meta = { source: AssistSourceSchema, model: z.string().optional(), ms: z.number() };
const terms = {
  title: z.string().max(200),
  rawText: z.string().trim().min(1).max(10_000),
  conditions: z.array(ConditionSchema),
};

// ---- Clarifying interview (client, before "Turn into checks") ---------------------------------------

export const ClarifyRequestSchema = z.object({ title: terms.title, rawText: terms.rawText });
export type ClarifyRequest = z.infer<typeof ClarifyRequestSchema>;

export const ClarifyQuestionSchema = z.object({
  id: z.string(),                       // "q1".."q3"
  topic: z.string(),                    // 1–3 words, e.g. "Language"; used as the label in the agreement text
  question: z.string(),                 // ends with "?"
  why: z.string(),                      // one short sentence: what this answer changes in the checks
  options: z.array(z.string()).max(4),  // one-click answers; may be empty (free text)
});
export type ClarifyQuestion = z.infer<typeof ClarifyQuestionSchema>;

export const ClarifyResultSchema = z.object({ questions: z.array(ClarifyQuestionSchema).max(3), ...meta });
export type ClarifyResult = z.infer<typeof ClarifyResultSchema>;

/**
 * The agreement text with the interview answers appended as "Details" lines ("- Language: JavaScript").
 * Unanswered questions are left out. The result is what the client sends to POST /escrows.
 */
export function withInterviewAnswers(rawText: string, answers: { topic: string; answer: string }[]): string {
  const lines = answers
    .map((a) => ({ topic: a.topic.trim().replace(/:$/, ''), answer: a.answer.trim().replace(/\s+/g, ' ') }))
    .filter((a) => a.topic && a.answer)
    .map((a) => `- ${a.topic}: ${a.answer}`);
  return lines.length ? `${rawText.trimEnd()}\n\nDetails:\n${lines.join('\n')}` : rawText;
}

// ---- Verifiability: score + measurable rewrites (client, on the proposed terms) ---------------------

export const RewriteRequestSchema = z.object(terms);
export type RewriteRequest = z.infer<typeof RewriteRequestSchema>;

export const RewriteSuggestionSchema = z.object({
  conditionId: z.string(),  // the client_review condition this would replace
  quote: z.string(),        // the words in rawText to replace
  rewrite: z.string(),      // measurable wording; our own parser turns it into an automatic check
  becomes: z.enum(['tests_pass', 'file_present', 'file_hash', 'examples']),
});
export type RewriteSuggestion = z.infer<typeof RewriteSuggestionSchema>;

export const RewriteResultSchema = z.object({
  automatic: z.number().int().nonnegative(), // same numbers as verifiability(conditions)
  total: z.number().int().nonnegative(),
  suggestions: z.array(RewriteSuggestionSchema).max(6),
  ...meta,
});
export type RewriteResult = z.infer<typeof RewriteResultSchema>;

/** "5 of 6 requirements checked automatically". Everything except client_review counts as automatic. */
export function verifiability(conditions: { kind: string }[]): { automatic: number; total: number } {
  return { automatic: conditions.filter((c) => c.kind !== 'client_review').length, total: conditions.length };
}

/** rawText with the first case-insensitive occurrence of `quote` replaced; appended if it is not found. */
export function applyRewrite(rawText: string, quote: string, rewrite: string): string {
  const q = quote.trim().replace(/[.!]+$/, '');
  const at = q ? rawText.toLowerCase().indexOf(q.toLowerCase()) : -1;
  const r = rewrite.trim().replace(/[.!]+$/, '');
  if (at < 0) return `${rawText.trimEnd()}\n${rewrite.trim()}`;
  return rawText.slice(0, at) + r + rawText.slice(at + q.length);
}

// ---- Fair price and deadline (client, on the new-agreement form) ------------------------------------

export const EstimateRequestSchema = z.object({
  title: terms.title,
  rawText: terms.rawText,
  amountDisplay: z.string().regex(/^\d+(\.\d+)?$/), // what the client offers, display units
  assetTicker: z.string(),
  deadlineMinutes: z.number().positive(),
});
export type EstimateRequest = z.infer<typeof EstimateRequestSchema>;

export const JobSizeSchema = z.enum(['tiny', 'small', 'medium', 'large']);
export type JobSize = z.infer<typeof JobSizeSchema>;

export const EstimateResultSchema = z.object({
  size: JobSizeSchema,
  reason: z.string(),                                     // one sentence, no numbers
  amount: z.object({ low: z.string(), high: z.string() }), // display units, typical range for this size
  minutes: z.object({ low: z.number().int(), high: z.number().int() }),
  warnings: z.array(z.string()).max(3),                   // "50 tUSDT looks low for a medium job (usual 300–2000)"
  ...meta,
});
export type EstimateResult = z.infer<typeof EstimateResultSchema>;

// ---- Listing Q&A (freelancer asks, AI answers from the terms) ---------------------------------------

export const AnswerRequestSchema = z.object({
  ...terms,
  clarifications: z.array(z.string()).optional(),
  question: z.string().trim().min(3).max(500),
});
export type AnswerRequest = z.infer<typeof AnswerRequestSchema>;

export const AnswerResultSchema = z.object({
  answered: z.boolean(),         // false → the terms don't say; the question should go to the client
  answer: z.string(),
  quote: z.string().optional(),  // the words in the terms the answer rests on (present when answered)
  ...meta,
});
export type AnswerResult = z.infer<typeof AnswerResultSchema>;

// ---- Fix hints for failed checks (agent calls this inside the dry run) ------------------------------

export const HintRequestSchema = z.object({
  escrow: EscrowSchema,
  results: z.array(VerificationResultSchema), // the dry run's results; only failed ones get a hint
  files: z.array(DeliveryFileSchema.extend({ excerpt: z.string().optional() })), // same excerpts as /review
});
export type HintRequest = z.infer<typeof HintRequestSchema>;

export const HintItemSchema = z.object({
  conditionId: z.string(),
  why: z.string(),   // one sentence: what failed, with the actual vs expected value when known
  hint: z.string(),  // one sentence: where to look / what to change
});
export type HintItem = z.infer<typeof HintItemSchema>;

export const HintResultSchema = z.object({ items: z.array(HintItemSchema), ...meta });
export type HintResult = z.infer<typeof HintResultSchema>;

// ---- Job matching and team splitting (freelancer) ---------------------------------------------------

export const MatchRequestSchema = z.object({
  skills: z.string().trim().min(2).max(1000),
  jobs: z.array(z.object({ id: z.string(), ...terms })).min(1).max(20),
});
export type MatchRequest = z.infer<typeof MatchRequestSchema>;

export const JobFitSchema = z.enum(['good', 'partial', 'poor']);
export type JobFit = z.infer<typeof JobFitSchema>;

export const MatchResultSchema = z.object({
  ranked: z.array(z.object({ id: z.string(), fit: JobFitSchema, reason: z.string() })), // best first, every job once
  ...meta,
});
export type MatchResult = z.infer<typeof MatchResultSchema>;

export const SplitRequestSchema = z.object({
  ...terms,
  conditions: terms.conditions.min(1),
  members: z.array(z.object({ name: z.string().trim().min(1).max(60), skills: z.string().trim().min(1).max(500) })).min(2).max(6),
});
export type SplitRequest = z.infer<typeof SplitRequestSchema>;

export const SplitResultSchema = z.object({
  assignments: z.array(z.object({ member: z.string(), conditionIds: z.array(z.string()), note: z.string() })), // every condition exactly once
  ...meta,
});
export type SplitResult = z.infer<typeof SplitResultSchema>;

// ---- Registry ---------------------------------------------------------------------------------------

export const ASSIST_SCHEMAS = {
  clarify: { request: ClarifyRequestSchema, result: ClarifyResultSchema },
  rewrite: { request: RewriteRequestSchema, result: RewriteResultSchema },
  estimate: { request: EstimateRequestSchema, result: EstimateResultSchema },
  answer: { request: AnswerRequestSchema, result: AnswerResultSchema },
  hint: { request: HintRequestSchema, result: HintResultSchema },
  match: { request: MatchRequestSchema, result: MatchResultSchema },
  split: { request: SplitRequestSchema, result: SplitResultSchema },
} as const;
export type AssistName = keyof typeof ASSIST_SCHEMAS;
export const ASSIST_NAMES = Object.keys(ASSIST_SCHEMAS) as AssistName[];

/** Assists the UI may call through the agent's `POST /assist/:name`. `hint` needs the agent's excerpts. */
export const PROXIED_ASSISTS = ['clarify', 'rewrite', 'estimate', 'answer', 'match', 'split'] as const satisfies readonly AssistName[];
export type ProxiedAssistName = (typeof PROXIED_ASSISTS)[number];

// ---- Agent: pre-submission dry run ------------------------------------------------------------------

/** `POST /escrows/:id/dry-run` (multipart `file`): the verifier on a practice upload. No state change. */
export const DryRunResponseSchema = z.object({
  results: z.array(VerificationResultSchema), // automatic conditions only, same as a real delivery
  passed: z.number().int().nonnegative(),
  total: z.number().int().nonnegative(),
  hints: HintResultSchema.optional(),         // absent when everything passed or the AI is unreachable
});
export type DryRunResponse = z.infer<typeof DryRunResponseSchema>;
