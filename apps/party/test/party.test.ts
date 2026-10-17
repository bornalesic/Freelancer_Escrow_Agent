import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  PARTY_ROUTES,
  type EscrowWallet,
  type InvoiceResponse,
  type PartyHealthResponse,
  type PayResponse,
  type SignResponse,
  type TransferSummary,
  type WalletResponse,
} from '@escrow/shared'
import { createWallet } from '@escrow/wallet'

import { buildApp, type PartyApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'
import { sleep } from '../src/util.ts'

// The shared mock default, used by both packages/wallet and apps/agent when ESCROW_ASSET_ID is empty.
const ASSET = 'mock-tusdt'
const UNIT = 1_000_000n

let dir: string
let client: PartyApp
let freelancer: PartyApp
let agent: EscrowWallet

async function party(role: 'client' | 'freelancer', wallet?: EscrowWallet, pollMs = 50): Promise<PartyApp> {
  const config = loadConfig({ ROLE: role, WALLET_MODE: 'mock', WALLET_POLL_MS: String(pollMs) })
  const p = await buildApp({ config, ...(wallet === undefined ? {} : { wallet }) })
  await p.wallet.start()
  return p
}

async function call<T>(p: PartyApp, method: 'GET' | 'POST', url: string, payload?: object) {
  const res = await p.app.inject({ method, url, ...(payload === undefined ? {} : { payload }) })
  return { status: res.statusCode, body: res.json() as T }
}

const transfersUrl = `${PARTY_ROUTES.walletTransfers}?assetId=${ASSET}`

async function waitResolved(p: PartyApp, txid: string): Promise<TransferSummary> {
  for (let i = 0; i < 200; i += 1) {
    const t = (await call<TransferSummary[]>(p, 'GET', transfersUrl)).body.find((x) => x.txid === txid)
    if (t !== undefined && t.status !== 'pending') return t
    await sleep(20)
  }
  throw new Error(`transfer ${txid} never left pending`)
}

const settledOf = async (p: PartyApp) =>
  (await call<WalletResponse>(p, 'GET', PARTY_ROUTES.wallet)).body.assets.find((a) => a.assetId === ASSET)?.settled

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'escrow-party-'))
  process.env['MOCK_LEDGER_PATH'] = join(dir, '.mock-ledger.json')
  process.env['MOCK_SETTLE_MS'] = '100'
  delete process.env['ESCROW_ASSET_ID']
  delete process.env['MOCK_FAIL_AMOUNT']

  agent = await createWallet({ role: 'agent', mode: 'mock' })
  client = await party('client')
  freelancer = await party('freelancer')
})

afterAll(async () => {
  await client.app.close()
  await freelancer.app.close()
  rmSync(dir, { recursive: true, force: true })
})

describe('health and wallet', () => {
  it('reports ok with its role and wallet mode', async () => {
    const { status, body } = await call<PartyHealthResponse>(client, 'GET', PARTY_ROUTES.health)
    expect(status).toBe(200)
    expect(body).toEqual({ ok: true, role: 'client', walletMode: 'mock' })
  })

  it("shows the client's seeded 100 tUSDT under the asset id the agent uses", async () => {
    const { status, body } = await call<WalletResponse>(client, 'GET', PARTY_ROUTES.wallet)
    expect(status).toBe(200)
    expect(body.role).toBe('client')
    expect(body.assets).toEqual([expect.objectContaining({ assetId: ASSET, settled: (100n * UNIT).toString() })])
  })
})

describe('funding and payout through the party servers', () => {
  it('client pays the agent, then the agent pays the freelancer', async () => {
    const amount = (30n * UNIT).toString()

    // Funding: the agent's invoice, paid from the client's screen.
    const funding = await agent.createInvoice({ assetId: ASSET, amount })
    const paid = await call<PayResponse>(client, 'POST', PARTY_ROUTES.walletPay, { invoice: funding.invoice, assetId: ASSET, amount })
    expect(paid.status).toBe(200)
    expect(await waitResolved(client, paid.body.txid)).toMatchObject({ direction: 'outgoing', status: 'settled', amount })
    expect(await settledOf(client)).toBe((70n * UNIT).toString())

    // Release: the freelancer's payout invoice, paid by the agent.
    const payout = await call<InvoiceResponse>(freelancer, 'POST', PARTY_ROUTES.walletInvoice, { assetId: ASSET, amount })
    expect(payout.status).toBe(200)
    const { txid } = await agent.pay({ invoice: payout.body.invoice, assetId: ASSET, amount })
    expect(await waitResolved(freelancer, txid)).toMatchObject({
      direction: 'incoming',
      status: 'settled',
      amount,
      recipientId: payout.body.recipientId,
    })
    expect(await settledOf(freelancer)).toBe(amount)
  })
})

describe('errors', () => {
  it('rejects a fractional amount with 400 and the zod details', async () => {
    const { status, body } = await call<{ error: string; details: unknown[] }>(
      client, 'POST', PARTY_ROUTES.walletPay, { invoice: 'mock:x:mock-tusdt:1', assetId: ASSET, amount: '1.5' })
    expect(status).toBe(400)
    expect(body.error).toBe('Invalid request')
    expect(body.details.length).toBeGreaterThan(0)
  })

  it("passes the wallet's own message through as a 400", async () => {
    const amount = (1000n * UNIT).toString()
    const inv = await agent.createInvoice({ assetId: ASSET, amount })
    const { status, body } = await call<{ error: string }>(client, 'POST', PARTY_ROUTES.walletPay, { invoice: inv.invoice, assetId: ASSET, amount })
    expect(status).toBe(400)
    expect(body.error).toMatch(/insufficient/)
  })

  it('needs an assetId to list transfers', async () => {
    expect((await call(client, 'GET', PARTY_ROUTES.walletTransfers)).status).toBe(400)
  })
})

describe('sign', () => {
  it("signs with the party's wallet", async () => {
    const { status, body } = await call<SignResponse>(client, 'POST', PARTY_ROUTES.walletSign, { message: 'hello' })
    expect(status).toBe(200)
    expect(body.signature).toMatch(/^mocksig_/)
    expect(body.address).toMatch(/^mock1client/)
  })
})

describe('a wallet that cannot start', () => {
  it('keeps /health up with the reason, and answers wallet routes with 503', async () => {
    const broken = { init: () => Promise.reject(new Error('indexer unreachable')) } as unknown as EscrowWallet
    const p = await party('client', broken)
    try {
      const health = await call<PartyHealthResponse>(p, 'GET', PARTY_ROUTES.health)
      expect(health.status).toBe(200)
      expect(health.body.ok).toBe(false)
      expect(health.body.error).toMatch(/indexer unreachable/)

      const wallet = await call<{ error: string }>(p, 'GET', PARTY_ROUTES.wallet)
      expect(wallet.status).toBe(503)
      expect(wallet.body.error).toMatch(/indexer unreachable/)
    } finally {
      await p.app.close()
    }
  })
})

describe('background refresh', () => {
  /** Counts refreshes; reports one pending transfer while `state.pending` is true. */
  function countingWallet(state: { pending: boolean; refreshes: number }): EscrowWallet {
    const assetId = 'rgb:fake'
    return {
      init: async () => {},
      listAssets: async () => [{ assetId, settled: '0', future: '0', spendable: '0' }],
      transfers: async () => (state.pending
        ? [{ id: 't1', direction: 'incoming', assetId, amount: '1', status: 'pending', rawStatus: 'WaitingCounterparty' }]
        : []),
      refresh: async () => { state.refreshes += 1 },
      createInvoice: async () => ({
        invoice: 'rgb:fake-invoice',
        recipientId: 'r1',
        expiresAt: new Date(Date.now() + 60_000).toISOString(),
      }),
    } as unknown as EscrowWallet
  }

  it('refreshes while a transfer is pending, and keeps watching after handing out an invoice', async () => {
    const state = { pending: false, refreshes: 0 }
    // A one-minute poll: after the startup pass, only the explicit tick() calls below run.
    const p = await party('freelancer', countingWallet(state), 60_000)
    try {
      await sleep(30) // let the startup pass finish
      const base = state.refreshes

      await p.loop.tick()
      expect(state.refreshes).toBe(base) // nothing in flight: no refresh

      state.pending = true
      await p.loop.tick()
      expect(state.refreshes).toBe(base + 1)

      state.pending = false
      await p.loop.tick()
      expect(state.refreshes).toBe(base + 1) // settled: stops again

      // Nothing pending yet, but an invoice is out: a first, unbound invoice may not show as pending
      // until a refresh pulls the transfer in, so keep refreshing until it expires.
      const inv = await call<InvoiceResponse>(p, 'POST', PARTY_ROUTES.walletInvoice, { assetId: 'rgb:fake', amount: '1' })
      expect(inv.status).toBe(200)
      await p.loop.tick()
      expect(state.refreshes).toBe(base + 2)
    } finally {
      await p.app.close()
    }
  })
})
