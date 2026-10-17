export { createWallet, mockLedgerHandle } from './factory.ts'
export type { CreateWalletParams } from './factory.ts'

export { MockWallet, WalletError, WalletTimeoutError, formatMockInvoice, parseMockInvoice } from './mock-wallet.ts'
export type { MockWalletOptions } from './mock-wallet.ts'

// Type only: a value export would load the native rgb-lib on import (see src/rgb-wdk-wallet.ts).
export type { RgbWdkWalletOptions } from './rgb-wdk-wallet.ts'

export { MOCK_RAW_STATUS, resolveLedgerPath } from './ledger.ts'
export type { Ledger, LedgerHandle, LedgerSeed, LedgerTransfer } from './ledger.ts'

// Re-exported so consumers can type against the wallet without reaching into this package's
// internals. They come from `@escrow/shared` -- see src/contract-types.ts.
export type {
  AssetBalance,
  EscrowWallet,
  Role,
  TransferStatus,
  TransferSummary,
  WalletInfo,
  WalletMode,
} from './contract-types.ts'
