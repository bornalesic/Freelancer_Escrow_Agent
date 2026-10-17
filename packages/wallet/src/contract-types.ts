// The wallet contract types, from `@escrow/shared` (docs/CONTRACTS.md section 3). Root CLAUDE.md rule 2
// forbids redefining them locally; the rest of this package imports them through this one file.

export type {
  AssetBalance,
  EscrowWallet,
  Role,
  TransferStatus,
  TransferSummary,
  WalletInfo,
  WalletMode,
} from '@escrow/shared'
