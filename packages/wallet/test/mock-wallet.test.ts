import { mkdtempSync, readFileSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterEach, beforeEach, describe, expect, it } from 'vitest'

import {
  MockWallet,
  WalletError,
  WalletTimeoutError,
  formatMockInvoice,
  parseMockInvoice,
} from '../src/mock-wallet.ts'
import type { LedgerHandle } from '../src/ledger.ts'

// A realistic asset id: it contains a colon of its own, which is the thing that makes the invoice
// format non-trivial to parse. Taken from the real regtest rehearsal.
const ASSET = 'rgb:ZmMRjCzR-YMCTtbY-7a7iqtB-rxbBAcm-z73c6CM-v6_wANY'
const UNIT = 1_000_000n
const SETTLE_MS = 120

let dir: string
let ledger: LedgerHandle

function wallet(role: 'client' | 'freelancer' | 'agent'): MockWallet {
  return new MockWallet({ role, network: 'regtest', ledger, settleMs: SETTLE_MS, pollMs: 10 })
}

/** For assertions about the pre-settlement state, where a short delay would be a race. */
function slowWallet(role: 'client' | 'freelancer' | 'agent'): MockWallet {
  return new MockWallet({ role, network: 'regtest', ledger, settleMs: 60_000, pollMs: 10 })
}

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'escrow-mock-'))
  ledger = {
    path: join(dir, '.mock-ledger.json'),
    seed: {
      asset: { assetId: ASSET, ticker: 'TUSDT', precision: 6 },
      balances: { client: (100n * UNIT).toString(), freelancer: '0', agent: '0' },
      btcSat: '100000000',
    },
  }
})

afterEach(() => {
  rmSync(dir, { recursive: true, force: true })
})

describe('invoice format', () => {
  it('round-trips an asset id that contains a colon', () => {
    const invoice = formatMockInvoice({ recipientId: 'mockrcpt_abc123', assetId: ASSET, amount: '50000000' })
    expect(invoice).toBe(`mock:mockrcpt_abc123:${ASSET}:50000000`)
    expect(parseMockInvoice(invoice)).toEqual({
      recipientId: 'mockrcpt_abc123',
      assetId: ASSET,
      amount: '50000000',
    })
  })

  it('rejects anything that is not a mock invoice', () => {
    expect(() => parseMockInvoice('rgb:real-invoice')).toThrow(WalletError)
    expect(() => parseMockInvoice('mock:only-one-part')).toThrow(WalletError)
    expect(() => parseMockInvoice(`mock:rcpt:${ASSET}:not-a-number`)).toThrow(WalletError)
  })
})

describe('seeding', () => {
  it('starts the client with 100 tUSDT and everyone else with 0', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    const agent = wallet('agent')
    await Promise.all([client.init(), freelancer.init(), agent.init()])

    expect((await client.balance(ASSET)).settled).toBe((100n * UNIT).toString())
    expect((await freelancer.balance(ASSET)).settled).toBe('0')
    expect((await agent.balance(ASSET)).settled).toBe('0')
  })

  it('reports the ticker and a BTC balance in info()', async () => {
    const client = wallet('client')
    await client.init()
    const info = await client.info()
    expect(info.role).toBe('client')
    expect(info.network).toBe('regtest')
    expect(info.address).toMatch(/^mock1client[0-9a-f]{24}$/)
    expect(BigInt(info.btcBalanceSat)).toBeGreaterThan(0n)
    expect((await client.listAssets())[0]?.ticker).toBe('TUSDT')
  })
})

describe('pay between two instances sharing a ledger file', () => {
  // Deliberately a long settle delay: these assertions are about the state BEFORE settlement, and a
  // short delay makes them a race -- each ledger operation is real file I/O under a lock, so 120ms
  // can elapse legitimately before the assertion runs.
  it('debits the sender at once and leaves the recipient uncredited while pending', async () => {
    const client = slowWallet('client')
    const freelancer = slowWallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (40n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })

    const { txid } = await client.pay({ invoice, assetId: ASSET, amount })
    expect(txid).toMatch(/^[0-9a-f]{64}$/)

    // Sender is debited immediately; recipient sees it as future, not spendable.
    const clientAfterPay = await client.balance(ASSET)
    expect(clientAfterPay.settled).toBe((60n * UNIT).toString())
    expect(clientAfterPay.spendable).toBe((60n * UNIT).toString())

    const freelancerPending = await freelancer.balance(ASSET)
    expect(freelancerPending.settled).toBe('0')
    expect(freelancerPending.spendable).toBe('0')
    expect(freelancerPending.future).toBe(amount)

    // Both sides see the transfer, with opposite directions.
    const outgoing = await client.transfers(ASSET)
    const incoming = await freelancer.transfers(ASSET)
    expect(outgoing).toHaveLength(1)
    expect(incoming).toHaveLength(1)
    expect(outgoing[0]?.direction).toBe('outgoing')
    expect(incoming[0]?.direction).toBe('incoming')
    expect(outgoing[0]?.status).toBe('pending')
    expect(outgoing[0]?.rawStatus).toBe('MockWaitingSettlement')
    expect(incoming[0]?.recipientId).toBe(recipientId)
  })

  it('credits the recipient once the transfer settles', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (40n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await client.pay({ invoice, assetId: ASSET, amount })

    const settled = await freelancer.waitForTransfer({
      assetId: ASSET,
      recipientId,
      timeoutMs: 5_000,
    })
    expect(settled.status).toBe('settled')
    expect(settled.rawStatus).toBe('MockSettled')

    expect((await freelancer.balance(ASSET)).settled).toBe(amount)
    expect((await freelancer.balance(ASSET)).spendable).toBe(amount)
    expect((await client.balance(ASSET)).settled).toBe((60n * UNIT).toString())
  })

  it('is visible to a third wallet instance that never saw the payment happen', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (10n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await client.pay({ invoice, assetId: ASSET, amount })

    // A brand-new instance -- as if another process had just started -- reads the same file.
    const observer = wallet('freelancer')
    await observer.refresh()
    expect((await observer.transfers(ASSET))).toHaveLength(1)
  })

  it('settles without the paying process doing anything further', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (5n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await client.pay({ invoice, assetId: ASSET, amount })

    await new Promise<void>((r) => { setTimeout(r, SETTLE_MS + 60) })

    // Nobody called refresh() in between; opening the ledger is enough to apply the settlement.
    const fresh = wallet('agent')
    const all = await fresh.transfers(ASSET)
    expect(all).toHaveLength(0) // the agent is not a party to it

    const summary = await freelancer.waitForTransfer({ assetId: ASSET, recipientId, timeoutMs: 1_000 })
    expect(summary.status).toBe('settled')
  })
})

describe('rejections', () => {
  it('refuses to pay the same invoice twice', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (1n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await client.pay({ invoice, assetId: ASSET, amount })
    await expect(client.pay({ invoice, assetId: ASSET, amount })).rejects.toThrow(/already been paid/)
  })

  it('refuses a payment whose amount does not match the invoice', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount: (7n * UNIT).toString() })
    await expect(
      client.pay({ invoice, assetId: ASSET, amount: (8n * UNIT).toString() }),
    ).rejects.toThrow(/invoice is for 7000000 base units/)
  })

  it('refuses a payment for the wrong asset', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (1n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await expect(
      client.pay({ invoice, assetId: 'rgb:some-other-asset', amount }),
    ).rejects.toThrow(/but the payment says/)
  })

  it('refuses to overspend', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (500n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await expect(client.pay({ invoice, assetId: ASSET, amount })).rejects.toThrow(/insufficient TUSDT/)

    // The failed payment must not have moved anything.
    expect((await client.balance(ASSET)).settled).toBe((100n * UNIT).toString())
    expect(await client.transfers(ASSET)).toHaveLength(0)
  })

  it('refuses to pay an invoice the same wallet created', async () => {
    const client = wallet('client')
    await client.init()
    const amount = (1n * UNIT).toString()
    const { invoice } = await client.createInvoice({ assetId: ASSET, amount })
    await expect(client.pay({ invoice, assetId: ASSET, amount })).rejects.toThrow(/itself/)
  })

  it('rejects non-integer amounts', async () => {
    const client = wallet('client')
    await client.init()
    await expect(client.createInvoice({ assetId: ASSET, amount: '1.5' })).rejects.toThrow(/base units/)
  })
})

describe('waitForTransfer', () => {
  it('throws WalletTimeoutError and reports the last status seen', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const slow = new MockWallet({
      role: 'client',
      network: 'regtest',
      ledger,
      settleMs: 60_000,
      pollMs: 10,
    })

    const amount = (2n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await slow.pay({ invoice, assetId: ASSET, amount })

    const err = await freelancer
      .waitForTransfer({ assetId: ASSET, recipientId, timeoutMs: 120 })
      .catch((e: unknown) => e)

    expect(err).toBeInstanceOf(WalletTimeoutError)
    expect((err as WalletTimeoutError).lastKnown?.status).toBe('pending')
  })

  it('needs either recipientId or txid', async () => {
    const client = wallet('client')
    await client.init()
    await expect(client.waitForTransfer({ assetId: ASSET, timeoutMs: 10 })).rejects.toThrow(
      /recipientId or txid/,
    )
  })

  it('can match on txid', async () => {
    const client = wallet('client')
    const freelancer = wallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (3n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    const { txid } = await client.pay({ invoice, assetId: ASSET, amount })

    const summary = await client.waitForTransfer({ assetId: ASSET, txid, timeoutMs: 5_000 })
    expect(summary.status).toBe('settled')
    expect(summary.txid).toBe(txid)
  })
})

describe('failed transfers', () => {
  function failingPair(amount: string) {
    const client = new MockWallet({
      role: 'client', network: 'regtest', ledger, settleMs: SETTLE_MS, pollMs: 10, failAmount: amount,
    })
    const freelancer = new MockWallet({
      role: 'freelancer', network: 'regtest', ledger, settleMs: SETTLE_MS, pollMs: 10, failAmount: amount,
    })
    return { client, freelancer }
  }

  it('MOCK_FAIL_AMOUNT makes a payment fail and refunds the sender', async () => {
    const amount = (25n * UNIT).toString()
    const { client, freelancer } = failingPair(amount)
    await client.init()
    await freelancer.init()

    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await client.pay({ invoice, assetId: ASSET, amount })

    // Debited up front, exactly as a successful payment would be.
    expect((await client.balance(ASSET)).settled).toBe((75n * UNIT).toString())

    const resolved = await freelancer.waitForTransfer({ assetId: ASSET, recipientId, timeoutMs: 5_000 })
    expect(resolved.status).toBe('failed')
    expect(resolved.rawStatus).toBe('MockFailed')

    // The sender gets their money back and the recipient is never credited.
    expect((await client.balance(ASSET)).settled).toBe((100n * UNIT).toString())
    expect((await freelancer.balance(ASSET)).settled).toBe('0')
    expect((await freelancer.balance(ASSET)).future).toBe('0')
  })

  it('leaves a different amount settling normally', async () => {
    const { client, freelancer } = failingPair((25n * UNIT).toString())
    await client.init()
    await freelancer.init()

    const amount = (26n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await client.pay({ invoice, assetId: ASSET, amount })

    const resolved = await freelancer.waitForTransfer({ assetId: ASSET, recipientId, timeoutMs: 5_000 })
    expect(resolved.status).toBe('settled')
    expect((await freelancer.balance(ASSET)).settled).toBe(amount)
  })

  it('failTransfer() fails a pending transfer on demand and refunds the sender', async () => {
    const client = slowWallet('client')
    const freelancer = slowWallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (30n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    const { txid } = await client.pay({ invoice, assetId: ASSET, amount })
    expect((await client.balance(ASSET)).settled).toBe((70n * UNIT).toString())

    const failed = await client.failTransfer({ txid, reason: 'counterparty never collected' })
    expect(failed.status).toBe('failed')
    expect(failed.rawStatus).toBe('MockFailed')

    expect((await client.balance(ASSET)).settled).toBe((100n * UNIT).toString())
    expect((await freelancer.balance(ASSET)).settled).toBe('0')

    // waitForTransfer returns the failure rather than throwing -- the caller decides what it means.
    const seen = await freelancer.waitForTransfer({ assetId: ASSET, recipientId, timeoutMs: 1_000 })
    expect(seen.status).toBe('failed')
  })

  it('only the sender can fail a transfer, and only while it is pending', async () => {
    const client = slowWallet('client')
    const freelancer = slowWallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (2n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    const { txid } = await client.pay({ invoice, assetId: ASSET, amount })

    await expect(freelancer.failTransfer({ txid })).rejects.toThrow(/only the sender can fail/)
    await expect(client.failTransfer({ txid: 'deadbeef' })).rejects.toThrow(/no transfer with txid/)

    await client.failTransfer({ txid })
    await expect(client.failTransfer({ txid })).rejects.toThrow(/already failed/)
  })

  it('a failed transfer does not free the invoice for reuse', async () => {
    const client = slowWallet('client')
    const freelancer = slowWallet('freelancer')
    await client.init()
    await freelancer.init()

    const amount = (4n * UNIT).toString()
    const { invoice } = await freelancer.createInvoice({ assetId: ASSET, amount })
    const { txid } = await client.pay({ invoice, assetId: ASSET, amount })
    await client.failTransfer({ txid })

    // Like a spent RGB blinded receive: the payer must ask for a fresh invoice.
    await expect(client.pay({ invoice, assetId: ASSET, amount })).rejects.toThrow(/already been paid/)
  })
})

describe('wall-clock jumps', () => {
  // WSL2 on this hardware jumps Date.now() forward ~96 s and back (scratch/wsl-clock-jump.mjs).
  // Settlement deadlines must not be affected: a forward jump used to settle a pending transfer
  // instantly, which in the real flow would mean releasing escrowed funds early.
  it('does not settle a pending transfer when Date.now() jumps forward', async () => {
    const freelancer = wallet('freelancer')
    const slow = new MockWallet({
      role: 'client',
      network: 'regtest',
      ledger,
      settleMs: 60_000,
      pollMs: 10,
    })
    await freelancer.init()
    await slow.init()

    const amount = (1n * UNIT).toString()
    const { invoice, recipientId } = await freelancer.createInvoice({ assetId: ASSET, amount })
    await slow.pay({ invoice, assetId: ASSET, amount })

    const realNow = Date.now
    try {
      // Shove the wall clock two minutes into the future, past the 60 s settle delay.
      Date.now = () => realNow.call(Date) + 120_000
      const [found] = await freelancer.transfers(ASSET)
      expect(found?.status).toBe('pending')
      expect((await freelancer.balance(ASSET)).settled).toBe('0')
    } finally {
      Date.now = realNow
    }

    // Still pending once the clock is back to normal, and still matchable.
    const err = await freelancer
      .waitForTransfer({ assetId: ASSET, recipientId, timeoutMs: 60 })
      .catch((e: unknown) => e)
    expect(err).toBeInstanceOf(WalletTimeoutError)
  })
})

describe('ledger file', () => {
  it('writes valid JSON that another reader can parse', async () => {
    const client = wallet('client')
    await client.init()
    const parsed = JSON.parse(readFileSync(ledger.path, 'utf8')) as { version: number }
    expect(parsed.version).toBe(2)
  })

  it('refuses a ledger written by a future version', async () => {
    const client = wallet('client')
    await client.init()
    const bad = JSON.parse(readFileSync(ledger.path, 'utf8')) as Record<string, unknown>
    bad['version'] = 99
    const { writeFileSync } = await import('node:fs')
    writeFileSync(ledger.path, JSON.stringify(bad), 'utf8')

    await expect(client.balance(ASSET)).rejects.toThrow(/version 99/)
  })
})
