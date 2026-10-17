// Background refresh. An RGB transfer only advances when the wallets refresh -- the recipient's refresh
// is what pulls the consignment off the proxy -- so this loop is what makes payments "just arrive".
//
// It refreshes while any transfer is pending (apps/party/CLAUDE.md task 3), and also for a while after
// this server hands out an invoice. A wallet that has never seen the asset gets an unbound invoice, and
// its incoming transfer may not be listed under that asset until a refresh pulls it in, so waiting for
// "pending" alone could wait forever.
//
// Deadlines are monotonic (performance.now), never Date.now(): see packages/wallet/src/clock.ts.

import type { EscrowWallet } from '@escrow/shared'

import type { Log } from './log.ts'
import { errorMessage } from './util.ts'
import type { PartyWallet } from './wallet.ts'

/** For an invoice without an expiry. rgb-sdk's default invoice life (durationSeconds) is 2000 s. */
const DEFAULT_WATCH_MS = 2_000_000
const MAX_WATCH_MS = 60 * 60 * 1000

async function hasPending(w: EscrowWallet): Promise<boolean> {
  for (const asset of await w.listAssets()) {
    if ((await w.transfers(asset.assetId)).some((t) => t.status === 'pending')) return true
  }
  return false
}

export class RefreshLoop {
  readonly #wallet: PartyWallet
  readonly #pollMs: number
  readonly #log: Log
  #watchUntilMono = Number.NEGATIVE_INFINITY
  #timer: NodeJS.Timeout | undefined
  #stopped = false
  #lastError: string | undefined

  constructor(p: { wallet: PartyWallet; pollMs: number; log: Log }) {
    this.#wallet = p.wallet
    this.#pollMs = p.pollMs
    this.#log = p.log
  }

  start(): void {
    this.#stopped = false
    this.#schedule(0)
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  /** Keep refreshing until this invoice expires, even while nothing is pending yet. */
  watchInvoice(expiresAt: string | undefined): void {
    // Wall clock read once to turn the expiry into a duration; a clock step at this instant only
    // shifts the window by the size of the step.
    const left = expiresAt === undefined ? Number.NaN : Date.parse(expiresAt) - Date.now()
    const ms = Number.isFinite(left) ? Math.min(Math.max(left, 0), MAX_WATCH_MS) : DEFAULT_WATCH_MS
    this.#watchUntilMono = Math.max(this.#watchUntilMono, performance.now() + ms)
  }

  /** One pass: (re)start the wallet if needed, then refresh if anything is in flight. */
  async tick(): Promise<void> {
    await this.#wallet.start()
    if (!this.#wallet.ready) return
    const w = this.#wallet.get()
    try {
      if (performance.now() < this.#watchUntilMono || await hasPending(w)) await w.refresh()
      this.#lastError = undefined
    } catch (err) {
      // This runs every few seconds: log each distinct failure once, not on every pass.
      const msg = errorMessage(err)
      if (msg !== this.#lastError) this.#log.warn(`background refresh failed: ${msg}`)
      this.#lastError = msg
    }
  }

  #schedule(ms: number): void {
    if (this.#stopped) return
    // Chained setTimeout, not setInterval: a slow refresh must never overlap the next pass.
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => { this.#schedule(this.#pollMs) })
    }, ms)
    this.#timer.unref()
  }
}
