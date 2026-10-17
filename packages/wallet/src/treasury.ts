// Treasury: the demo's issuer. It issues TUSDT and pays the client its starting 100. Only the setup
// scripts use it (scripts/setup-demo.ts), so it is not an EscrowWallet. Import it lazily, as
// `@escrow/wallet/treasury`: loading it loads the native rgb-lib, like RgbWdkWallet.

import { WalletError } from './mock-wallet.ts'
import {
  countFreeUtxos,
  flattenAssets,
  statusName,
  toSdkAmount,
  translateError,
  type RgbAsset,
  type RgbBalance,
  type RgbTransferRow,
  type RgbUnspent,
} from './rgb-mapping.ts'
import { UTXO_SIZE_SAT, isValidMnemonic, openRgbAccount, type RgbConnection } from './rgb-wdk-wallet.ts'

export { newMnemonic } from './rgb-wdk-wallet.ts'

export interface TreasuryOptions extends RgbConnection {
  feeRate: number
  minConfirmations: number
}

/** The account methods the treasury uses, typed from what they return at runtime. */
interface TreasuryAccount {
  registerWallet(): Promise<{ address: string }>
  syncWallet(): void
  refreshWallet(): void
  listUnspents(): RgbUnspent[]
  createUtxos(o: { upTo: boolean; num: number; size: number; feeRate: number }): Promise<number>
  /** Returns the asset flat, although the .d.ts says `{ asset }`. */
  issueAssetNia(o: { ticker: string; name: string; precision: number; amounts: number[] }): RgbAsset
  listAssets(): Record<string, RgbAsset[] | null | undefined>
  transfer(o: { token: string; recipient: string; amount: number; feeRate: number; minConfirmations: number }): Promise<{ hash: string }>
  listTransfers(assetId?: string): RgbTransferRow[]
  getRgbWallet(): { getBtcBalance(): { vanilla: RgbBalance }; getAssetBalance(assetId: string): RgbBalance }
  dispose(): void
}

export class Treasury {
  readonly address: string
  readonly #account: TreasuryAccount
  readonly #opts: TreasuryOptions

  private constructor(account: TreasuryAccount, address: string, opts: TreasuryOptions) {
    this.#account = account
    this.address = address
    this.#opts = opts
  }

  static async open(opts: TreasuryOptions): Promise<Treasury> {
    if (!isValidMnemonic(opts.mnemonic)) throw new WalletError('the treasury mnemonic is not a valid BIP-39 seed phrase')
    const account = await openRgbAccount<TreasuryAccount>(opts)
    const { address } = await account.registerWallet()
    return new Treasury(account, address, opts)
  }

  /** BTC in sats, after a sync (without one, vanilla.settled stays 0). */
  btcSat(): number {
    this.#account.syncWallet()
    return this.#account.getRgbWallet().getBtcBalance().vanilla.spendable
  }

  freeUtxoCount(): number {
    return countFreeUtxos(this.#account.listUnspents())
  }

  async ensureUtxos(count: number): Promise<void> {
    this.#account.syncWallet()
    if (this.freeUtxoCount() >= count) return
    try {
      await this.#account.createUtxos({ upTo: true, num: count, size: UTXO_SIZE_SAT, feeRate: this.#opts.feeRate })
    } catch (err) {
      throw translateError(err)
    }
  }

  /** Issue a non-inflatable asset with the whole supply in this wallet. Returns its asset id. */
  issueNia(p: { ticker: string; name: string; precision: number; supply: string }): string {
    let asset: RgbAsset
    try {
      asset = this.#account.issueAssetNia({
        ticker: p.ticker,
        name: p.name,
        precision: p.precision,
        amounts: [toSdkAmount(p.supply, 'supply')],
      })
    } catch (err) {
      throw translateError(err)
    }
    return asset.assetId
  }

  /** Base units of `assetId` this wallet holds (0 if it has never seen it). */
  assetBalance(assetId: string): RgbBalance {
    const held = flattenAssets(this.#account.listAssets()).some((a) => a.assetId === assetId)
    return held ? this.#account.getRgbWallet().getAssetBalance(assetId) : { settled: 0, future: 0, spendable: 0 }
  }

  async pay(p: { invoice: string; assetId: string; amount: string }): Promise<string> {
    let hash: string
    try {
      ({ hash } = await this.#account.transfer({
        token: p.assetId,
        recipient: p.invoice,
        amount: toSdkAmount(p.amount, 'payment amount'),
        feeRate: this.#opts.feeRate,
        minConfirmations: this.#opts.minConfirmations,
      }))
    } catch (err) {
      throw translateError(err)
    }
    if (!/^[0-9a-f]{64}$/i.test(hash)) throw new WalletError(`the RGB SDK returned no txid ("${hash}") after sending`)
    return hash
  }

  /** rgb-lib's status name for the payment with this txid ("Settled", ...), if it exists. */
  paymentStatus(assetId: string, txid: string): string | undefined {
    const row = this.#account.listTransfers(assetId).find((r) => r.txid === txid)
    return row === undefined ? undefined : statusName(row.status)
  }

  refresh(): void {
    this.#account.refreshWallet()
  }

  /** `account.dispose()` only -- `manager.dispose()` throws "Invalid checksum". */
  dispose(): void {
    this.#account.dispose()
  }
}
