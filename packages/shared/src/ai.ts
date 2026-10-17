import { z } from 'zod';
import { ConditionSchema, EscrowSchema } from './domain.ts';
import { ExplanationSourceSchema, LogEventSchema } from './events.ts';

// AI service contracts: docs/CONTRACTS.md §4 "AI service `apps/ai`".

export const ParseRequestSchema = z.object({
  title: z.string(),
  rawText: z.string().min(1),
  amountDisplay: z.string(),       // e.g. "50" — already formatted for humans
  assetTicker: z.string(),
  deadline: z.string(),
});
export type ParseRequest = z.infer<typeof ParseRequestSchema>;

export const ParseResultSchema = z.object({
  conditions: z.array(ConditionSchema), // already validated
  summary: z.string(),
  clarifications: z.array(z.string()),
  source: z.enum(['ai', 'fallback']),
  model: z.string().optional(),
  ms: z.number(),
});
export type ParseResult = z.infer<typeof ParseResultSchema>;

export const ExplainRequestSchema = z.object({
  event: LogEventSchema,
  escrow: EscrowSchema,
});
export type ExplainRequest = z.infer<typeof ExplainRequestSchema>;

/** One SSE `data:` payload from `POST /explain`: deltas, then a final `{ done: true, text }`. */
export const ExplainStreamChunkSchema = z.union([
  z.object({ done: z.literal(true), text: z.string(), source: ExplanationSourceSchema.optional() }),
  z.object({ text: z.string() }),
]);
export type ExplainStreamChunk = z.infer<typeof ExplainStreamChunkSchema>;

export const ExplainSyncResultSchema = z.object({
  text: z.string(),
  source: ExplanationSourceSchema,
});
export type ExplainSyncResult = z.infer<typeof ExplainSyncResultSchema>;

export const AiHealthSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  loaded: z.boolean(),
  device: z.string(),
});
export type AiHealth = z.infer<typeof AiHealthSchema>;
