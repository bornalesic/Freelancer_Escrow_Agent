import { z } from 'zod';
import { EscrowSchema } from './domain.ts';

// 1:1 translation of docs/CONTRACTS.md §2.

export const ActorSchema = z.enum(['client', 'freelancer', 'agent', 'ai', 'verifier', 'wallet', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

export const LOG_EVENT_TYPES = [
  'escrow.created', 'terms.proposed', 'terms.accepted', 'terms.agreed',
  'funding.invoice_created', 'funding.payment_seen', 'funding.settled',
  'delivery.received', 'verify.started', 'verify.condition_result', 'verify.finished',
  'decision.made',
  'payout.sent', 'payout.settled', 'refund.sent', 'refund.settled',
  'escrow.cancelled', 'error',
] as const;
export const LogEventTypeSchema = z.enum(LOG_EVENT_TYPES);
export type LogEventType = z.infer<typeof LogEventTypeSchema>;

export const ExplanationSourceSchema = z.enum(['ai', 'template']);
export type ExplanationSource = z.infer<typeof ExplanationSourceSchema>;

export const LogEventSchema = z.object({
  id: z.string(),                  // monotonic per escrow, e.g. "esc_7f3a:0007"
  escrowId: z.string(),
  at: z.string(),
  actor: ActorSchema,
  type: LogEventTypeSchema,
  title: z.string(),               // short, deterministic, written by code (never by the LLM)
  data: z.record(z.string(), z.unknown()).optional(), // txid, invoice, condition id, amounts...
  explain: z.boolean(),            // should the AI add a plain-language explanation?
  explanation: z.string().optional(), // filled in (streamed) by the AI afterwards
  explanationSource: ExplanationSourceSchema.optional(),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

export const WsMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), escrow: EscrowSchema, events: z.array(LogEventSchema) }),
  z.object({ kind: z.literal('escrow'), escrow: EscrowSchema }),
  z.object({ kind: z.literal('event'), event: LogEventSchema }),
  z.object({ kind: z.literal('explanation_delta'), eventId: z.string(), text: z.string() }),
  z.object({ kind: z.literal('explanation_done'), eventId: z.string(), text: z.string(), source: ExplanationSourceSchema }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;
