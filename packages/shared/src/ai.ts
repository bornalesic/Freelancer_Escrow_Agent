import { z } from 'zod';
import { ConditionSchema, EscrowSchema } from './domain.ts';
import { ExplanationSourceSchema, LogEventSchema } from './events.ts';

export const ParseRequestSchema = z.object({
  title: z.string(),
  rawText: z.string().min(1),
  amountDisplay: z.string(), // e.g. "50"
  assetTicker: z.string(),
  deadline: z.string(),
});
export type ParseRequest = z.infer<typeof ParseRequestSchema>;

export const ParseResultSchema = z.object({
  conditions: z.array(ConditionSchema), // already validated; may include client_review
  summary: z.string(),
  clarifications: z.array(z.string()), // things that can't be agreed yet (e.g. "the hash I'll send later")
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

/** One SSE `data:` payload from `POST /explain`: deltas, then a final `{ done: true, text, source? }`. */
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

/** One file of the unpacked delivery, as sent to `/review` and listed by the agent's file route. */
export const DeliveryFileSchema = z.object({
  path: z.string(),      // relative, "/"-separated
  sizeBytes: z.number().int().nonnegative(),
});
export type DeliveryFile = z.infer<typeof DeliveryFileSchema>;

export const ReviewRequestSchema = z.object({
  escrow: EscrowSchema,  // rawText, conditions, deliveries (with automatic results)
  deliveryN: z.number().int().positive(),
  files: z.array(DeliveryFileSchema.extend({
    excerpt: z.string().optional(), // first few KB of a text file; absent for binaries
  })),
});
export type ReviewRequest = z.infer<typeof ReviewRequestSchema>;

export const AiHealthSchema = z.object({
  ok: z.boolean(),
  model: z.string(),
  loaded: z.boolean(),
  device: z.string(),
});
export type AiHealth = z.infer<typeof AiHealthSchema>;
