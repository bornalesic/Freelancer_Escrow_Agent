import { z } from 'zod';
import { AmountSchema, EscrowSchema, IsoDateSchema, PartyRoleSchema, Sha256HexSchema } from './domain.ts';
import { DeliveryFileSchema } from './ai.ts';
import { LogEventSchema } from './events.ts';
import { AssetBalanceSchema, WalletInfoSchema } from './wallet.ts';

// ---- Route constants ---------------------------------------------------------
// Path builders double as route patterns: AGENT_ROUTES.accept(':id') === '/escrows/:id/accept'.

export const AGENT_ROUTES = {
  health: '/health',
  config: '/config',
  wallet: '/wallet',
  escrows: '/escrows',
  escrow: (id: string) => `/escrows/${id}`,
  reparse: (id: string) => `/escrows/${id}/reparse`,
  accept: (id: string) => `/escrows/${id}/accept`,
  cancel: (id: string) => `/escrows/${id}/cancel`,
  refundInvoice: (id: string) => `/escrows/${id}/refund-invoice`,
  funded: (id: string) => `/escrows/${id}/funded`,
  deliveries: (id: string) => `/escrows/${id}/deliveries`,
  deliveryFiles: (id: string, n: number | string) => `/escrows/${id}/deliveries/${n}/files`,
  /** One raw file of a delivery; `filePath` segments are URL-encoded. `deliveryFile(':id', ':n', '*')` is the route pattern. */
  deliveryFile: (id: string, n: number | string, filePath: string) =>
    `/escrows/${id}/deliveries/${n}/files/${filePath.split('/').map(encodeURIComponent).join('/')}`,
  approve: (id: string) => `/escrows/${id}/approve`,
  retryStep: (id: string) => `/escrows/${id}/retry-step`,
  devMine: '/dev/mine',
  devReset: '/dev/reset',
  ws: '/ws',
} as const;

export const AI_ROUTES = {
  health: '/health',
  parse: '/parse',
  explain: '/explain',
  explainSync: '/explain/sync',
  review: '/review',
} as const;

export const PARTY_ROUTES = {
  health: '/health',
  wallet: '/wallet',
  walletInvoice: '/wallet/invoice',
  walletPay: '/wallet/pay',
  walletRefresh: '/wallet/refresh',
  walletTransfers: '/wallet/transfers', // ?assetId=
  walletSign: '/wallet/sign',
} as const;

// ---- Common ------------------------------------------------------------------

export const ErrorResponseSchema = z.object({
  error: z.string(),
  details: z.unknown().optional(),
});
export type ErrorResponse = z.infer<typeof ErrorResponseSchema>;

export const WalletModeSchema = z.enum(['mock', 'real']);
export type WalletMode = z.infer<typeof WalletModeSchema>;

// ---- Agent server ------------------------------------------------------------

export const AgentHealthResponseSchema = z.object({
  ok: z.boolean(),
  walletMode: WalletModeSchema,
  aiUp: z.boolean(),
  aiModel: z.string().optional(), // model name reported by apps/ai /health, when it is up
  network: z.string(),
  error: z.string().optional(), // why ok is false (e.g. wallet init failed)
});
export type AgentHealthResponse = z.infer<typeof AgentHealthResponseSchema>;

export const ConfigResponseSchema = z.object({
  assetId: z.string(),
  assetTicker: z.string(),
  precision: z.number().int().nonnegative(),
  network: z.string(),
});
export type ConfigResponse = z.infer<typeof ConfigResponseSchema>;

export const CreateEscrowRequestSchema = z.object({
  title: z.string().trim().min(1).max(200),
  rawText: z.string().trim().min(1).max(10_000),
  amount: AmountSchema.refine((a) => /^\d+$/.test(a) && BigInt(a) > 0n, 'must be greater than zero'),
  deadline: IsoDateSchema,
});
export type CreateEscrowRequest = z.infer<typeof CreateEscrowRequestSchema>;

/**
 * `POST /escrows` response: the escrow plus the one-time `clientToken` the client UI must keep to approve
 * or dispute. `clientToken` is never part of `EscrowSchema`: escrows are broadcast to everyone.
 */
export const CreateEscrowResponseSchema = EscrowSchema.extend({ clientToken: z.string().regex(/^[0-9a-f]{64}$/) });
export type CreateEscrowResponse = z.infer<typeof CreateEscrowResponseSchema>;

export const EscrowDetailResponseSchema = z.object({
  escrow: EscrowSchema,
  events: z.array(LogEventSchema),
});
export type EscrowDetailResponse = z.infer<typeof EscrowDetailResponseSchema>;

export const ReparseRequestSchema = z.object({
  rawText: z.string().trim().min(1).max(10_000).optional(),
});
export type ReparseRequest = z.infer<typeof ReparseRequestSchema>;

export const AcceptRequestSchema = z.object({
  role: PartyRoleSchema,
  termsHash: Sha256HexSchema,
  signature: z.string().optional(),
  address: z.string().optional(),
});
export type AcceptRequest = z.infer<typeof AcceptRequestSchema>;

export const CancelRequestSchema = z.object({ role: PartyRoleSchema });
export type CancelRequest = z.infer<typeof CancelRequestSchema>;

export const RefundInvoiceRequestSchema = z.object({ invoice: z.string().trim().min(1).max(4096) });
export type RefundInvoiceRequest = z.infer<typeof RefundInvoiceRequestSchema>;

export const FundedRequestSchema = z.object({ txid: z.string().trim().min(1).max(200) });
export type FundedRequest = z.infer<typeof FundedRequestSchema>;

/** Text fields of the multipart `POST /escrows/:id/deliveries` (plus the `file` part). */
export const DeliveryFieldsSchema = z.object({ payoutInvoice: z.string().trim().min(1).max(4096) });
export type DeliveryFields = z.infer<typeof DeliveryFieldsSchema>;

export const ApproveRequestSchema = z
  .object({
    deliveryN: z.number().int().positive(),
    decision: z.enum(['approve', 'dispute']),
    reason: z.string().trim().max(2000).optional(),
    clientToken: z.string().min(1).max(200),
  })
  .refine((b) => b.decision !== 'dispute' || Boolean(b.reason), {
    message: 'A dispute needs a reason',
    path: ['reason'],
  });
export type ApproveRequest = z.infer<typeof ApproveRequestSchema>;

/** `GET /escrows/:id/deliveries/:n/files`. */
export const DeliveryFilesResponseSchema = z.array(DeliveryFileSchema);
export type DeliveryFilesResponse = z.infer<typeof DeliveryFilesResponseSchema>;

export const RetryStepRequestSchema = z.object({
  /** Re-send a payout/refund whose outcome is unknown after a crash. Check the wallet first. */
  force: z.boolean().optional(),
});
export type RetryStepRequest = z.infer<typeof RetryStepRequestSchema>;

export const DevMineRequestSchema = z.object({ blocks: z.number().int().min(1).max(200).optional() });
export type DevMineRequest = z.infer<typeof DevMineRequestSchema>;

export const DevMineResponseSchema = z.object({ height: z.number().int() });
export type DevMineResponse = z.infer<typeof DevMineResponseSchema>;

/** `GET /wallet` on the agent and on party servers. */
export const WalletResponseSchema = WalletInfoSchema.extend({ assets: z.array(AssetBalanceSchema) });
export type WalletResponse = z.infer<typeof WalletResponseSchema>;

// ---- Party server ------------------------------------------------------------

export const PartyHealthResponseSchema = z.object({
  ok: z.boolean(),
  role: PartyRoleSchema,
  walletMode: WalletModeSchema,
  error: z.string().optional(),
});
export type PartyHealthResponse = z.infer<typeof PartyHealthResponseSchema>;

export const InvoiceRequestSchema = z.object({ assetId: z.string().min(1), amount: AmountSchema });
export type InvoiceRequest = z.infer<typeof InvoiceRequestSchema>;

export const InvoiceResponseSchema = z.object({
  invoice: z.string(),
  recipientId: z.string(),
  expiresAt: z.string().optional(),
});
export type InvoiceResponse = z.infer<typeof InvoiceResponseSchema>;

export const PayRequestSchema = z.object({ invoice: z.string().min(1), assetId: z.string().min(1), amount: AmountSchema });
export type PayRequest = z.infer<typeof PayRequestSchema>;

export const PayResponseSchema = z.object({ txid: z.string() });
export type PayResponse = z.infer<typeof PayResponseSchema>;

export const SignRequestSchema = z.object({ message: z.string().min(1) });
export type SignRequest = z.infer<typeof SignRequestSchema>;

export const SignResponseSchema = z.object({ signature: z.string(), address: z.string() });
export type SignResponse = z.infer<typeof SignResponseSchema>;
