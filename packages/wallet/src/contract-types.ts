// ---------------------------------------------------------------------------------------------
// TEMPORARY MIRROR of `docs/CONTRACTS.md` section 3 (the spec for `@escrow/shared/src/wallet.ts`).
//
// `packages/shared` does not exist yet, and the root CLAUDE.md forbids redefining contract types
// locally once it does. So this file is deliberately the ONLY place in `packages/wallet` that
// declares contract types, and it is written to be deleted: when WS3 lands `@escrow/shared`,
// replace the whole body with
//
//     export type {
//       Role, WalletInfo, AssetBalance, TransferStatus, TransferSummary, EscrowWallet,
//     } from '@escrow/shared'
//
// and nothing else in this package has to change. Do not add anything here that is not a
// transcription of CONTRACTS.md — package-local types belong in their own module.
// ---------------------------------------------------------------------------------------------

/** CONTRACTS.md section 1. */
export type Role = 'client' | 'freelancer' | 'agent'

export interface WalletInfo {
  role: Role
  network: string
  /** BTC deposit address (for fees). */
  address: string
  btcBalanceSat: string
}

export interface AssetBalance {
  assetId: string
  ticker?: string
  settled: string
  future: string
  spendable: string
}

export type TransferStatus = 'pending' | 'settled' | 'failed'

export interface TransferSummary {
  id: string
  direction: 'incoming' | 'outgoing'
  assetId: string
  amount: string
  status: TransferStatus
  /** Whatever rgb-lib reports, for debugging. */
  rawStatus: string
  txid?: string
  /** Lets the agent match an incoming transfer to its invoice. */
  recipientId?: string
  createdAt?: string
}

export interface EscrowWallet {
  /** Open/create wallet, ensure UTXOs exist. */
  init(): Promise<void>
  info(): Promise<WalletInfo>
  balance(assetId: string): Promise<AssetBalance>
  listAssets(): Promise<AssetBalance[]>
  createInvoice(p: { assetId: string; amount: string }): Promise<{
    invoice: string
    recipientId: string
    expiresAt?: string
  }>
  pay(p: { invoice: string; assetId: string; amount: string }): Promise<{ txid: string }>
  refresh(): Promise<void>
  transfers(assetId: string): Promise<TransferSummary[]>
  waitForTransfer(p: {
    assetId: string
    recipientId?: string
    txid?: string
    timeoutMs: number
  }): Promise<TransferSummary>
  sign?(message: string): Promise<{ signature: string; address: string }>
}
