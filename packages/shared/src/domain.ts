import { z } from 'zod';

// 1:1 translation of docs/CONTRACTS.md §1. Types are derived from the schemas so they cannot drift.

export const RoleSchema = z.enum(['client', 'freelancer', 'agent']);
export type Role = z.infer<typeof RoleSchema>;

export const EscrowStateSchema = z.enum([
  'DRAFT', 'PROPOSED', 'AGREED', 'AWAITING_FUNDS', 'FUNDED',
  'DELIVERED', 'VERIFYING', 'RELEASING', 'RELEASED',
  'REFUNDING', 'REFUNDED', 'CANCELLED',
]);
export type EscrowState = z.infer<typeof EscrowStateSchema>;

/** Base-unit integer amount as a decimal string. */
export const AmountSchema = z.string().regex(/^\d+$/, 'amount must be a base-unit integer string');

export const Sha256HexSchema = z.string().regex(/^[0-9a-f]{64}$/, 'sha256 must be 64 lowercase hex chars');

export const TestsPassConditionSchema = z.object({
  id: z.string(),
  kind: z.literal('tests_pass'),
  description: z.string().min(1),   // human sentence shown in the UI
  command: z.string().min(1),       // e.g. "npm test" — run in the unpacked deliverable
  timeoutSec: z.number().int().positive(), // default 60
});

export const FileHashConditionSchema = z.object({
  id: z.string(),
  kind: z.literal('file_hash'),
  description: z.string().min(1),
  fileName: z.string().min(1).optional(), // which file inside the deliverable; whole upload if absent
  sha256: Sha256HexSchema,
});

export const FilePresentConditionSchema = z.object({
  id: z.string(),
  kind: z.literal('file_present'),
  description: z.string().min(1),
  pathPattern: z.string().min(1),   // glob inside the unpacked deliverable, e.g. "README.md"
});

/** A machine-checkable acceptance condition. Discriminated on `kind`. */
export const ConditionSchema = z.discriminatedUnion('kind', [
  TestsPassConditionSchema,
  FileHashConditionSchema,
  FilePresentConditionSchema,
]);
export type Condition = z.infer<typeof ConditionSchema>;
export type ConditionKind = Condition['kind'];
export const CONDITION_KINDS = ['tests_pass', 'file_hash', 'file_present'] as const satisfies readonly ConditionKind[];

export const AcceptanceSchema = z.object({
  role: z.enum(['client', 'freelancer']),
  termsHash: z.string(),
  at: z.string(),
  signature: z.string().optional(), // optional BIP-322 signature over termsHash
  address: z.string().optional(),   // signer's address, if signed
});
export type Acceptance = z.infer<typeof AcceptanceSchema>;

export const VerificationResultSchema = z.object({
  conditionId: z.string(),
  passed: z.boolean(),
  evidence: z.object({
    exitCode: z.number().int().optional(),
    stdoutTail: z.string().optional(),   // last ~40 lines
    actualSha256: z.string().optional(),
    matched: z.array(z.string()).optional(), // for file_present
    durationMs: z.number(),
    error: z.string().optional(),        // infrastructure error (timeout, unzip failed...)
  }),
});
export type VerificationResult = z.infer<typeof VerificationResultSchema>;

export const DeliverySchema = z.object({
  n: z.number().int().positive(),  // 1, 2, 3...
  fileName: z.string(),
  sha256: z.string(),
  sizeBytes: z.number().int().nonnegative(),
  at: z.string(),
  results: z.array(VerificationResultSchema).optional(),
});
export type Delivery = z.infer<typeof DeliverySchema>;

export const EscrowSchema = z.object({
  id: z.string(),                  // short id, e.g. "esc_7f3a"
  title: z.string(),
  rawText: z.string(),             // the original plain-language agreement
  amount: AmountSchema,            // base units
  assetId: z.string(),             // RGB asset id (never a ticker)
  assetTicker: z.string(),         // display only, e.g. "tUSDT"
  precision: z.number().int().nonnegative(), // display only, e.g. 6
  deadline: z.string(),
  state: EscrowStateSchema,
  summary: z.string().optional(),  // AI one-paragraph summary of the terms
  clarifications: z.array(z.string()).optional(), // things the AI could not turn into checks
  conditions: z.array(ConditionSchema),
  termsHash: z.string().optional(),
  acceptances: z.array(AcceptanceSchema),
  fundingInvoice: z.string().optional(), // agent's receive invoice
  refundInvoice: z.string().optional(),  // client's receive invoice
  payoutInvoice: z.string().optional(),  // freelancer's receive invoice (latest delivery)
  deliveries: z.array(DeliverySchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
export type Escrow = z.infer<typeof EscrowSchema>;

export const DecisionSchema = z.discriminatedUnion('action', [
  z.object({ action: z.literal('release'), reason: z.string() }),
  z.object({ action: z.literal('retry'), reason: z.string(), failed: z.array(z.string()) }),
  z.object({ action: z.literal('refund'), reason: z.string() }),
  z.object({ action: z.literal('wait'), reason: z.string() }),
]);
export type Decision = z.infer<typeof DecisionSchema>;
