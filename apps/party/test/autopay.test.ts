// Private balances and auto-pay on the client's party server, against a fake agent and real MockWallets
// sharing a temporary ledger.

import { mkdtempSync, rmSync, statSync } from 'node:fs'
import http from 'node:http'
import type { AddressInfo } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { PARTY_ROUTES, type EscrowWallet } from '@escrow/shared'
import { createWallet } from '@escrow/wallet'

import { buildApp, type PartyApp } from '../src/app.ts'
import { loadConfig } from '../src/config.ts'

const ASSET = 'mock-tusdt'
const TOTAL = '51000000' // 50 reward + 1 fee
const TOKEN = 'c'.repeat(64)

let dir: string
let agentWallet: EscrowWallet
let client: PartyApp

// ---- a fake agent: one escrow we move by hand, and the refund invoices it was sent ----------------
const escrow: Record<string, unknown> = {
  id: 'esc_1', title: 'Slugify', rawText: 'x', amount: '50000000', fee: '1000000', assetId: ASSET, assetTicker: 'TUSDT',
  precision: 6, deadline: new Date(Date.now() + 3600_000).toISOString(), state: 'OPEN', conditions: [], acceptances: [],
  deliveries: [], createdAt: new Date().toISOString(), updatedAt: new Date().toISOString(),
}
const refunds: { invoice: string; clientToken: string }[] = []
let agent: http.Server
let agentUrl = ''

beforeAll(async () => {
  dir = mkdtempSync(join(tmpdir(), 'escrow-autopay-'))
  process.env['MOCK_LEDGER_PATH'] = join(dir, '.mock-ledger.json')
  process.env['MOCK_SETTLE_MS'] = '100'
  delete process.env['ESCROW_ASSET_ID']

  agent = http.createServer((req, res) => {
    let body = ''
    req.on('data', (c) => { body += c })
    req.on('end', () => {
      res.setHeader('content-type', 'application/json')
      if (req.method === 'GET' && req.url === '/escrows/esc_1') return res.end(JSON.stringify({ escrow, events: [] }))
      if (req.method === 'POST' && req.url === '/escrows/esc_1/refund-invoice') {
        refunds.push(JSON.parse(body) as { invoice: string; clientToken: string })
        return res.end(JSON.stringify(escrow))
      }
      res.statusCode = 404
      res.end('{"error":"not found"}')
    })
  })
  await new Promise<void>((r) => agent.listen(0, '127.0.0.1', r))
  agentUrl = `http://127.0.0.1:${(agent.address() as AddressInfo).port}`

  agentWallet = await createWallet({ role: 'agent', mode: 'mock' })
  const config = { ...loadConfig({ ROLE: 'client', WALLET_MODE: 'mock', WALLET_POLL_MS: '60000' }), agentUrl, dataDir: join(dir, 'party') }
  client = await buildApp({ config })
  await client.wallet.start()
})

afterAll(async () => {
  await client.app.close()
  agent.close()
  rmSync(dir, { recursive: true, force: true })
})

const fromLan = (method: 'GET' | 'POST', url: string, payload?: object) =>
  client.app.inject({ method, url, remoteAddress: '192.168.1.50', ...(payload ? { payload } : {}) })

describe('private balances', () => {
  it('answers balance, history and spending only to this laptop', async () => {
    for (const [method, url] of [
      ['GET', PARTY_ROUTES.wallet],
      ['GET', `${PARTY_ROUTES.walletTransfers}?assetId=${ASSET}`],
      ['POST', PARTY_ROUTES.walletPay],
      ['POST', PARTY_ROUTES.walletSign],
      ['POST', PARTY_ROUTES.autopay],
      ['GET', PARTY_ROUTES.autopay],
    ] as const) {
      expect((await fromLan(method, url, method === 'POST' ? {} : undefined)).statusCode, `${method} ${url}`).toBe(403)
    }
    expect((await client.app.inject({ method: 'GET', url: PARTY_ROUTES.wallet })).statusCode).toBe(200) // loopback
  })

  it('refuses a website opened on this laptop: the page must be served from localhost', async () => {
    const from = (origin: string) => client.app.inject({ method: 'GET', url: PARTY_ROUTES.wallet, headers: { origin } })
    expect((await from('https://evil.example')).statusCode).toBe(403)
    expect((await from('null')).statusCode).toBe(403)
    expect((await from('http://localhost:5174')).statusCode).toBe(200)
    expect((await from('http://127.0.0.1:5174')).statusCode).toBe(200)
  })

  it('still lets the LAN see health and ask for an invoice', async () => {
    expect((await fromLan('GET', PARTY_ROUTES.health)).statusCode).toBe(200)
    expect((await fromLan('POST', PARTY_ROUTES.walletInvoice, { assetId: ASSET, amount: '1' })).statusCode).toBe(200)
  })
})

describe('auto-pay', () => {
  const status = async () => (await client.app.inject({ method: 'GET', url: PARTY_ROUTES.autopay })).json() as { status: string; error?: string }[]
  const agentIncoming = async () => (await agentWallet.transfers(ASSET)).filter((t) => t.direction === 'incoming')

  it('waits while the job is open, then attaches a refund invoice and pays reward + fee exactly once', async () => {
    const authorised = await client.app.inject({ method: 'POST', url: PARTY_ROUTES.autopay, payload: { escrowId: 'esc_1', clientToken: TOKEN } })
    expect(authorised.json()).toMatchObject({ escrowId: 'esc_1', total: TOTAL, status: 'waiting' })
    expect(statSync(join(dir, 'party', 'autopay.json')).mode & 0o777).toBe(0o600) // it holds the clientToken

    await client.autopay!.tick()
    expect(refunds).toHaveLength(0)

    // A freelancer takes it: the agent opens a funding invoice for the total.
    const funding = await agentWallet.createInvoice({ assetId: ASSET, amount: TOTAL })
    Object.assign(escrow, { state: 'AWAITING_FUNDS', fundingInvoice: funding.invoice })
    await client.autopay!.tick()

    expect(refunds).toHaveLength(1)
    expect(refunds[0]!.clientToken).toBe(TOKEN)
    expect(refunds[0]!.invoice).toMatch(new RegExp(`:${TOTAL}$`)) // the refund returns reward + fee
    expect((await status())[0]).toMatchObject({ status: 'paid' })
    expect(await agentIncoming()).toHaveLength(1)

    await client.autopay!.tick() // the same funding invoice is never paid twice
    expect(await agentIncoming()).toHaveLength(1)
    expect(refunds).toHaveLength(1)
  })

  it('pays again only for a new funding round after the job went back on the marketplace', async () => {
    // The first round's money comes back through the refund invoice auto-pay attached (the client
    // started with 100, so it could not fund a second 51 otherwise).
    await new Promise((r) => setTimeout(r, 200)) // MOCK_SETTLE_MS
    await agentWallet.pay({ invoice: refunds[0]!.invoice, assetId: ASSET, amount: TOTAL })
    await new Promise((r) => setTimeout(r, 200))

    Object.assign(escrow, { state: 'OPEN', fundingInvoice: undefined })
    await client.autopay!.tick()
    expect((await status())[0]!.status).toBe('waiting')

    const funding = await agentWallet.createInvoice({ assetId: ASSET, amount: TOTAL })
    Object.assign(escrow, { state: 'AWAITING_FUNDS', fundingInvoice: funding.invoice })
    await client.autopay!.tick()
    expect(await agentIncoming()).toHaveLength(2)
    expect(refunds).toHaveLength(2)
  })

  it('refuses to pay more than the client approved', async () => {
    const funding = await agentWallet.createInvoice({ assetId: ASSET, amount: '61200000' })
    Object.assign(escrow, { state: 'OPEN', fundingInvoice: undefined })
    await client.autopay!.tick()
    Object.assign(escrow, { state: 'AWAITING_FUNDS', amount: '60000000', fee: '1200000', fundingInvoice: funding.invoice })
    await client.autopay!.tick()
    expect((await status())[0]).toMatchObject({ status: 'failed' })
    expect((await status())[0]!.error).toMatch(/approve it again/)
    expect(await agentIncoming()).toHaveLength(2) // nothing paid
  })

  it('pays a lower price the client accepted (a counteroffer), with a refund invoice for that amount', async () => {
    const funding = await agentWallet.createInvoice({ assetId: ASSET, amount: '40800000' })
    Object.assign(escrow, { state: 'AWAITING_FUNDS', amount: '40000000', fee: '800000', fundingInvoice: funding.invoice })
    await client.autopay!.tick()
    expect((await status())[0]).toMatchObject({ status: 'paid' })
    expect(refunds.at(-1)!.invoice).toMatch(/:40800000$/)
    const incoming = await agentIncoming()
    expect(incoming).toHaveLength(3)
    expect(incoming.map((t) => t.amount)).toContain('40800000')
  })

  it('is done once the job is funded', async () => {
    Object.assign(escrow, { state: 'FUNDED', amount: '50000000', fee: '1000000' })
    await client.autopay!.tick()
    expect((await status())[0]!.status).toBe('done')
  })
})
