// createWallet({ role, mode }) -- the entry point apps/agent and apps/party use.
//
// WS3 depends on this exact name and signature: the agent drops its own in-process mock and switches
// to this package as soon as `@escrow/wallet` exports it. Do not rename or reshape it without a
// contract-change.
//
// Config comes only from env vars listed in .env.example (root CLAUDE.md). Nothing here logs a
// mnemonic, and nothing here hard-codes a host, port, network or asset id.

import { join } from 'node:path'

import type { EscrowWallet, Role, WalletMode } from './contract-types.ts'
import { MockWallet, WalletError } from './mock-wallet.ts'
import { resolveLedgerPath, type LedgerHandle, type LedgerSeed } from './ledger.ts'
import { resolveFromRepoRoot } from './paths.ts'

export interface CreateWalletParams {
  role: Role
  /** Defaults to WALLET_MODE from the environment, then 'mock'. */
  mode?: WalletMode
}

const DEFAULT_SETTLE_MS = 3_000
const DEFAULT_POLL_MS = 150
const DEFAULT_PRECISION = 6
const DEFAULT_TICKER = 'TUSDT'
/**
 * Obviously-fake asset id for mock mode, used when ESCROW_ASSET_ID is not set yet. Must equal
 * MOCK_ASSET_ID in apps/agent/src/config.ts: escrows carry the agent's id, so any other value here
 * seeds the client's 100 under an asset the escrow never asks for.
 */
const DEFAULT_MOCK_ASSET_ID = 'mock-tusdt'
/** Mock wallets always have "enough" BTC for fees; the number is cosmetic. */
const DEFAULT_MOCK_BTC_SAT = '100000000'

function env(name: string): string | undefined {
  const raw = process.env[name]
  return raw === undefined || raw.trim() === '' ? undefined : raw.trim()
}

function requiredEnv(name: string): string {
  const value = env(name)
  if (value === undefined) throw new WalletError(`${name} is not set (see .env.example)`)
  return value
}

function intEnv(name: string, fallback: number): number {
  const raw = env(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) {
    throw new WalletError(`${name} must be a non-negative integer, got "${raw}"`)
  }
  return n
}

function resolveMode(explicit: WalletMode | undefined): WalletMode {
  const raw = explicit ?? env('WALLET_MODE') ?? 'mock'
  if (raw !== 'mock' && raw !== 'real') {
    throw new WalletError(`WALLET_MODE must be "mock" or "real", got "${raw}"`)
  }
  return raw
}

/**
 * Genesis state for the shared ledger. Only the first process to touch the file applies it, so every
 * process must compute the same seed -- which means the asset env vars have to match across the
 * agent and both party servers. CLAUDE.md: client starts with 100 tUSDT, everyone else with 0.
 */
function mockSeed(): LedgerSeed {
  const precision = intEnv('ESCROW_ASSET_PRECISION', DEFAULT_PRECISION)
  const unit = 10n ** BigInt(precision)
  return {
    asset: {
      assetId: env('ESCROW_ASSET_ID') ?? DEFAULT_MOCK_ASSET_ID,
      ticker: env('ESCROW_ASSET_TICKER') ?? DEFAULT_TICKER,
      precision,
    },
    balances: {
      client: (100n * unit).toString(),
      freelancer: '0',
      agent: '0',
    },
    btcSat: DEFAULT_MOCK_BTC_SAT,
  }
}

export function mockLedgerHandle(): LedgerHandle {
  return {
    path: resolveLedgerPath(env('MOCK_LEDGER_PATH')),
    seed: mockSeed(),
  }
}

/**
 * Build the wallet for a role. The mock comes back initialised (it seeds itself lazily, so forgetting
 * `init()` will not silently produce an empty ledger). The real wallet does NOT: its `init()` opens
 * the wallet and may create UTXOs, which can be slow or fail while the regtest stack is still coming
 * up, so callers run it themselves and retry (apps/party and apps/agent both do).
 */
export async function createWallet(p: CreateWalletParams): Promise<EscrowWallet> {
  const mode = resolveMode(p.mode)
  const network = env('RGB_NETWORK') ?? 'regtest'

  if (mode === 'mock') {
    // MOCK_FAIL_AMOUNT: paying exactly this many base units fails instead of settling, refunding the
    // sender. The deterministic way to rehearse the refund path with no code change.
    const failAmount = env('MOCK_FAIL_AMOUNT')
    if (failAmount !== undefined && !/^\d+$/.test(failAmount)) {
      throw new WalletError(
        `MOCK_FAIL_AMOUNT must be integer base units as a decimal string, got "${failAmount}"`,
      )
    }

    const wallet = new MockWallet({
      role: p.role,
      network,
      ledger: mockLedgerHandle(),
      settleMs: intEnv('MOCK_SETTLE_MS', DEFAULT_SETTLE_MS),
      pollMs: DEFAULT_POLL_MS,
      ...(failAmount === undefined ? {} : { failAmount }),
    })
    await wallet.init()
    return wallet
  }

  // Real mode never falls back to the mock: a demo that quietly runs on fake money is worse than one
  // that refuses to start.
  const mnemonicVar = `${p.role.toUpperCase()}_MNEMONIC`
  const mnemonic = env(mnemonicVar)
  if (mnemonic === undefined) {
    throw new WalletError(`${mnemonicVar} is not set: put the ${p.role} wallet's mnemonic in .env.local`)
  }

  // Lazy: loading this module loads the native rgb-lib, which needs Linux with glibc >= 2.38. A static
  // import would break mock mode everywhere else (Windows, Ubuntu 22.04).
  let RgbWdkWallet: typeof import('./rgb-wdk-wallet.ts').RgbWdkWallet
  try {
    ({ RgbWdkWallet } = await import('./rgb-wdk-wallet.ts'))
  } catch (err) {
    throw new WalletError(
      'WALLET_MODE=real needs the native RGB library, which did not load. It needs Linux with ' +
      `glibc >= 2.38 (Ubuntu 24.04, not 22.04): ${err instanceof Error ? err.message : String(err)}`,
    )
  }

  return new RgbWdkWallet({
    role: p.role,
    network,
    mnemonic,
    // One directory per role: never open the same dataDir from two processes.
    dataDir: resolveFromRepoRoot(join(env('RGB_DATA_DIR') ?? './.wallets', p.role)),
    indexerUrl: requiredEnv('RGB_INDEXER_URL'),
    transportEndpoint: requiredEnv('RGB_TRANSPORT_ENDPOINT'),
    feeRate: intEnv('FEE_RATE', 2),
    minConfirmations: intEnv('MIN_CONFIRMATIONS', 1),
    minFreeUtxos: intEnv('MIN_FREE_UTXOS', 5),
    maxFeeSat: intEnv('MAX_FEE_SAT', 5000),
    pollMs: intEnv('WALLET_POLL_MS', 2000),
  })
}
