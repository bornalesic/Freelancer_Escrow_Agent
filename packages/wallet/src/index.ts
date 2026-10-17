export { createWallet, mockLedgerHandle } from './factory.ts'
export type { CreateWalletParams, WalletMode } from './factory.ts'

export { MockWallet, WalletError, WalletTimeoutError, formatMockInvoice, parseMockInvoice } from './mock-wallet.ts'
export type { MockWalletOptions } from './mock-wallet.ts'

export { MOCK_RAW_STATUS, resolveLedgerPath } from './ledger.ts'
export type { Ledger, LedgerHandle, LedgerSeed, LedgerTransfer } from './ledger.ts'

// Re-exported so consumers can type against the wallet without reaching into this package's
// internals. These come from `@escrow/shared` once WS3 lands it -- see src/contract-types.ts.
export type {
  AssetBalance,
  EscrowWallet,
  Role,
  TransferStatus,
  TransferSummary,
  WalletInfo,
} from './contract-types.ts'
