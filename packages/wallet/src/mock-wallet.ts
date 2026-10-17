// MockWallet: the demo fallback and the implementation every other workstream builds against.
//
// Rule 3 in the root CLAUDE.md: this must keep working after RgbWdkWallet lands. It therefore mimics
// the shape of real RGB behaviour rather than being a trivial stub -- invoices are single-use and
// expire, a payment debits the sender immediately but only credits the recipient once the transfer
// settles, and the status goes pending -> settled with a delay.

import { createHash, randomBytes } from 'node:crypto'

import type {
  AssetBalance,
  EscrowWallet,
  Role,
  TransferSummary,
  WalletInfo,
} from './contract-types.ts'
import { monotonicMs } from './clock.ts'
import {
  MOCK_RAW_STATUS,
  balanceOf,
  debit,
  failTransferRow,
  withLedger,
  type Ledger,
  type LedgerHandle,
  type LedgerTransfer,
} from './ledger.ts'

/** Thrown by `waitForTransfer` when the timeout elapses. Carries the last state we saw. */
export class WalletTimeoutError extends Error {
  readonly lastKnown: TransferSummary | undefined
  constructor(message: string, lastKnown?: TransferSummary) {
    super(message)
    this.name = 'WalletTimeoutError'
    this.lastKnown = lastKnown
  }
}

/** Thrown for anything the caller got wrong: bad invoice, wrong amount, not enough funds. */
export class WalletError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'WalletError'
  }
}

export interface MockWalletOptions {
  role: Role
  network: string
  ledger: LedgerHandle
  settleMs: number
  /** How often `waitForTransfer` re-reads the ledger. */
  pollMs: number
  /**
   * Base-unit amount that always fails instead of settling (MOCK_FAIL_AMOUNT). Lets the demo and
   * WS3's tests drive the refund path deterministically, without a code change: pay exactly this
   * amount and the transfer goes pending -> failed, refunding the sender.
   */
  failAmount?: string
}

const INVOICE_PREFIX = 'mock:'
const INVOICE_TTL_MS = 60 * 60 * 1000

interface ParsedInvoice {
  recipientId: string
  assetId: string
  amount: string
}

/**
 * Invoice format from CLAUDE.md: `mock:<recipientId>:<assetId>:<amount>`.
 *
 * An RGB asset id contains a colon of its own ("rgb:ZmMRjCzR-..."), so this cannot be a naive split.
 * recipientId is read from the left (it never contains a colon) and amount from the right (digits
 * only); whatever is between them is the asset id, colons included.
 */
export function parseMockInvoice(invoice: string): ParsedInvoice {
  if (!invoice.startsWith(INVOICE_PREFIX)) {
    throw new WalletError(`not a mock invoice: ${invoice}`)
  }
  const rest = invoice.slice(INVOICE_PREFIX.length)

  const firstColon = rest.indexOf(':')
  const lastColon = rest.lastIndexOf(':')
  if (firstColon < 0 || lastColon <= firstColon) {
    throw new WalletError(`malformed mock invoice: ${invoice}`)
  }

  const recipientId = rest.slice(0, firstColon)
  const assetId = rest.slice(firstColon + 1, lastColon)
  const amount = rest.slice(lastColon + 1)

  if (recipientId === '' || assetId === '' || !/^\d+$/.test(amount)) {
    throw new WalletError(`malformed mock invoice: ${invoice}`)
  }
  return { recipientId, assetId, amount }
}

export function formatMockInvoice(p: ParsedInvoice): string {
  return `${INVOICE_PREFIX}${p.recipientId}:${p.assetId}:${p.amount}`
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })

function assertBaseUnits(amount: string, what: string): void {
  if (!/^\d+$/.test(amount)) {
    throw new WalletError(`${what} must be integer base units as a decimal string, got "${amount}"`)
  }
}

/** A stable, obviously-fake address so logs and the UI never mistake mock state for real state. */
function mockAddress(role: Role, network: string): string {
  const digest = createHash('sha256').update(`${network}:${role}`).digest('hex').slice(0, 24)
  return `mock1${role}${digest}`
}

export class MockWallet implements EscrowWallet {
  readonly #role: Role
  readonly #network: string
  readonly #ledger: LedgerHandle
  readonly #settleMs: number
  readonly #pollMs: number
  readonly #failAmount: bigint | null

  constructor(opts: MockWalletOptions) {
    this.#role = opts.role
    this.#network = opts.network
    this.#ledger = opts.ledger
    this.#settleMs = opts.settleMs
    this.#pollMs = opts.pollMs
    this.#failAmount = opts.failAmount === undefined ? null : BigInt(opts.failAmount)
  }

  get role(): Role {
    return this.#role
  }

  get ledgerPath(): string {
    return this.#ledger.path
  }

  /**
   * Create the ledger if this is the first process to start, and make sure this role has rows.
   * Seeding is driven by LedgerHandle.seed, so whichever process gets here first decides genesis.
   */
  async init(): Promise<void> {
    await withLedger(this.#ledger, (ledger) => {
      const assetId = ledger.asset.assetId
      if (ledger.balances[this.#role] === undefined) {
        ledger.balances[this.#role] = { [assetId]: this.#ledger.seed.balances[this.#role] ?? '0' }
      }
      if (ledger.btcSat[this.#role] === undefined) {
        ledger.btcSat[this.#role] = this.#ledger.seed.btcSat
      }
    })
  }

  async info(): Promise<WalletInfo> {
    const btcBalanceSat = await withLedger(this.#ledger, (ledger) => ledger.btcSat[this.#role] ?? '0')
    return {
      role: this.#role,
      network: this.#network,
      address: mockAddress(this.#role, this.#network),
      btcBalanceSat,
    }
  }

  async balance(assetId: string): Promise<AssetBalance> {
    return withLedger(this.#ledger, (ledger) => this.#balanceFrom(ledger, assetId))
  }

  async listAssets(): Promise<AssetBalance[]> {
    return withLedger(this.#ledger, (ledger) => [this.#balanceFrom(ledger, ledger.asset.assetId)])
  }

  async createInvoice(p: { assetId: string; amount: string }): Promise<{
    invoice: string
    recipientId: string
    expiresAt: string
  }> {
    assertBaseUnits(p.amount, 'invoice amount')
    const recipientId = `mockrcpt_${randomBytes(6).toString('hex')}`
    const now = Date.now()
    const expiresAt = new Date(now + INVOICE_TTL_MS).toISOString()

    await withLedger(this.#ledger, (ledger) => {
      ledger.invoices[recipientId] = {
        recipientId,
        role: this.#role,
        assetId: p.assetId,
        amount: p.amount,
        createdAt: new Date(now).toISOString(),
        expiresAt,
        consumed: false,
      }
    })

    return {
      invoice: formatMockInvoice({ recipientId, assetId: p.assetId, amount: p.amount }),
      recipientId,
      expiresAt,
    }
  }

  async pay(p: { invoice: string; assetId: string; amount: string }): Promise<{ txid: string }> {
    assertBaseUnits(p.amount, 'payment amount')
    const parsed = parseMockInvoice(p.invoice)

    if (parsed.assetId !== p.assetId) {
      throw new WalletError(
        `invoice is for asset ${parsed.assetId} but the payment says ${p.assetId}`,
      )
    }
    if (BigInt(parsed.amount) !== BigInt(p.amount)) {
      throw new WalletError(
        `invoice is for ${parsed.amount} base units but the payment says ${p.amount}`,
      )
    }

    const txid = randomBytes(32).toString('hex')

    return withLedger(this.#ledger, (ledger, clock) => {
      const invoice = ledger.invoices[parsed.recipientId]
      if (invoice === undefined) {
        throw new WalletError(`unknown invoice recipientId ${parsed.recipientId}`)
      }
      // Invoices are single-use, like real RGB blinded receives.
      if (invoice.consumed) {
        throw new WalletError(`invoice ${parsed.recipientId} has already been paid`)
      }
      if (Date.parse(invoice.expiresAt) < clock.wall) {
        throw new WalletError(`invoice ${parsed.recipientId} expired at ${invoice.expiresAt}`)
      }
      if (invoice.role === this.#role) {
        throw new WalletError('refusing to pay an invoice this wallet created itself')
      }

      const available = balanceOf(ledger, this.#role, p.assetId)
      if (available < BigInt(p.amount)) {
        throw new WalletError(
          `insufficient ${ledger.asset.ticker}: have ${available.toString()} base units, need ${p.amount}`,
        )
      }

      // Debit now, credit the recipient on settlement -- mirrors how RGB spendable balance drops
      // as soon as the transfer is created.
      debit(ledger, this.#role, p.assetId, p.amount)
      invoice.consumed = true

      const willFail = this.#failAmount !== null && this.#failAmount === BigInt(p.amount)

      ledger.transfers.push({
        id: `mocktr_${randomBytes(6).toString('hex')}`,
        from: this.#role,
        to: invoice.role,
        assetId: p.assetId,
        amount: p.amount,
        status: 'pending',
        txid,
        recipientId: parsed.recipientId,
        createdAt: new Date(clock.wall).toISOString(),
        createdAtMono: clock.mono,
        settleAtMono: clock.mono + this.#settleMs,
        ...(willFail
          ? { failOnSettle: true, failureReason: `MOCK_FAIL_AMOUNT matched (${p.amount} base units)` }
          : {}),
      })

      return { txid }
    })
  }

  /** Opening the ledger already applies anything that came due, so this just does that. */
  async refresh(): Promise<void> {
    await withLedger(this.#ledger, () => undefined)
  }

  /**
   * Force a pending transfer to fail, refunding the sender. Not part of `EscrowWallet` -- it is the
   * mock's stand-in for rgb-lib's `failTransfers`, and the deterministic way for WS3 and the demo
   * to drive the refund path on demand.
   *
   * Only the sender may fail its own transfer, matching rgb-lib (you can only fail transfers in your
   * own wallet). Returns the resulting summary.
   */
  async failTransfer(p: { txid: string; reason?: string }): Promise<TransferSummary> {
    return withLedger(this.#ledger, (ledger) => {
      const t = ledger.transfers.find((x) => x.txid === p.txid)
      if (t === undefined) throw new WalletError(`no transfer with txid ${p.txid}`)
      if (t.from !== this.#role) {
        throw new WalletError(
          `only the sender can fail a transfer: ${p.txid} was sent by ${String(t.from)}, not ${this.#role}`,
        )
      }
      if (t.status !== 'pending') {
        throw new WalletError(`cannot fail transfer ${p.txid}: it is already ${t.status}`)
      }
      failTransferRow(ledger, t, p.reason ?? 'failed by failTransfer()')
      return this.#toSummary(t)
    })
  }

  async transfers(assetId: string): Promise<TransferSummary[]> {
    return withLedger(this.#ledger, (ledger) =>
      ledger.transfers
        .filter((t) => t.assetId === assetId && (t.from === this.#role || t.to === this.#role))
        .map((t) => this.#toSummary(t)))
  }

  async waitForTransfer(p: {
    assetId: string
    recipientId?: string
    txid?: string
    timeoutMs: number
  }): Promise<TransferSummary> {
    if (p.recipientId === undefined && p.txid === undefined) {
      throw new WalletError('waitForTransfer needs either recipientId or txid')
    }

    // Monotonic: a wall-clock deadline here would fire ~96 s early on WSL2 (see src/clock.ts).
    const deadline = monotonicMs() + p.timeoutMs
    let lastKnown: TransferSummary | undefined

    for (;;) {
      const match = await withLedger(this.#ledger, (ledger) => {
        const found = ledger.transfers.find((t) =>
          t.assetId === p.assetId &&
          (p.recipientId === undefined || t.recipientId === p.recipientId) &&
          (p.txid === undefined || t.txid === p.txid))
        return found === undefined ? undefined : this.#toSummary(found)
      })

      if (match !== undefined) {
        lastKnown = match
        if (match.status !== 'pending') return match
      }

      if (monotonicMs() >= deadline) {
        const target = p.recipientId ?? p.txid ?? '(unknown)'
        throw new WalletTimeoutError(
          `transfer ${target} did not settle within ${p.timeoutMs}ms` +
          (lastKnown === undefined ? ' (never appeared in the ledger)' : ` (last status: ${lastKnown.status})`),
          lastKnown,
        )
      }
      await sleep(Math.min(this.#pollMs, Math.max(0, deadline - monotonicMs())))
    }
  }

  /** Not a real signature. Deterministic so tests and the UI can assert on it. */
  async sign(message: string): Promise<{ signature: string; address: string }> {
    const address = mockAddress(this.#role, this.#network)
    const signature = `mocksig_${createHash('sha256').update(`${address}:${message}`).digest('hex')}`
    return { signature, address }
  }

  // ---------------------------------------------------------------- internals

  #balanceFrom(ledger: Ledger, assetId: string): AssetBalance {
    const settled = balanceOf(ledger, this.#role, assetId)
    const incomingPending = ledger.transfers
      .filter((t) => t.status === 'pending' && t.to === this.#role && t.assetId === assetId)
      .reduce((sum, t) => sum + BigInt(t.amount), 0n)

    return {
      assetId,
      ...(assetId === ledger.asset.assetId ? { ticker: ledger.asset.ticker } : {}),
      settled: settled.toString(),
      // What we will have once pending incoming transfers settle.
      future: (settled + incomingPending).toString(),
      // Pending incoming funds cannot be spent yet.
      spendable: settled.toString(),
    }
  }

  #toSummary(t: LedgerTransfer): TransferSummary {
    return {
      id: t.id,
      direction: t.from === this.#role ? 'outgoing' : 'incoming',
      assetId: t.assetId,
      amount: t.amount,
      status: t.status,
      rawStatus: MOCK_RAW_STATUS[t.status],
      txid: t.txid,
      ...(t.recipientId === undefined ? {} : { recipientId: t.recipientId }),
      createdAt: t.createdAt,
    }
  }
}
