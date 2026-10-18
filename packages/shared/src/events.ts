import { z } from 'zod';
import { EscrowSchema, IsoDateSchema } from './domain.ts';

export const ActorSchema = z.enum(['client', 'freelancer', 'agent', 'ai', 'verifier', 'wallet', 'system']);
export type Actor = z.infer<typeof ActorSchema>;

export const LOG_EVENT_TYPES = [
  'escrow.created', 'terms.proposed', 'terms.reparse_requested', 'terms.accepted', 'terms.agreed',
  'listing.published', // PROPOSED → OPEN: the client approved the requirements; the job is on the marketplace
  // Counteroffers on an OPEN listing (no state change). An accepted one is `terms.agreed` (OPEN → AGREED).
  'offer.made', 'offer.withdrawn', 'offer.declined', 'offer.expired',
  'funding.invoice_created', 'funding.payment_seen', 'funding.settled',
  'funding.reopened', // AWAITING_FUNDS → OPEN: not funded within the window, or the payment failed
  'delivery.received', 'verify.started', 'verify.condition_result', 'verify.finished',
  'decision.made',
  'review.report_ready', 'review.approved', 'review.disputed', 'review.expired',
  'payout.sent', 'payout.settled', 'refund.sent', 'refund.settled',
  'escrow.cancelled', 'error',
] as const;
export const LogEventTypeSchema = z.enum(LOG_EVENT_TYPES);
export type LogEventType = z.infer<typeof LogEventTypeSchema>;

export const ExplanationSourceSchema = z.enum(['ai', 'template']);
export type ExplanationSource = z.infer<typeof ExplanationSourceSchema>;

export const LogEventSchema = z.object({
  id: z.string(),                 // monotonic per escrow, e.g. "esc_7f3a:0007"
  escrowId: z.string(),
  at: IsoDateSchema,
  actor: ActorSchema,
  type: LogEventTypeSchema,
  title: z.string(),              // short, deterministic, written by code (never by the LLM)
  data: z.record(z.string(), z.unknown()).optional(),
  explain: z.boolean(),           // should the AI add a plain-language explanation?
  explanation: z.string().optional(),
  explanationSource: ExplanationSourceSchema.optional(),
});
export type LogEvent = z.infer<typeof LogEventSchema>;

/** Messages from the agent on `ws://<agent>:4000/ws?escrowId=<id>` (omit escrowId for all). */
export const WsMessageSchema = z.discriminatedUnion('kind', [
  z.object({ kind: z.literal('snapshot'), escrow: EscrowSchema, events: z.array(LogEventSchema) }),
  z.object({ kind: z.literal('escrow'), escrow: EscrowSchema }),
  z.object({ kind: z.literal('event'), event: LogEventSchema }),
  z.object({ kind: z.literal('explanation_delta'), eventId: z.string(), text: z.string() }),
  z.object({
    kind: z.literal('explanation_done'),
    eventId: z.string(),
    text: z.string(),
    source: ExplanationSourceSchema,
  }),
]);
export type WsMessage = z.infer<typeof WsMessageSchema>;
