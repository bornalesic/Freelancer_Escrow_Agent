import { z } from 'zod';

/** Integer base units carried as a decimal string (bigint-safe). */
export const AmountSchema = z.string().regex(/^\d+$/, 'must be an integer amount in base units');
export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'must be 64 lowercase hex chars');
export const IsoDateSchema = z.iso.datetime({ offset: true });

export const RoleSchema = z.enum(['client', 'freelancer', 'agent']);
export type Role = z.infer<typeof RoleSchema>;

export const PartyRoleSchema = z.enum(['client', 'freelancer']);
export type PartyRole = z.infer<typeof PartyRoleSchema>;

export const EscrowStateSchema = z.enum([
  'DRAFT', 'PROPOSED', 'AGREED', 'AWAITING_FUNDS', 'FUNDED',
  'DELIVERED', 'VERIFYING', 'AWAITING_APPROVAL', 'RELEASING', 'RELEASED',
  'REFUNDING', 'REFUNDED', 'CANCELLED',
]);
export type EscrowState = z.infer<typeof EscrowStateSchema>;

export const TERMINAL_STATES: readonly EscrowState[] = ['RELEASED', 'REFUNDED', 'CANCELLED'];

const conditionBase = {
  id: z.string().min(1),          // "c1", "c2", ...
  description: z.string().min(1), // human sentence shown in the UI
};

export const TestsPassConditionSchema = z.object({
  ...conditionBase,
  kind: z.literal('tests_pass'),
  command: z.string().min(1),                       // e.g. "npm test", run in the unpacked deliverable
  timeoutSec: z.number().int().positive().max(600), // default 60
});

export const FileHashConditionSchema = z.object({
  ...conditionBase,
  kind: z.literal('file_hash'),
  fileName: z.string().min(1).optional(),           // file inside the deliverable; whole upload if absent
  sha256: Sha256HexSchema,
});

export const FilePresentConditionSchema = z.object({
  ...conditionBase,
  kind: z.literal('file_present'),
  pathPattern: z.string().min(1),                   // glob inside the unpacked deliverable
});

/** A criterion only a person can judge. QVAC writes an advisory review; the client approves or disputes. */
export const ClientReviewConditionSchema = z.object({
  ...conditionBase,
  kind: z.literal('client_review'), // description = what the client judges, e.g. "The logo uses warm colours"
});

/**
 * An acceptance condition. Discriminated on `kind`. The verifier checks `tests_pass`, `file_hash` and
 * `file_present` automatically; `client_review` is judged by the client, after QVAC writes an advisory report.
 */
export const ConditionSchema = z.discriminatedUnion('kind', [
  TestsPassConditionSchema,
  FileHashConditionSchema,
  FilePresentConditionSchema,
  ClientReviewConditionSchema,
]);
export type Condition = z.infer<typeof ConditionSchema>;
export type ConditionKind = Condition['kind'];
export const CONDITION_KINDS = ['tests_pass', 'file_hash', 'file_present', 'client_review'] as const satisfies readonly ConditionKind[];

export type AutomaticCondition = Exclude<Condition, { kind: 'client_review' }>;
export type ClientReviewCondition = Extract<Condition, { kind: 'client_review' }>;

/** True for conditions the verifier checks (everything except `client_review`). */
export const isAutomaticCondition = (c: Condition): c is AutomaticCondition => c.kind !== 'client_review';

export const AcceptanceSchema = z.object({
  role: PartyRoleSchema,
  termsHash: Sha256HexSchema,
  at: IsoDateSchema,
  signature: z.string().optional(), // optional BIP-322 signature over termsHash
  address: z.string().optional(),   // signer's address, if signed
});
export type Acceptance = z.infer<typeof AcceptanceSchema>;

/** One per automatic condition. `client_review` conditions never get a VerificationResult. */
export const VerificationResultSchema = z.object({
  conditionId: z.string(),
  passed: z.boolean(),
  evidence: z.object({
    exitCode: z.number().int().optional(),
    stdoutTail: z.string().optional(),     // last ~40 lines
    actualSha256: z.string().optional(),
    matched: z.array(z.string()).optional(), // for file_present
    durationMs: z.number().nonnegative(),
    error: z.string().optional(),          // infrastructure error (timeout, unzip failed...)
  }),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

/** The client's answer to a delivery in AWAITING_APPROVAL. */
export const ApprovalSchema = z.object({
  decision: z.enum(['approve', 'dispute']),
  at: IsoDateSchema,
  reason: z.string().optional(), // required for 'dispute'; shown to the freelancer
});
export type Approval = z.infer<typeof ApprovalSchema>;

export const ReviewOpinionSchema = z.enum(['looks_met', 'looks_unmet', 'unsure']);
export type ReviewOpinion = z.infer<typeof ReviewOpinionSchema>;

/** QVAC's opinion on each client_review condition. Shown to people, never read by decide(). */
export const AiReviewSchema = z.object({
  items: z.array(
    z.object({
      conditionId: z.string(), // a client_review condition id
      opinion: ReviewOpinionSchema,
      note: z.string(),        // 1–2 sentences; may only mention files that exist in the delivery
    }),
  ),
  source: z.enum(['ai', 'template']), // 'template' = AI unavailable, every item 'unsure'
  model: z.string().optional(),
  ms: z.number().nonnegative(),
});
export type AiReview = z.infer<typeof AiReviewSchema>;

export const DeliverySchema = z.object({
  n: z.number().int().positive(), // 1, 2, 3...
  fileName: z.string(),
  sha256: Sha256HexSchema,
  sizeBytes: z.number().int().nonnegative(),
  at: IsoDateSchema,
  results: z.array(VerificationResultSchema).optional(), // one per automatic condition
  reviewDueAt: IsoDateSchema.optional(), // set on entering AWAITING_APPROVAL: now + REVIEW_WINDOW_SEC
  review: AiReviewSchema.optional(),     // QVAC's advisory report on the client_review conditions (display only)
  approval: ApprovalSchema.optional(),   // the client's answer for this delivery
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const EscrowSchema = z.object({
  id: z.string(),                 // short id, e.g. "esc_7f3a"
  title: z.string(),
  rawText: z.string(),            // the original plain-language agreement
  amount: AmountSchema,           // base units
  assetId: z.string(),            // RGB asset id (never a ticker)
  assetTicker: z.string(),        // display only
  precision: z.number().int().nonnegative(), // display only
  deadline: IsoDateSchema,
  state: EscrowStateSchema,
  summary: z.string().optional(),
  clarifications: z.array(z.string()).optional(),
  conditions: z.array(ConditionSchema),
  termsHash: Sha256HexSchema.optional(),
  acceptances: z.array(AcceptanceSchema),
  fundingInvoice: z.string().optional(), // agent's receive invoice
  refundInvoice: z.string().optional(),  // client's receive invoice
  payoutInvoice: z.string().optional(),  // freelancer's receive invoice (latest delivery)
  deliveries: z.array(DeliverySchema),
  createdAt: IsoDateSchema,
  updatedAt: IsoDateSchema,
});
export type Escrow = z.infer<typeof EscrowSchema>;

export const DecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('release'), reason: z.string() }),
  z.object({ action: z.literal('retry'), reason: z.string(), failed: z.array(z.string()) }),
  z.object({ action: z.literal('refund'), reason: z.string() }),
  z.object({ action: z.literal('await_approval'), reason: z.string(), pending: z.array(z.string()) }), // client_review ids
  z.object({ action: z.literal('wait'), reason: z.string() }),
]);
export type Decision = z.infer<typeof DecisionSchema>;
