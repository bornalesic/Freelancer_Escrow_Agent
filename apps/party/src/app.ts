// The party server: one party's wallet behind the PARTY_ROUTES of docs/CONTRACTS.md §4. The web UI on
// that party's laptop uses it for everything wallet-related; the client's also carries out auto-pay.
//
// Balances are private: everything that reveals or spends this wallet answers only requests from this
// laptop (loopback -- a Windows browser reaching WSL arrives as 127.0.0.1). The agent and other users
// can only ask for an invoice or a refresh.

import { join } from 'node:path'

import cors from '@fastify/cors'
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify'
import { ZodError, z, type ZodType } from 'zod'
import {
  AutopayRequestSchema,
  InvoiceRequestSchema,
  PARTY_ROUTES,
  PayRequestSchema,
  SignRequestSchema,
  type AutopayStatus,
  type EscrowWallet,
  type InvoiceResponse,
  type PartyHealthResponse,
  type PayResponse,
  type SignResponse,
  type TransferSummary,
  type WalletResponse,
} from '@escrow/shared'
import { WalletError } from '@escrow/wallet'

import { Autopay } from './autopay.ts'
import type { Config } from './config.ts'
import { makeLog, type Log } from './log.ts'
import { RefreshLoop } from './refresh-loop.ts'
import { HttpError, TimeoutError } from './util.ts'
import { PartyWallet } from './wallet.ts'

export interface AppOptions {
  config: Config
  /** Inject a wallet (tests). Otherwise createWallet() from @escrow/wallet. */
  wallet?: EscrowWallet
}

export interface PartyApp {
  app: FastifyInstance
  wallet: PartyWallet
  loop: RefreshLoop
  /** The client's auto-pay (undefined on a freelancer's party server). */
  autopay: Autopay | undefined
  log: Log
}

const LOOPBACK = new Set(['127.0.0.1', '::1', '::ffff:127.0.0.1'])

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '[::1]'])

/**
 * This wallet's balance, history and spending are for this laptop's own app only. A browser on this
 * laptop always connects from loopback, whatever page it shows, so the page's Origin must be loopback
 * too: otherwise any website opened here could read or spend the wallet. Open the UI as localhost.
 */
function onlyThisLaptop(req: FastifyRequest): void {
  if (!LOOPBACK.has(req.ip)) {
    throw new HttpError(403, 'Only the app on this laptop can see or spend this wallet')
  }
  const origin = req.headers.origin
  if (origin !== undefined && !isLoopbackOrigin(origin)) {
    throw new HttpError(403, 'Open the app as http://localhost to use this wallet')
  }
}

function isLoopbackOrigin(origin: string): boolean {
  try {
    return LOOPBACK_HOSTS.has(new URL(origin).hostname)
  } catch {
    return false // "null" (sandboxed page, file://) or garbage
  }
}

/**
 * Query of GET /wallet/transfers. `@escrow/shared` has the route but no schema for its query yet;
 * candidate for the next contract change (as `TransfersQuerySchema`).
 */
const TransfersQuerySchema = z.object({ assetId: z.string().min(1) })

function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data ?? {})
}

export async function buildApp(opts: AppOptions): Promise<PartyApp> {
  const { config } = opts
  const log = makeLog(`party:${config.role}`)
  const wallet = new PartyWallet({
    role: config.role,
    mode: config.walletMode,
    log,
    ...(opts.wallet === undefined ? {} : { wallet: opts.wallet }),
  })
  const loop = new RefreshLoop({ wallet, pollMs: config.pollMs, log })
  const autopay = config.role === 'client'
    ? new Autopay({ file: join(config.dataDir, 'autopay.json'), agentUrl: config.agentUrl, wallet, log, pollMs: config.pollMs })
    : undefined

  const app = Fastify({ logger: false, bodyLimit: 64 * 1024 })
  await app.register(cors, { origin: true }) // LAN demo: the UI comes from another port or laptop

  app.addHook('onResponse', async (req, reply) => {
    log.info(`${req.method} ${req.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`)
  })

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', details: err.issues })
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) })
    }
    // The caller got something wrong: unknown, spent or expired invoice, wrong amount, not enough funds.
    if (err instanceof WalletError) return reply.code(400).send({ error: err.message })
    if (err instanceof TimeoutError) return reply.code(504).send({ error: err.message })
    const e = err as { statusCode?: number; message?: string }
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message })
    log.error(`unhandled: ${e.message ?? String(err)}`)
    return reply.code(500).send({ error: 'Internal error', details: e.message })
  })

  // Always answers, even when the wallet failed to start: the UI shows `error` instead of a dead page.
  app.get(PARTY_ROUTES.health, async (): Promise<PartyHealthResponse> => ({
    ok: wallet.ready,
    role: config.role,
    walletMode: config.walletMode,
    ...(wallet.ready ? {} : { error: wallet.error ?? 'The wallet is starting' }),
  }))

  app.get(PARTY_ROUTES.wallet, async (req): Promise<WalletResponse> => {
    onlyThisLaptop(req)
    const w = wallet.get()
    const [info, assets] = await Promise.all([w.info(), w.listAssets()])
    return { ...info, assets }
  })

  app.post(PARTY_ROUTES.walletInvoice, async (req): Promise<InvoiceResponse> => {
    const inv = await wallet.get().createInvoice(parse(InvoiceRequestSchema, req.body))
    loop.watchInvoice(inv.expiresAt)
    return { invoice: inv.invoice, recipientId: inv.recipientId, ...(inv.expiresAt === undefined ? {} : { expiresAt: inv.expiresAt }) }
  })

  // The only route that moves money. The UI calls it with an invoice the agent provided.
  app.post(PARTY_ROUTES.walletPay, async (req): Promise<PayResponse> => {
    onlyThisLaptop(req)
    const body = parse(PayRequestSchema, req.body)
    try {
      const { txid } = await wallet.get().pay(body)
      log.info(`paid ${body.amount} base units of ${body.assetId} (tx ${txid.slice(0, 8)}…)`)
      return { txid }
    } catch (err) {
      if (err instanceof TimeoutError) {
        throw new HttpError(504, 'The payment did not finish in time. It may still go through: check the transfers before paying again.')
      }
      throw err
    }
  })

  app.post(PARTY_ROUTES.walletRefresh, async () => {
    await wallet.get().refresh()
    return { ok: true }
  })

  app.get(PARTY_ROUTES.walletTransfers, async (req): Promise<TransferSummary[]> => {
    onlyThisLaptop(req)
    return wallet.get().transfers(parse(TransfersQuerySchema, req.query).assetId)
  })

  app.post(PARTY_ROUTES.walletSign, async (req): Promise<SignResponse> => {
    onlyThisLaptop(req)
    const { message } = parse(SignRequestSchema, req.body)
    const w = wallet.get()
    if (w.sign === undefined) throw new HttpError(501, 'This wallet cannot sign messages')
    return w.sign(message)
  })

  // The client's pre-authorisation, sent by its own UI when it approves a listing.
  app.post(PARTY_ROUTES.autopay, async (req): Promise<AutopayStatus> => {
    onlyThisLaptop(req)
    if (autopay === undefined) throw new HttpError(404, 'Auto-pay is only on the client\'s party server')
    const { escrowId, clientToken } = parse(AutopayRequestSchema, req.body)
    return autopay.authorise(escrowId, clientToken)
  })

  app.get(PARTY_ROUTES.autopay, async (req): Promise<AutopayStatus[]> => {
    onlyThisLaptop(req)
    return autopay?.list() ?? []
  })

  app.addHook('onClose', async () => {
    loop.stop()
    autopay?.stop()
  })
  loop.start() // the first pass starts the wallet; later passes retry it if it failed
  autopay?.start()

  return { app, wallet, loop, autopay, log }
}
