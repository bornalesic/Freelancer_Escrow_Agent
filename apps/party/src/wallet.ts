// Owns this party's one wallet: creates it, inits it with retry, and puts a timeout on every call.
//
// apps/party/CLAUDE.md task 4: if the wallet cannot start, the server keeps answering /health with
// { ok: false, error } so the UI can say why, instead of showing a dead page. Retrying means a wallet
// that failed because the regtest stack was not up yet comes back on its own.

import type { EscrowWallet, PartyRole, WalletMode } from '@escrow/shared'
import { createWallet } from '@escrow/wallet'

import type { Log } from './log.ts'
import { HttpError, errorMessage, withTimeout } from './util.ts'

/** Per-call timeouts (root CLAUDE.md rule 8). Real rgb-lib calls talk to the indexer and the proxy. */
const TIMEOUTS: Record<keyof EscrowWallet, number> = {
  init: 180_000, // may create UTXOs; createUtxos once took 98 s right after bulk mining
  info: 20_000,
  balance: 20_000,
  listAssets: 20_000,
  createInvoice: 30_000,
  pay: 90_000,
  refresh: 60_000,
  transfers: 20_000,
  waitForTransfer: 600_000, // has its own timeoutMs; this is a backstop
  sign: 20_000,
}

const RETRY_MS = 15_000

function timed(w: EscrowWallet): EscrowWallet {
  return new Proxy(w, {
    get(target, prop) {
      // Read with `target` as the receiver, not the proxy: MockWallet keeps its state in #private
      // fields, and a getter called on the proxy would throw.
      const v: unknown = Reflect.get(target, prop)
      if (typeof v !== 'function' || typeof prop !== 'string' || !(prop in TIMEOUTS)) return v
      const ms = TIMEOUTS[prop as keyof EscrowWallet]
      return (...args: unknown[]) => withTimeout(Promise.resolve(v.apply(target, args)), ms, `wallet.${prop}`)
    },
  })
}

export class PartyWallet {
  readonly #role: PartyRole
  readonly #mode: WalletMode
  readonly #log: Log
  readonly #override: EscrowWallet | undefined
  #wallet: EscrowWallet | undefined
  #ready = false
  #error: string | undefined
  #starting: Promise<void> | undefined
  #lastAttemptMono = Number.NEGATIVE_INFINITY

  constructor(p: { role: PartyRole; mode: WalletMode; log: Log; wallet?: EscrowWallet }) {
    this.#role = p.role
    this.#mode = p.mode
    this.#log = p.log
    this.#override = p.wallet
  }

  get ready(): boolean {
    return this.#ready
  }

  get error(): string | undefined {
    return this.#error
  }

  /** The wallet, or a 503 while it is not ready. */
  get(): EscrowWallet {
    if (!this.#ready || this.#wallet === undefined) {
      throw new HttpError(503, this.#error ?? 'The wallet is starting')
    }
    return this.#wallet
  }

  /**
   * Create + init, at most once every 15 s until it works. Called at startup and by every refresh
   * loop pass, so it is cheap once the wallet is ready.
   */
  start(): Promise<void> {
    if (this.#ready) return Promise.resolve()
    if (this.#starting) return this.#starting
    // Monotonic: a wall-clock jump must not cause a burst of retries or stall them
    // (packages/wallet/src/clock.ts).
    const now = performance.now()
    if (now - this.#lastAttemptMono < RETRY_MS) return Promise.resolve()
    this.#lastAttemptMono = now

    this.#starting = (async () => {
      try {
        if (this.#wallet === undefined) {
          const raw = this.#override ??
            await withTimeout(createWallet({ role: this.#role, mode: this.#mode }), TIMEOUTS.init, 'createWallet')
          this.#wallet = timed(raw)
        }
        await this.#wallet.init()
        this.#ready = true
        this.#error = undefined
        this.#log.info(`wallet ready (${this.#mode})`)
      } catch (err) {
        this.#error = `The wallet failed to start: ${errorMessage(err)}`
        this.#log.error(this.#error)
      } finally {
        this.#starting = undefined
      }
    })()
    return this.#starting
  }
}
