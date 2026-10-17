import { z } from 'zod';
import { AmountSchema, RoleSchema } from './domain.ts';

export const WalletInfoSchema = z.object({
  role: RoleSchema,
  network: z.string(),
  address: z.string(),        // BTC deposit address (for fees)
  btcBalanceSat: AmountSchema,
});
export type WalletInfo = z.infer<typeof WalletInfoSchema>;

export const AssetBalanceSchema = z.object({
  assetId: z.string(),
  ticker: z.string().optional(),
  settled: AmountSchema,
  future: AmountSchema,
  spendable: AmountSchema,
});
export type AssetBalance = z.infer<typeof AssetBalanceSchema>;

export const TransferStatusSchema = z.enum(['pending', 'settled', 'failed']);
export type TransferStatus = z.infer<typeof TransferStatusSchema>;

export const TransferSummarySchema = z.object({
  id: z.string(),
  direction: z.enum(['incoming', 'outgoing']),
  assetId: z.string(),
  amount: AmountSchema,
  status: TransferStatusSchema,
  rawStatus: z.string(),        // whatever rgb-lib reports, for debugging
  txid: z.string().optional(),
  recipientId: z.string().optional(), // lets the agent match an incoming transfer to its invoice
  createdAt: z.string().optional(),
});
export type TransferSummary = z.infer<typeof TransferSummarySchema>;

/** Implemented by `@escrow/wallet` (RgbWdkWallet + MockWallet). */
export interface EscrowWallet {
  init(): Promise<void>;                                   // open/create wallet, ensure UTXOs exist
  info(): Promise<WalletInfo>;
  balance(assetId: string): Promise<AssetBalance>;
  listAssets(): Promise<AssetBalance[]>;
  createInvoice(p: { assetId: string; amount: string }): Promise<{ invoice: string; recipientId: string; expiresAt?: string }>;
  pay(p: { invoice: string; assetId: string; amount: string }): Promise<{ txid: string }>;
  refresh(): Promise<void>;
  transfers(assetId: string): Promise<TransferSummary[]>;
  waitForTransfer(p: { assetId: string; recipientId?: string; txid?: string; timeoutMs: number }): Promise<TransferSummary>;
  sign?(message: string): Promise<{ signature: string; address: string }>;
}
