// Cross-process JSON ledger for MockWallet.
//
// The agent and both party servers are separate processes on one laptop, so a mock "payment" made in
// one has to be visible in the others. They share a single JSON file (MOCK_LEDGER_PATH) guarded by an
// exclusive lockfile, and every read-modify-write goes through `withLedger`.
//
// Settlement is derived from a stored deadline rather than a timer: a pending transfer carries
// `settleAtMono`, and any process that opens the ledger promotes whatever is due. That way a transfer
// still settles even if the process that created it has exited, and no process needs a background
// interval. The deadline is on the MONOTONIC clock -- see src/clock.ts for why that matters here.

import { closeSync, openSync, mkdirSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { randomBytes } from 'node:crypto'

import { monotonicMs } from './clock.ts'
import type { Role, TransferStatus } from './contract-types.ts'

export const LEDGER_VERSION = 2

/** Raw status strings MockWallet reports, deliberately distinct from rgb-lib's. */
export const MOCK_RAW_STATUS = {
  pending: 'MockWaitingSettlement',
  settled: 'MockSettled',
  failed: 'MockFailed',
} as const satisfies Record<TransferStatus, string>

export interface LedgerInvoice {
  recipientId: string
  role: Role
  assetId: string
  amount: string
  createdAt: string
  /** Wall clock. Only compared coarsely (one hour), so clock skew is tolerable here. */
  expiresAt: string
  consumed: boolean
}

export interface LedgerTransfer {
  id: string
  from: Role | null
  to: Role | null
  assetId: string
  amount: string
  status: TransferStatus
  txid: string
  recipientId?: string
  /** Wall clock ISO, for display only. */
  createdAt: string
  /** Monotonic ms when the transfer was created. Lets us spot a ledger from a previous boot. */
  createdAtMono: number
  /** Monotonic ms at which a pending transfer resolves (to settled, or failed if `failOnSettle`). */
  settleAtMono: number
  /** When true, the transfer resolves to 'failed' instead of 'settled'. See MOCK_FAIL_AMOUNT. */
  failOnSettle?: boolean
  /** Set when status is 'failed'. */
  failureReason?: string
}

export interface LedgerAsset {
  assetId: string
  ticker: string
  precision: number
}

export interface Ledger {
  version: number
  asset: LedgerAsset
  /** role -> assetId -> settled base units, as a decimal string. */
  balances: Record<string, Record<string, string>>
  /** role -> BTC sats, as a decimal string. Mock wallets are always "funded" for fees. */
  btcSat: Record<string, string>
  invoices: Record<string, LedgerInvoice>
  transfers: LedgerTransfer[]
}

export interface LedgerSeed {
  asset: LedgerAsset
  /** Base units per role at genesis. CLAUDE.md: client 100 tUSDT, others 0. */
  balances: Record<string, string>
  btcSat: string
}

export function emptyLedger(seed: LedgerSeed): Ledger {
  const balances: Record<string, Record<string, string>> = {}
  const btcSat: Record<string, string> = {}
  for (const [role, amount] of Object.entries(seed.balances)) {
    balances[role] = { [seed.asset.assetId]: amount }
    btcSat[role] = seed.btcSat
  }
  return {
    version: LEDGER_VERSION,
    asset: seed.asset,
    balances,
    btcSat,
    invoices: {},
    transfers: [],
  }
}

// ------------------------------------------------------------------ locking

const LOCK_STALE_MS = 10_000
const LOCK_RETRY_MS = 15
const LOCK_TIMEOUT_MS = 5_000

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })

function lockPathFor(file: string) {
  return `${file}.lock`
}

async function acquireLock(file: string): Promise<() => void> {
  const lockPath = lockPathFor(file)
  const deadline = monotonicMs() + LOCK_TIMEOUT_MS

  for (;;) {
    try {
      // 'wx' fails if the file already exists -- that is the mutual exclusion.
      const fd = openSync(lockPath, 'wx')
      closeSync(fd)
      let released = false
      return () => {
        if (released) return
        released = true
        try { rmSync(lockPath, { force: true }) } catch { /* already gone */ }
      }
    } catch (err) {
      const code = (err as NodeJS.ErrnoException).code
      if (code !== 'EEXIST') throw err

      // Break a lock left behind by a process that died mid-write. mtime is wall clock, so this
      // comparison has to be too; a clock jump can only make us break a lock early, and the only
      // cost of that is a lost update in the (already abnormal) crashed-holder case.
      try {
        if (Date.now() - statSync(lockPath).mtimeMs > LOCK_STALE_MS) {
          rmSync(lockPath, { force: true })
          continue
        }
      } catch { /* vanished between EEXIST and stat; just retry */ }

      if (monotonicMs() > deadline) {
        throw new Error(
          `mock ledger lock at ${lockPath} is still held after ${LOCK_TIMEOUT_MS}ms. ` +
          'If no wallet process is running, delete that file.',
        )
      }
      await sleep(LOCK_RETRY_MS)
    }
  }
}

// ------------------------------------------------------------------ read / write

interface ReadResult {
  ledger: Ledger
  /** False when we had to fall back to the seed, which means the file must be written out. */
  existed: boolean
}

function readLedger(file: string, seed: LedgerSeed): ReadResult {
  let text: string
  try {
    text = readFileSync(file, 'utf8')
  } catch (err) {
    if ((err as NodeJS.ErrnoException).code === 'ENOENT') {
      return { ledger: emptyLedger(seed), existed: false }
    }
    throw err
  }
  if (text.trim() === '') return { ledger: emptyLedger(seed), existed: false }

  const parsed = JSON.parse(text) as Ledger
  if (parsed.version !== LEDGER_VERSION) {
    throw new Error(
      `mock ledger at ${file} has version ${String(parsed.version)}, expected ${LEDGER_VERSION}. ` +
      'Delete it (or run demo:reset) to start fresh.',
    )
  }
  return { ledger: parsed, existed: true }
}

function writeLedger(file: string, ledger: Ledger): void {
  mkdirSync(dirname(file), { recursive: true })
  // Write-then-rename so a reader never sees a half-written file.
  const tmp = `${file}.${process.pid.toString(36)}${randomBytes(3).toString('hex')}.tmp`
  writeFileSync(tmp, `${JSON.stringify(ledger, null, 2)}\n`, 'utf8')
  renameSync(tmp, file)
}

/**
 * Resolve every pending transfer whose deadline has passed: credit the recipient, or -- if the
 * transfer was marked to fail -- refund the sender. Called on every ledger open, so resolution does
 * not depend on which process is alive.
 */
function applyDueSettlements(ledger: Ledger, nowMono: number): void {
  for (const t of ledger.transfers) {
    if (t.status !== 'pending') continue

    // The monotonic origin resets on reboot, so a transfer that claims to have been created in the
    // "future" comes from a previous boot. It is certainly older than its few-second delay by now.
    const fromPreviousBoot = nowMono < t.createdAtMono
    if (!fromPreviousBoot && t.settleAtMono > nowMono) continue

    if (t.failOnSettle === true) {
      failTransferRow(ledger, t, t.failureReason ?? 'mock transfer configured to fail')
    } else {
      t.status = 'settled'
      if (t.to !== null) credit(ledger, t.to, t.assetId, t.amount)
    }
  }
}

/**
 * Mark a pending transfer failed and give the sender their money back.
 *
 * `pay()` debits the sender up front (mirroring how RGB drops spendable balance as soon as a
 * transfer is created), so a failure MUST return it -- otherwise the amount simply vanishes from the
 * ledger and the escrow can never be made whole. The recipient is never credited.
 */
export function failTransferRow(ledger: Ledger, t: LedgerTransfer, reason: string): void {
  if (t.status !== 'pending') {
    throw new Error(`cannot fail transfer ${t.id}: it is already ${t.status}`)
  }
  t.status = 'failed'
  t.failureReason = reason
  if (t.from !== null) credit(ledger, t.from, t.assetId, t.amount)
}

export function balanceOf(ledger: Ledger, role: string, assetId: string): bigint {
  return BigInt(ledger.balances[role]?.[assetId] ?? '0')
}

export function credit(ledger: Ledger, role: string, assetId: string, amount: string): void {
  const next = balanceOf(ledger, role, assetId) + BigInt(amount)
  const perRole = ledger.balances[role] ?? {}
  perRole[assetId] = next.toString()
  ledger.balances[role] = perRole
}

export function debit(ledger: Ledger, role: string, assetId: string, amount: string): void {
  const next = balanceOf(ledger, role, assetId) - BigInt(amount)
  if (next < 0n) throw new Error('debit would make the balance negative')
  const perRole = ledger.balances[role] ?? {}
  perRole[assetId] = next.toString()
  ledger.balances[role] = perRole
}

export interface LedgerHandle {
  path: string
  seed: LedgerSeed
}

/** Clocks handed to a `withLedger` body: `wall` for timestamps, `mono` for deadlines. */
export interface LedgerClock {
  wall: number
  mono: number
}

/**
 * Open the ledger under an exclusive lock, run `fn`, and persist if anything changed.
 * `fn` must be synchronous: holding the lock across an await is how deadlocks start.
 */
export async function withLedger<T>(
  handle: LedgerHandle,
  fn: (ledger: Ledger, clock: LedgerClock) => T,
): Promise<T> {
  const release = await acquireLock(handle.path)
  try {
    const { ledger, existed } = readLedger(handle.path, handle.seed)
    const clock: LedgerClock = { wall: Date.now(), mono: monotonicMs() }
    const before = JSON.stringify(ledger)
    applyDueSettlements(ledger, clock.mono)
    const result = fn(ledger, clock)
    // Always persist a ledger we had to seed ourselves, even if `fn` changed nothing: the first
    // `init()` must leave the file on disk for the other processes to find.
    if (!existed || JSON.stringify(ledger) !== before) writeLedger(handle.path, ledger)
    return result
  } finally {
    release()
  }
}

export function resolveLedgerPath(raw: string | undefined): string {
  // Default from CLAUDE.md: ../../.mock-ledger.json relative to packages/wallet, i.e. the repo root.
  return resolve(raw && raw.trim() !== '' ? raw : '.mock-ledger.json')
}
