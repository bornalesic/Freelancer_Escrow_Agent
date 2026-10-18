// Auto-pay: the client's pre-authorisation, carried out by its own party server so no browser has to stay
// open. When the client approves a listing, its UI posts { escrowId, clientToken } here. Every pass then
// looks the job up on the agent; once a freelancer has taken it (AWAITING_FUNDS with a funding invoice) it
//   1. attaches a refund invoice that stays valid until a day after the deadline, so a refund never needs
//      the client again, and
//   2. pays the job's reward + fee into escrow.
// At most the authorised total (a counteroffer the client accepted costs less), never more, never twice for
// one funding invoice. `paying` is saved BEFORE the payment, so a crash mid-payment never leads to a second
// automatic one. Saved to disk, so a restart carries on.

import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname } from 'node:path'

import {
  AGENT_ROUTES,
  EscrowDetailResponseSchema,
  TERMINAL_STATES,
  escrowTotal,
  type AutopayStatus,
  type Escrow,
} from '@escrow/shared'

import type { Log } from './log.ts'
import { HttpError, TimeoutError, errorMessage } from './util.ts'
import type { PartyWallet } from './wallet.ts'

const DAY_SEC = 24 * 3600
const MAX_INVOICE_SEC = 30 * DAY_SEC

interface Authorisation extends AutopayStatus {
  /** Kept on the client's own laptop only (file mode 0600). The agent checks it on refund-invoice. */
  clientToken: string
  /** The funding invoice this authorisation already paid, or is paying. */
  fundingInvoice?: string
  /** The funding invoice a refund invoice was attached for (one per funding round). */
  refundFor?: string
}

export class Autopay {
  readonly #file: string
  readonly #agentUrl: string
  readonly #wallet: PartyWallet
  readonly #log: Log
  readonly #pollMs: number
  #auths = new Map<string, Authorisation>()
  #timer: NodeJS.Timeout | undefined
  #stopped = false
  #busy = false

  constructor(p: { file: string; agentUrl: string; wallet: PartyWallet; log: Log; pollMs: number }) {
    this.#file = p.file
    this.#agentUrl = p.agentUrl
    this.#wallet = p.wallet
    this.#log = p.log
    this.#pollMs = p.pollMs
    this.#load()
  }

  list(): AutopayStatus[] {
    return [...this.#auths.values()].map(publicView)
  }

  /** The client approved this listing: pay reward + fee into escrow when a freelancer takes it. */
  async authorise(escrowId: string, clientToken: string): Promise<AutopayStatus> {
    const escrow = await this.#escrow(escrowId)
    if (escrow.state !== 'OPEN' && escrow.state !== 'AGREED' && escrow.state !== 'AWAITING_FUNDS') {
      throw new HttpError(409, `Only a published job can be pre-authorised (it is ${escrow.state})`)
    }
    const total = escrowTotal(escrow)
    const existing = this.#auths.get(escrowId)
    if (existing && existing.total === total && existing.status !== 'failed') return publicView(existing)
    // A payment in flight or made is never reset; and the funding invoice already handled stays handled.
    if (existing && (existing.status === 'paying' || existing.status === 'paid')) return publicView(existing)
    const auth: Authorisation = {
      escrowId,
      clientToken,
      total,
      status: 'waiting',
      ...(existing?.fundingInvoice ? { fundingInvoice: existing.fundingInvoice } : {}),
      ...(existing?.refundFor ? { refundFor: existing.refundFor } : {}),
    }
    this.#auths.set(escrowId, auth)
    this.#save()
    this.#log.info(`auto-pay authorised for ${escrowId}: ${total} base units`)
    return publicView(auth)
  }

  start(): void {
    this.#stopped = false
    this.#schedule(0)
  }

  stop(): void {
    this.#stopped = true
    clearTimeout(this.#timer)
  }

  /** One pass over every open authorisation. Exposed for tests. */
  async tick(): Promise<void> {
    if (this.#busy || !this.#wallet.ready) return
    this.#busy = true
    try {
      for (const auth of this.#auths.values()) {
        if (auth.status === 'done') continue
        try {
          await this.#step(auth)
        } catch (err) {
          this.#fail(auth, errorMessage(err))
        }
      }
    } finally {
      this.#busy = false
    }
  }

  async #step(auth: Authorisation): Promise<void> {
    const e = await this.#escrow(auth.escrowId)
    if (TERMINAL_STATES.includes(e.state) || !['OPEN', 'AGREED', 'AWAITING_FUNDS'].includes(e.state)) {
      this.#set(auth, { status: 'done' }) // funded, or over: nothing left to pay
      return
    }
    if (e.state === 'OPEN') {
      // Back on the marketplace (or not taken yet): the next taker gets a fresh funding invoice.
      if (auth.status !== 'waiting') this.#set(auth, { status: 'waiting' })
      return
    }
    const invoice = e.fundingInvoice
    if (e.state !== 'AWAITING_FUNDS' || invoice === undefined) return
    if (auth.fundingInvoice === invoice) return // this one is paid (or its outcome is unclear): never again
    const due = escrowTotal(e)
    if (BigInt(due) > BigInt(auth.total)) {
      throw new Error(`the job now costs ${due} base units, more than the ${auth.total} you approved: approve it again`)
    }

    const w = this.#wallet.get()
    if (auth.refundFor !== invoice) {
      const untilAfterDeadline = Math.ceil((Date.parse(e.deadline) - Date.now()) / 1000) + DAY_SEC
      const refund = await w.createInvoice({
        assetId: e.assetId,
        amount: due,
        expiresInSec: Math.min(MAX_INVOICE_SEC, Math.max(DAY_SEC, untilAfterDeadline)),
      })
      await this.#post(AGENT_ROUTES.refundInvoice(e.id), { invoice: refund.invoice, clientToken: auth.clientToken })
      this.#set(auth, { refundFor: invoice })
    }

    this.#set(auth, { status: 'paying', fundingInvoice: invoice }) // saved BEFORE paying
    let txid: string
    try {
      ({ txid } = await w.pay({ invoice, assetId: e.assetId, amount: due }))
    } catch (err) {
      // A clean refusal (e.g. not enough funds) sent nothing: try this invoice again next pass. A timeout
      // may still go through, so that invoice is never paid again automatically.
      if (!(err instanceof TimeoutError)) this.#set(auth, { fundingInvoice: undefined })
      throw err
    }
    this.#set(auth, { status: 'paid', txid })
    this.#log.info(`auto-pay: paid ${due} base units into escrow ${e.id} (tx ${txid.slice(0, 8)}…)`)
  }

  async #escrow(id: string): Promise<Escrow> {
    const res = await fetch(`${this.#agentUrl}${AGENT_ROUTES.escrow(encodeURIComponent(id))}`, { signal: AbortSignal.timeout(10_000) })
    if (res.status === 404) throw new HttpError(404, 'The escrow agent does not know this job')
    if (!res.ok) throw new Error(`the escrow agent answered HTTP ${res.status}`)
    return EscrowDetailResponseSchema.parse(await res.json()).escrow
  }

  async #post(route: string, body: unknown): Promise<void> {
    const res = await fetch(`${this.#agentUrl}${route}`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(10_000),
    })
    if (!res.ok) throw new Error(`the escrow agent refused (${res.status}): ${await res.text()}`)
  }

  #set(auth: Authorisation, patch: Partial<Authorisation>): void {
    Object.assign(auth, patch)
    if (patch.status !== undefined && patch.status !== 'failed') delete auth.error
    this.#save()
  }

  #fail(auth: Authorisation, error: string): void {
    if (auth.status === 'failed' && auth.error === error) return
    this.#log.warn(`auto-pay for ${auth.escrowId} failed: ${error}`)
    this.#set(auth, { status: 'failed', error })
  }

  #schedule(ms: number): void {
    if (this.#stopped) return
    this.#timer = setTimeout(() => {
      void this.tick().finally(() => { this.#schedule(this.#pollMs) })
    }, ms)
    this.#timer.unref()
  }

  #load(): void {
    let saved: Authorisation[] = []
    try {
      saved = JSON.parse(readFileSync(this.#file, 'utf8')) as Authorisation[]
    } catch {
      return // nothing saved yet
    }
    for (const auth of saved) {
      // A payment interrupted by a crash or restart: its outcome is unknown, so it is never retried
      // automatically. If it went through, the job shows FUNDED; if not, the funding window reopens it.
      if (auth.status === 'paying') {
        auth.status = 'failed'
        auth.error = 'The payment was interrupted; check this wallet\'s transfers'
      }
      this.#auths.set(auth.escrowId, auth)
    }
  }

  #save(): void {
    mkdirSync(dirname(this.#file), { recursive: true })
    const tmp = `${this.#file}.tmp`
    writeFileSync(tmp, JSON.stringify([...this.#auths.values()], null, 1), { mode: 0o600 })
    renameSync(tmp, this.#file)
  }
}

function publicView(auth: Authorisation): AutopayStatus {
  return {
    escrowId: auth.escrowId,
    total: auth.total,
    status: auth.status,
    ...(auth.error === undefined ? {} : { error: auth.error }),
    ...(auth.txid === undefined ? {} : { txid: auth.txid }),
  }
}
