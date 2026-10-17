// Opt-in integration test against the regtest stack. Ubuntu 24.04 only: the native rgb-lib needs
// glibc >= 2.38.
//
//   RGB_IT=1 npm test -w packages/wallet
//
// Needs scripts/regtest up, the chain above height 100, and bitcoind's `miner` wallet loaded (after a
// distro restart: bitcoin-cli ... loadwallet miner). Fresh wallets in a temp dir on every run.
//
// Everything that loads rgb-lib is imported inside beforeAll, so where the native library is missing
// this file is collected, skipped, and never touches it.

import { mkdirSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { TransferSummary } from '../src/contract-types.ts'
import type { RgbWdkWallet } from '../src/rgb-wdk-wallet.ts'

const RPC_URL = process.env['BITCOIND_RPC_URL'] ?? 'http://127.0.0.1:18443'
// Node's fetch() refuses credentials in the URL, so send them as a header.
const RPC_AUTH = 'Basic ' + Buffer.from(
  `${process.env['BITCOIND_RPC_USER'] ?? 'user'}:${process.env['BITCOIND_RPC_PASS'] ?? 'default_password'}`,
).toString('base64')
const INDEXER = process.env['RGB_INDEXER_URL'] ?? 'tcp://127.0.0.1:50001'
const TRANSPORT = process.env['RGB_TRANSPORT_ENDPOINT'] ?? 'rpc://127.0.0.1:3000/json-rpc'
const UNIT = 1_000_000

async function rpc<T = unknown>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
  const res = await fetch(wallet === undefined ? RPC_URL : `${RPC_URL}/wallet/${wallet}`, {
    method: 'POST',
    headers: { 'content-type': 'text/plain;', authorization: RPC_AUTH },
    body: JSON.stringify({ jsonrpc: '1.0', id: 'it', method, params }),
    signal: AbortSignal.timeout(30_000),
  })
  const body = (await res.json()) as { result: T; error: unknown }
  if (body.error) throw new Error(`bitcoind ${method}: ${JSON.stringify(body.error)}`)
  return body.result
}

/** The issuer, driven through WDK directly: issuing an asset is not part of EscrowWallet. */
interface TreasuryAccount {
  registerWallet(): Promise<{ address: string }>
  syncWallet(): void
  refreshWallet(): void
  createUtxos(o: { upTo: boolean; num: number; size: number; feeRate: number }): Promise<number>
  issueAssetNia(o: { ticker: string; name: string; precision: number; amounts: number[] }): { assetId: string }
  transfer(o: { token: string; recipient: string; amount: number; feeRate: number; minConfirmations: number }): Promise<{ hash: string }>
  dispose(): void
}

describe.skipIf(process.env['RGB_IT'] !== '1')('RgbWdkWallet on regtest', () => {
  let dir: string | undefined
  let minerAddress = ''
  let Wallet: typeof RgbWdkWallet
  let newMnemonic: () => string
  let treasury: TreasuryAccount | undefined
  let assetId = ''
  let client: RgbWdkWallet | undefined
  let agent: RgbWdkWallet | undefined

  const mine = (n = 1) => rpc('generatetoaddress', [n, minerAddress], 'miner')

  function open(role: 'client' | 'agent', mnemonic: string): RgbWdkWallet {
    return new Wallet({
      role,
      network: 'regtest',
      mnemonic,
      dataDir: join(dir ?? tmpdir(), role),
      indexerUrl: INDEXER,
      transportEndpoint: TRANSPORT,
      feeRate: 2,
      minConfirmations: 1,
      minFreeUtxos: 3,
      maxFeeSat: 5_000,
      pollMs: 200,
    })
  }

  /** Fund with BTC (sendtoaddress: ordinary outputs, no coinbase maturity rule) and finish init(). */
  async function openFunded(w: RgbWdkWallet): Promise<void> {
    // The first init() opens and registers the wallet, then cannot create UTXOs: no BTC yet.
    await expect(w.init()).rejects.toThrow(/not enough BTC/)
    await rpc('sendtoaddress', [(await w.info()).address, 1], 'miner')
    await mine(1)
    await w.init() // skips what already worked, creates the UTXOs
    await mine(1)
    await w.refresh()
  }

  /** Recipient refreshes first (that pulls the consignment off the proxy), then the sender; mine. */
  async function settleInto(recipient: RgbWdkWallet, recipientId: string, refreshSender: () => unknown): Promise<TransferSummary> {
    for (let block = 1; block <= 6; block += 1) {
      await recipient.refresh()
      await refreshSender()
      await mine(1)
      await recipient.refresh()
      await refreshSender()
      const t = (await recipient.transfers(assetId)).find((x) => x.recipientId === recipientId)
      if (t?.status === 'settled') return t
    }
    throw new Error(`transfer to ${recipientId} not settled after 6 blocks`)
  }

  beforeAll(async () => {
    ({ RgbWdkWallet: Wallet } = await import('../src/rgb-wdk-wallet.ts'))
    const { default: WalletManagerRgb } = await import('@utexo/wdk-wallet-rgb')
    newMnemonic = () => WalletManagerRgb.getRandomSeedPhrase()

    dir = mkdtempSync(join(tmpdir(), 'escrow-rgb-it-'))
    if ((await rpc<number>('getblockcount')) < 101) throw new Error('prime the regtest chain first (scripts/regtest/README.md)')
    minerAddress = await rpc<string>('getnewaddress', [], 'miner')

    const treasuryDir = join(dir, 'treasury')
    mkdirSync(treasuryDir, { recursive: true })
    const config = { network: 'regtest', dataDir: treasuryDir, indexerUrl: INDEXER, transportEndpoint: TRANSPORT }
    const manager = new WalletManagerRgb(newMnemonic(), config as unknown as ConstructorParameters<typeof WalletManagerRgb>[1])
    const t = (await manager.getAccount()) as unknown as TreasuryAccount
    treasury = t
    await rpc('sendtoaddress', [(await t.registerWallet()).address, 1], 'miner')
    await mine(1)
    t.syncWallet()
    await t.createUtxos({ upTo: true, num: 3, size: 1_000, feeRate: 2 })
    await mine(1)
    t.refreshWallet()
    assetId = t.issueAssetNia({ ticker: 'TUSDT', name: 'tUSDT (test)', precision: 6, amounts: [1_000_000 * UNIT] }).assetId
    await mine(1)
    t.refreshWallet()

    client = open('client', newMnemonic())
    agent = open('agent', newMnemonic())
    await openFunded(client)
    await openFunded(agent)
  }, 300_000)

  afterAll(() => {
    client?.dispose()
    agent?.dispose()
    treasury?.dispose()
    if (dir !== undefined) rmSync(dir, { recursive: true, force: true })
  })

  it('rejects a mnemonic that is not BIP-39 without echoing it', () => {
    let message = ''
    try { open('client', 'definitely not a real seed phrase') } catch (err) { message = (err as Error).message }
    expect(message).toMatch(/not a valid BIP-39 seed phrase/)
    expect(message).not.toContain('definitely')
  })

  it('funds the client: unbound first invoice, hidden until paid, settled after 1 block', async () => {
    const c = client!
    const amount = String(100 * UNIT)
    expect(await c.balance(assetId)).toEqual({ assetId, settled: '0', future: '0', spendable: '0' })

    const inv = await c.createInvoice({ assetId, amount })
    expect(inv.invoice).toMatch(/^rgb:~\/~\//) // unbound: the client has never seen the asset
    expect(await c.transfers(assetId)).toEqual([]) // an open invoice is not a transfer

    await treasury!.transfer({ token: assetId, recipient: inv.invoice, amount: 100 * UNIT, feeRate: 2, minConfirmations: 1 })
    const received = await settleInto(c, inv.recipientId, () => { treasury!.refreshWallet() })
    expect(received).toMatchObject({ direction: 'incoming', amount, status: 'settled', rawStatus: 'Settled' })
    expect(await c.balance(assetId)).toMatchObject({ settled: amount, spendable: amount })
    expect(await c.waitForTransfer({ assetId, recipientId: inv.recipientId, timeoutMs: 10_000 })).toMatchObject({ status: 'settled' })
  }, 120_000)

  it('pays the agent: txid matches the rows, the balance locks while in flight, no second payment', async () => {
    const c = client!
    const a = agent!
    const amount = String(30 * UNIT)
    const inv = await a.createInvoice({ assetId, amount })

    const { txid } = await c.pay({ invoice: inv.invoice, assetId, amount })
    expect(txid).toMatch(/^[0-9a-f]{64}$/)
    expect((await c.transfers(assetId)).find((t) => t.txid === txid)).toMatchObject({ direction: 'outgoing', amount, status: 'pending' })
    expect(await c.balance(assetId)).toMatchObject({ settled: String(100 * UNIT), future: String(70 * UNIT), spendable: '0' })

    const received = await settleInto(a, inv.recipientId, () => c.refresh())
    expect(received).toMatchObject({ direction: 'incoming', amount, txid, status: 'settled' })
    expect((await c.transfers(assetId)).find((t) => t.txid === txid)).toMatchObject({ status: 'settled', amount })
    await expect(c.pay({ invoice: inv.invoice, assetId, amount })).rejects.toThrow(/already been paid/)
  }, 120_000)

  it('binds the next invoice to the asset once the wallet knows it', async () => {
    const inv = await agent!.createInvoice({ assetId, amount: String(UNIT) })
    expect(inv.invoice.startsWith(`${assetId}/`)).toBe(true)
  }, 60_000)

  it('signs with the registered address', async () => {
    const { signature, address } = await client!.sign('hello escrow')
    expect(signature.length).toBeGreaterThan(40)
    expect(address).toBe((await client!.info()).address)
  }, 60_000)
})
