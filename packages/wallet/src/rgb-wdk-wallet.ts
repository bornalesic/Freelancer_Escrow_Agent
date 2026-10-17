// RgbWdkWallet: EscrowWallet over Tether WDK's RGB wallet (@utexo/wdk-wallet-rgb 2.0.3, rgb-lib inside).
//
// Load this module lazily -- createWallet() does. Importing it loads the native rgb-lib, which exists
// only for Linux/macOS-arm64 and needs glibc >= 2.38; a static import would break mock mode on Windows
// and on Ubuntu 22.04.
//
// The account's runtime shapes differ from the package's .d.ts files, so this file talks to it through
// its own narrow `RgbAccount` view (built from ~/scratch/wdk-probe/probe-shapes.mjs) and leaves all
// translation to ./rgb-mapping.ts. Nothing here logs the mnemonic.

import { mkdirSync } from 'node:fs'

import WalletManagerRgb from '@utexo/wdk-wallet-rgb'

import { monotonicMs } from './clock.ts'
import type { AssetBalance, EscrowWallet, Role, TransferSummary, WalletInfo } from './contract-types.ts'
import { WalletError, WalletTimeoutError } from './mock-wallet.ts'
import {
  ZERO_BALANCE,
  countFreeUtxos,
  flattenAssets,
  isAssetNotFound,
  isOpenInvoice,
  isOutOfUtxos,
  toAssetBalance,
  toSdkAmount,
  toTransferSummary,
  translateError,
  type RgbAsset,
  type RgbBalance,
  type RgbTransferRow,
  type RgbUnspent,
} from './rgb-mapping.ts'

/** Size of each colorable UTXO `createUtxos` makes; what the rehearsal and the probe used. */
export const UTXO_SIZE_SAT = 1_000
/** Invoice lifetime, the same hour as MockWallet's. rgb-sdk's own default is 2000 s. */
const INVOICE_TTL_SEC = 60 * 60

/** What opening any RGB wallet here needs; RgbWdkWallet and the setup scripts' Treasury share it. */
export interface RgbConnection {
  network: string
  /** Never logged. */
  mnemonic: string
  /** This wallet's own directory. Never open one dataDir from two processes. */
  dataDir: string
  indexerUrl: string
  transportEndpoint: string
  maxFeeSat: number
}

export interface RgbWdkWalletOptions extends RgbConnection {
  role: Role
  feeRate: number
  /** Used for both sending and receiving: an invoice settles at the confirmations it was created with. */
  minConfirmations: number
  minFreeUtxos: number
  pollMs: number
}

/** The account methods this wallet uses, typed from what they return at runtime (see file header). */
interface RgbAccount {
  registerWallet(): Promise<{ address: string }>
  syncWallet(): void
  refreshWallet(): void
  listUnspents(): RgbUnspent[]
  createUtxos(o: { upTo: boolean; num: number; size: number; feeRate: number }): Promise<number>
  listAssets(): Record<string, RgbAsset[] | null | undefined>
  receiveAsset(o: {
    assetId?: string
    amount: number
    witness: false
    minConfirmations: number
    durationSeconds: number
  }): { invoice: string; recipientId: string; expirationTimestamp: number }
  transfer(o: { token: string; recipient: string; amount: number; feeRate: number; minConfirmations: number }): Promise<{ hash: string }>
  listTransfers(assetId?: string): RgbTransferRow[]
  sign(message: string): Promise<string>
  getRgbWallet(): { getBtcBalance(): { vanilla: RgbBalance }; getAssetBalance(assetId: string): RgbBalance }
  dispose(): void
}

/** What the constructor accepts at runtime; the .d.ts config type has only `network` and `keys`. */
interface RgbManagerConfig {
  network: string
  dataDir: string
  indexerUrl: string
  transportEndpoint: string
  transferMaxFee: number
}

const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })

export const isValidMnemonic = (mnemonic: string): boolean => WalletManagerRgb.isValidSeedPhrase(mnemonic)
export const newMnemonic = (): string => WalletManagerRgb.getRandomSeedPhrase()

/**
 * Open the WDK manager and its one account. The .d.ts config type has only `network` and `keys`, so
 * the config the runtime really takes is cast; `T` is the caller's narrow view of the account.
 */
export async function openRgbAccount<T>(c: RgbConnection): Promise<T> {
  mkdirSync(c.dataDir, { recursive: true })
  const config: RgbManagerConfig = {
    network: c.network,
    dataDir: c.dataDir,
    indexerUrl: c.indexerUrl,
    transportEndpoint: c.transportEndpoint,
    transferMaxFee: c.maxFeeSat,
  }
  const manager = new WalletManagerRgb(c.mnemonic, config as unknown as ConstructorParameters<typeof WalletManagerRgb>[1])
  return (await manager.getAccount()) as unknown as T
}

export class RgbWdkWallet implements EscrowWallet {
  readonly #opts: RgbWdkWalletOptions
  #account: RgbAccount | undefined
  #address: string | undefined
  /** rgb-lib does not like concurrent calls, so every call -- sync ones too -- goes through this chain. */
  #queue: Promise<unknown> = Promise.resolve()

  constructor(opts: RgbWdkWalletOptions) {
    if (!isValidMnemonic(opts.mnemonic)) {
      throw new WalletError(`the ${opts.role} mnemonic is not a valid BIP-39 seed phrase`)
    }
    this.#opts = opts
  }

  #run<T>(fn: () => T | Promise<T>): Promise<T> {
    const next = this.#queue.then(() => fn(), () => fn())
    this.#queue = next.catch(() => undefined)
    return next
  }

  #ready(): RgbAccount {
    if (this.#account === undefined || this.#address === undefined) {
      throw new WalletError(`the ${this.#opts.role} RGB wallet is not open yet: call init() first`)
    }
    return this.#account
  }

  /**
   * Open the wallet (first call), register it, and make sure it has MIN_FREE_UTXOS free colorable
   * UTXOs. Safe to call again after a failure: each step that already succeeded is skipped, so the
   * dataDir is never opened twice.
   */
  async init(): Promise<void> {
    await this.#run(async () => {
      if (this.#account === undefined) this.#account = await openRgbAccount<RgbAccount>(this.#opts)
      const account = this.#account
      if (this.#address === undefined) this.#address = (await account.registerWallet()).address
      account.syncWallet()
      await this.#topUpUtxos(account)
    })
  }

  /** Each open invoice reserves a colorable UTXO until it is paid or expires; keep enough free. */
  async #topUpUtxos(account: RgbAccount): Promise<void> {
    if (countFreeUtxos(account.listUnspents()) >= this.#opts.minFreeUtxos) return
    try {
      await account.createUtxos({ upTo: true, num: this.#opts.minFreeUtxos, size: UTXO_SIZE_SAT, feeRate: this.#opts.feeRate })
    } catch (err) {
      throw translateError(err)
    }
  }

  async info(): Promise<WalletInfo> {
    return this.#run(() => {
      const btc = this.#ready().getRgbWallet().getBtcBalance()
      return {
        role: this.#opts.role,
        network: this.#opts.network,
        address: this.#address ?? '',
        // vanilla.settled stays 0 until syncWallet(); spendable is right without it.
        btcBalanceSat: String(btc.vanilla.spendable),
      }
    })
  }

  async balance(assetId: string): Promise<AssetBalance> {
    return this.#run(() => {
      const account = this.#ready()
      const asset = flattenAssets(account.listAssets()).find((a) => a.assetId === assetId)
      // Never held it: getAssetBalance would throw AssetNotFound.
      if (asset === undefined) return toAssetBalance(assetId, ZERO_BALANCE)
      return toAssetBalance(assetId, account.getRgbWallet().getAssetBalance(assetId), asset.ticker)
    })
  }

  async listAssets(): Promise<AssetBalance[]> {
    return this.#run(() => {
      const account = this.#ready()
      return flattenAssets(account.listAssets()).map((a) =>
        toAssetBalance(a.assetId, a.balance ?? account.getRgbWallet().getAssetBalance(a.assetId), a.ticker))
    })
  }

  async createInvoice(p: { assetId: string; amount: string }): Promise<{ invoice: string; recipientId: string; expiresAt: string }> {
    const amount = toSdkAmount(p.amount, 'invoice amount')
    return this.#run(async () => {
      const account = this.#ready()
      // A wallet cannot bind an invoice to an asset it has never seen (AssetNotFound), so its first one
      // is unbound -- and an unbound invoice accepts any asset. That is safe here because transfers()
      // only lists rows under the asset asked for: a payment in some other asset never shows up as this.
      const known = flattenAssets(account.listAssets()).some((a) => a.assetId === p.assetId)
      const request = {
        ...(known ? { assetId: p.assetId } : {}),
        amount,
        witness: false as const,
        minConfirmations: this.#opts.minConfirmations,
        durationSeconds: INVOICE_TTL_SEC,
      }
      let inv
      try {
        inv = account.receiveAsset(request)
      } catch (err) {
        if (!isOutOfUtxos(err)) throw translateError(err)
        await this.#topUpUtxos(account)
        try {
          inv = account.receiveAsset(request)
        } catch (retryErr) {
          throw translateError(retryErr)
        }
      }
      return {
        invoice: inv.invoice,
        recipientId: inv.recipientId,
        expiresAt: new Date(inv.expirationTimestamp * 1000).toISOString(),
      }
    })
  }

  async pay(p: { invoice: string; assetId: string; amount: string }): Promise<{ txid: string }> {
    const amount = toSdkAmount(p.amount, 'payment amount')
    return this.#run(async () => {
      const account = this.#ready()
      let hash: string
      try {
        // transfer() quotes first and refuses a fee >= transferMaxFee (MAX_FEE_SAT) by itself.
        ({ hash } = await account.transfer({
          token: p.assetId,
          recipient: p.invoice,
          amount,
          feeRate: this.#opts.feeRate,
          minConfirmations: this.#opts.minConfirmations,
        }))
      } catch (err) {
        throw translateError(err)
      }
      // The wrapper returns `result.txid || 'unknown'`. The agent matches payouts by txid, so without one
      // it could never see this settle -- and the payment may already be broadcast, so say so.
      if (!/^[0-9a-f]{64}$/i.test(hash)) {
        throw new WalletError(
          `the RGB SDK returned no txid ("${hash}") after sending: check this wallet's transfers before paying again`,
        )
      }
      return { txid: hash }
    })
  }

  async refresh(): Promise<void> {
    await this.#run(() => { this.#ready().refreshWallet() })
  }

  async transfers(assetId: string): Promise<TransferSummary[]> {
    return this.#run(() => {
      let rows: RgbTransferRow[]
      try {
        rows = this.#ready().listTransfers(assetId)
      } catch (err) {
        // A wallet that has never seen the asset. Its unbound invoices are listed only by
        // listTransfers() with no argument -- and those rows are open invoices, not transfers.
        if (isAssetNotFound(err)) return []
        throw err
      }
      return rows.filter((row) => !isOpenInvoice(row)).map((row) => toTransferSummary(row, assetId))
    })
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
    // Monotonic: a wall-clock deadline fires early or stalls when the clock steps (src/clock.ts).
    const deadline = monotonicMs() + p.timeoutMs
    let lastKnown: TransferSummary | undefined

    for (;;) {
      // An RGB transfer only advances when the wallets refresh, so refresh every round.
      await this.refresh()
      const match = (await this.transfers(p.assetId)).find((t) =>
        (p.recipientId === undefined || t.recipientId === p.recipientId) &&
        (p.txid === undefined || t.txid === p.txid))

      if (match !== undefined) {
        lastKnown = match
        if (match.status !== 'pending') return match
      }
      if (monotonicMs() >= deadline) {
        const target = p.recipientId ?? p.txid ?? '(unknown)'
        throw new WalletTimeoutError(
          `transfer ${target} did not settle within ${p.timeoutMs}ms` +
          (lastKnown === undefined ? ' (never appeared)' : ` (last status: ${lastKnown.rawStatus})`),
          lastKnown,
        )
      }
      await sleep(Math.min(this.#opts.pollMs, Math.max(0, deadline - monotonicMs())))
    }
  }

  async sign(message: string): Promise<{ signature: string; address: string }> {
    return this.#run(async () => {
      const signature = await this.#ready().sign(message)
      // The registered address: getAddress() hands out a new one on every call.
      return { signature, address: this.#address ?? '' }
    })
  }

  /** Not part of EscrowWallet: for the setup scripts' "every wallet has >= MIN_FREE_UTXOS" check. */
  async freeUtxoCount(): Promise<number> {
    return this.#run(() => countFreeUtxos(this.#ready().listUnspents()))
  }

  /** Not part of EscrowWallet. `account.dispose()` only -- `manager.dispose()` throws "Invalid checksum". */
  dispose(): void {
    this.#account?.dispose()
    this.#account = undefined
    this.#address = undefined
  }
}
