// Pure translation between what the RGB SDK returns at runtime and the EscrowWallet contract types.
//
// No WDK import here, so this module loads -- and is unit-tested -- anywhere; the native rgb-lib only
// loads on Linux with glibc >= 2.38. Every shape below was read off a live regtest run
// (~/scratch/wdk-probe/probe-shapes.mjs in Ubuntu-24.04), not off the package's .d.ts files, which are
// wrong in several places. See packages/wallet/CLAUDE.md, "From the shapes probe".

import type { AssetBalance, TransferStatus, TransferSummary } from './contract-types.ts'
import { WalletError } from './mock-wallet.ts'

/** `{ Fungible: n }` for our asset; other variants exist for non-fungible assets. */
export interface RgbAssignment {
  Fungible?: number
  [variant: string]: unknown
}

export interface RgbTransferRow {
  /** Unique per wallet. */
  idx: number
  batchTransferIdx: number
  /** Unix seconds. */
  createdAt: number
  /** A string at runtime ("WaitingCounterparty", ...); the .d.ts claims a numeric enum. */
  status: string | number
  /** A string at runtime ("ReceiveBlind", "Send", ...); the .d.ts claims a numeric enum. */
  kind: string | number
  requestedAssignment: RgbAssignment | null
  assignments: RgbAssignment[]
  txid: string | null
  recipientId: string | null
}

export interface RgbBalance {
  settled: number
  future: number
  spendable: number
}

export interface RgbAsset {
  assetId: string
  ticker?: string
  balance?: RgbBalance
}

export interface RgbUnspent {
  utxo: { colorable: boolean }
  rgbAllocations: unknown[]
  /** Open invoices reserving this UTXO. */
  pendingBlinded?: number
}

// The .d.ts enum order, in case a later SDK starts returning the numbers it declares.
const STATUS_NAMES = ['WaitingCounterparty', 'WaitingConfirmations', 'Settled', 'Failed'] as const
const KIND_NAMES = ['Issuance', 'ReceiveBlind', 'ReceiveWitness', 'Send', 'Inflation'] as const

const STATUS: Record<string, TransferStatus> = {
  WaitingCounterparty: 'pending',
  WaitingConfirmations: 'pending',
  Settled: 'settled',
  Failed: 'failed',
}

export const ZERO_BALANCE: RgbBalance = { settled: 0, future: 0, spendable: 0 }

export function statusName(status: string | number): string {
  return typeof status === 'number' ? STATUS_NAMES[status] ?? `Unknown(${status})` : status
}

export function kindName(kind: string | number): string {
  return typeof kind === 'number' ? KIND_NAMES[kind] ?? `Unknown(${kind})` : kind
}

function baseUnits(n: number, what: string): bigint {
  if (!Number.isSafeInteger(n) || n < 0) {
    throw new WalletError(`the RGB SDK reported ${what} that is not a safe non-negative integer: ${String(n)}`)
  }
  return BigInt(n)
}

function fungible(a: RgbAssignment | null): bigint {
  return a?.Fungible === undefined ? 0n : baseUnits(a.Fungible, 'an amount')
}

/**
 * Base units this row moved.
 * - Send: `requestedAssignment` is what was sent; `assignments` is the CHANGE, not the payment.
 * - Receive / issuance: `assignments` is what actually arrived. A recipient accepts and settles an
 *   underpayment, so this -- not the invoice's `requestedAssignment` -- is what the agent's "received
 *   less than expected" check has to see.
 */
export function transferAmount(row: RgbTransferRow): bigint {
  if (kindName(row.kind) === 'Send') return fungible(row.requestedAssignment)
  return row.assignments.reduce((sum, a) => sum + fungible(a), 0n)
}

/**
 * A receive row exists from the moment the invoice is created, before anyone pays (`txid: null`,
 * nothing assigned). That is an invoice, not a transfer: reporting it would make the agent log
 * "payment seen" before the client has paid. An unpaid invoice that expired looks the same (Failed).
 */
export function isOpenInvoice(row: RgbTransferRow): boolean {
  const kind = kindName(row.kind)
  return (kind === 'ReceiveBlind' || kind === 'ReceiveWitness') && row.txid === null && row.assignments.length === 0
}

export function toTransferSummary(row: RgbTransferRow, assetId: string): TransferSummary {
  const rawStatus = statusName(row.status)
  return {
    id: String(row.idx),
    direction: kindName(row.kind) === 'Send' ? 'outgoing' : 'incoming',
    assetId,
    amount: transferAmount(row).toString(),
    // Unknown status: never report it as settled, which could release money.
    status: STATUS[rawStatus] ?? 'pending',
    rawStatus,
    ...(row.txid === null ? {} : { txid: row.txid }),
    ...(row.recipientId === null ? {} : { recipientId: row.recipientId }),
    createdAt: new Date(row.createdAt * 1000).toISOString(),
  }
}

export function toAssetBalance(assetId: string, b: RgbBalance, ticker?: string): AssetBalance {
  return {
    assetId,
    ...(ticker === undefined ? {} : { ticker }),
    settled: baseUnits(b.settled, 'a balance').toString(),
    future: baseUnits(b.future, 'a balance').toString(),
    spendable: baseUnits(b.spendable, 'a balance').toString(),
  }
}

/** `listAssets()` returns `{ nia, uda, cfa, ifa }`; only the assets matter here, not their schema. */
export function flattenAssets(listed: Record<string, RgbAsset[] | null | undefined>): RgbAsset[] {
  return Object.values(listed).flatMap((group) => (Array.isArray(group) ? group : []))
}

/** Free = colorable, holding nothing, and not reserved by an open invoice (`pendingBlinded`). */
export function countFreeUtxos(unspents: RgbUnspent[]): number {
  return unspents.filter((u) => u.utxo.colorable && u.rgbAllocations.length === 0 && !u.pendingBlinded).length
}

/**
 * The SDK takes amounts as JS numbers -- a BigInt fails with "Do not know how to serialize a BigInt" --
 * so convert from the contract's decimal string, refusing anything a number cannot hold exactly.
 */
export function toSdkAmount(amount: string, what: string): number {
  if (!/^\d+$/.test(amount)) {
    throw new WalletError(`${what} must be integer base units as a decimal string, got "${amount}"`)
  }
  const n = Number(amount)
  if (!Number.isSafeInteger(n)) {
    throw new WalletError(`${what} ${amount} is more than the RGB SDK can take exactly (2^53 - 1 base units)`)
  }
  return n
}

const messageOf = (err: unknown) => (err instanceof Error ? err.message : String(err))

export const isAssetNotFound = (err: unknown) => /AssetNotFound/.test(messageOf(err))
export const isOutOfUtxos = (err: unknown) => /InsufficientAllocationSlots/.test(messageOf(err))

const CALLER_ERRORS: Array<[RegExp, string]> = [
  [/RecipientIDAlreadyUsed/, 'this invoice has already been paid'],
  [/InsufficientAssignments/, 'not enough of the asset is spendable (a payment still in flight locks the balance until it settles)'],
  [/InvalidInvoice|must be a valid RGB invoice/, 'not a valid RGB invoice'],
  [/AssetNotFound/, 'this wallet has never held that asset'],
  [/InsufficientAllocationSlots/, 'no free UTXO for a new invoice (each open invoice reserves one until it is paid or expires)'],
  [/InsufficientBitcoins/, 'not enough BTC for the fee'],
  [/Exceeded maximum fee/, 'the fee is above MAX_FEE_SAT'],
]

/**
 * An SDK error the caller can act on becomes a `WalletError` (the party server answers 400 with it),
 * keeping the rgb-lib text in brackets. Anything else -- indexer down, proxy unreachable -- is returned
 * unchanged: not the caller's fault.
 */
export function translateError(err: unknown): unknown {
  const raw = messageOf(err)
  const hit = CALLER_ERRORS.find(([pattern]) => pattern.test(raw))
  return hit === undefined ? err : new WalletError(`${hit[1]} [${raw.replace(/^RGB transfer failed: /, '')}]`)
}
