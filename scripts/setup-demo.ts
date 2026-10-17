// npm run demo:setup [-- --client-address <bcrt1...>] [-- --freelancer-address <bcrt1...>]
//
// Agent laptop, regtest stack up (scripts/regtest/README.md). Creates the treasury and agent wallets,
// funds them with BTC, creates UTXOs, issues a fresh TUSDT, sends the client 100 and writes
// ESCROW_ASSET_ID (and any new mnemonic) into .env.local. Running it again issues another asset.
//
// One laptop (rehearsal, stage fallback): give no addresses and the client and freelancer wallets are
// created here too. Several laptops: run `npm run setup:role -- --role <role>` on each party laptop,
// pass the addresses it prints, and start the client laptop's party server (WALLET_MODE=real) -- this
// script asks it for the 100 TUSDT invoice at CLIENT_PARTY_URL.
//
// Every wallet gets its BTC from bitcoind's `miner` wallet with sendtoaddress, never by mining to it:
// rgb-lib picks immature coinbase outputs and the broadcast fails (packages/wallet/CLAUDE.md).
// Never prints a mnemonic. Option: --env-file <path> (default .env.local).

import type { InvoiceResponse, PartyHealthResponse, Role, TransferSummary } from '@escrow/shared'

import {
  Bitcoind,
  ensureMnemonics,
  env,
  envFileFrom,
  errorMessage,
  getJson,
  intEnv,
  loadEnv,
  mnemonicKey,
  openRoleWallet,
  parseArgs,
  postJson,
  requiredEnv,
  rgbConnection,
  runIfMain,
  say,
  sleep,
  step,
  stringArg,
  waitForIndexer,
  warnIfLocalhost,
  writeEnv,
  type SetupWallet,
} from './demo-lib.ts'

/** Per wallet and run. Fees and UTXOs take a few thousand sats, so one lasts many runs. */
const FUND_BTC = 1
const PARTY_WAIT_MS = 5 * 60_000
const SETTLE_ROUNDS = 20

type PartyRole = Exclude<Role, 'agent'>

async function waitForClientParty(base: string, btc: Bitcoind): Promise<void> {
  const deadline = performance.now() + PARTY_WAIT_MS
  for (let round = 0; ; round += 1) {
    let health: PartyHealthResponse | undefined
    let problem = ''
    try {
      health = await getJson<PartyHealthResponse>(`${base}/health`)
      problem = health.error ?? 'starting'
    } catch (err) {
      problem = errorMessage(err)
    }
    if (health?.ok === true) {
      if (health.role !== 'client') throw new Error(`CLIENT_PARTY_URL (${base}) is the ${health.role}'s party server`)
      if (health.walletMode !== 'real') throw new Error(`the client party server runs WALLET_MODE=${health.walletMode}; it must be real`)
      return
    }
    if (performance.now() > deadline) throw new Error(`the client party server at ${base} is not ready: ${problem}`)
    if (round % 4 === 0) say(`waiting for the client party server at ${base}: ${problem}`)
    // Its wallet creates its own UTXOs once the BTC is there (retried every 15 s); a block confirms them.
    await btc.mine(1)
    await sleep(5_000)
  }
}

/** The client's invoice from its party server, retrying while its fresh UTXOs still need a block. */
async function clientPartyInvoice(base: string, btc: Bitcoind, assetId: string, amount: string): Promise<InvoiceResponse> {
  await waitForClientParty(base, btc)
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await postJson<InvoiceResponse>(`${base}/wallet/invoice`, { assetId, amount })
    } catch (err) {
      if (attempt === 5) throw err
      say(`no invoice yet (${errorMessage(err)}), mining a block and retrying`)
      await btc.mine(1)
      await sleep(3_000)
    }
  }
}

export async function setupDemo(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const envFile = envFileFrom(args)
  loadEnv(envFile)
  const remote: Record<PartyRole, string | undefined> = {
    client: stringArg(args, 'client-address'),
    freelancer: stringArg(args, 'freelancer-address'),
  }
  const network = env('RGB_NETWORK') ?? 'regtest'
  if (network !== 'regtest') throw new Error(`demo:setup mines blocks, so it only runs on regtest (RGB_NETWORK=${network})`)
  if (remote.client !== undefined || remote.freelancer !== undefined) {
    warnIfLocalhost('RGB_TRANSPORT_ENDPOINT', 'Every invoice carries this address, so wallets on other laptops would post to their own ' +
      'machine. Use this laptop\'s LAN IP (docs/INTEGRATION_PLAN.md, Phase 3).')
  }
  const precision = intEnv('ESCROW_ASSET_PRECISION', 6)
  const ticker = env('ESCROW_ASSET_TICKER') ?? 'TUSDT'
  const unit = 10n ** BigInt(precision)
  const minFree = intEnv('MIN_FREE_UTXOS', 5)
  const btc = new Bitcoind()

  step('1/7 Regtest chain')
  await btc.waitUntilUp()
  await btc.ensureMinerWallet()
  const height = await btc.height()
  if (height < 101) {
    await btc.mine(101 - height)
    say(`mined ${101 - height} blocks so the miner wallet has spendable coins`)
  }
  await waitForIndexer(requiredEnv('RGB_INDEXER_URL'))
  say(`height ${await btc.height()}, indexer answering`)

  step('2/7 Wallets')
  const localRoles: Role[] = ['agent', ...(['client', 'freelancer'] as const).filter((r) => remote[r] === undefined)]
  const created = await ensureMnemonics(envFile, ['treasury', ...localRoles].map(mnemonicKey))
  if (created.length > 0) say(`new mnemonics saved to ${envFile} (not printed): ${created.join(', ')}`)

  const { Treasury } = await import('@escrow/wallet/treasury')
  const treasury = await Treasury.open(rgbConnection('treasury'))
  const wallets = new Map<Role, SetupWallet>()
  try {
    for (const role of localRoles) wallets.set(role, (await openRoleWallet(role)).wallet)

    const addresses = new Map<string, string>([['treasury', treasury.address]])
    for (const [role, wallet] of wallets) addresses.set(role, (await wallet.info()).address)
    for (const role of ['client', 'freelancer'] as const) {
      const address = remote[role]
      if (address !== undefined) addresses.set(role, address)
    }
    for (const [name, address] of addresses) {
      say(`${name.padEnd(10)} ${address}  (${name in remote && remote[name as PartyRole] !== undefined ? 'other laptop' : 'this laptop'})`)
    }

    step('3/7 BTC for every wallet')
    for (const [name, address] of addresses) {
      await btc.send(address, FUND_BTC)
      say(`${FUND_BTC} BTC -> ${name}`)
    }
    await btc.mine(1)

    step('4/7 UTXOs')
    await treasury.ensureUtxos(minFree)
    for (const wallet of wallets.values()) await wallet.init() // funded now: creates the UTXOs
    await btc.mine(1)
    treasury.refresh()
    for (const wallet of wallets.values()) await wallet.refresh()
    say(`free UTXOs: treasury ${treasury.freeUtxoCount()}` +
      (await Promise.all([...wallets].map(async ([role, w]) => `, ${role} ${await w.freeUtxoCount()}`))).join(''))
    for (const role of ['client', 'freelancer'] as const) {
      if (remote[role] !== undefined) say(`the ${role} creates its own UTXOs (its party server or setup:role)`)
    }

    step(`5/7 Issue ${ticker}`)
    const assetId = treasury.issueNia({ ticker, name: 'tUSDT (test)', precision, supply: (1_000_000n * unit).toString() })
    await btc.mine(1)
    treasury.refresh()
    say(`${assetId}, supply 1,000,000`)

    step(`6/7 100 ${ticker} to the client`)
    const amount = (100n * unit).toString()
    const client = wallets.get('client')
    const clientUrl = client === undefined ? requiredEnv('CLIENT_PARTY_URL').replace(/\/$/, '') : undefined
    const invoice = client !== undefined
      ? await client.createInvoice({ assetId, amount })
      : await clientPartyInvoice(clientUrl ?? '', btc, assetId, amount)
    const txid = await treasury.pay({ invoice: invoice.invoice, assetId, amount })
    say(`sent, tx ${txid.slice(0, 16)}...`)

    const clientRows = (): Promise<TransferSummary[]> => client !== undefined
      ? client.transfers(assetId)
      : getJson<TransferSummary[]>(`${clientUrl ?? ''}/wallet/transfers?assetId=${encodeURIComponent(assetId)}`)
    for (let round = 1; ; round += 1) {
      // The recipient's refresh pulls the payment off the proxy; a remote client's party server does that itself.
      if (client !== undefined) await client.refresh()
      treasury.refresh()
      await btc.mine(1)
      if (client !== undefined) await client.refresh()
      treasury.refresh()
      const received = (await clientRows()).find((t) => t.recipientId === invoice.recipientId)
      if (treasury.paymentStatus(assetId, txid) === 'Settled' && received?.status === 'settled') {
        say(`settled after ${round} block(s): the client received ${received.amount} base units`)
        break
      }
      if (round === SETTLE_ROUNDS) {
        throw new Error(`the 100 ${ticker} did not settle after ${SETTLE_ROUNDS} blocks (client side: ${received?.rawStatus ?? 'not seen yet'})`)
      }
      if (client === undefined) await sleep(3_000) // give the party server's refresh loop a turn
    }

    // Receiving the 100 used one of the client's free UTXOs: top every local wallet back up.
    for (const wallet of wallets.values()) await wallet.init()
    await btc.mine(1)
    for (const wallet of wallets.values()) await wallet.refresh()

    step('7/7 Save')
    writeEnv(envFile, { ESCROW_ASSET_ID: assetId })
    say(`ESCROW_ASSET_ID=${assetId}  -> ${envFile}`)
    say(`treasury  ${treasury.assetBalance(assetId).settled} base units, BTC ${treasury.btcSat()} sat`)
    for (const [role, wallet] of wallets) {
      say(`${role.padEnd(9)} ${(await wallet.balance(assetId)).settled} base units, ${await wallet.freeUtxoCount()} free UTXOs`)
    }
    if (remote.client !== undefined || remote.freelancer !== undefined) {
      say('Copy the ESCROW_ASSET_ID line into the client and freelancer laptops\' .env.local as well.')
    }
  } finally {
    for (const wallet of wallets.values()) wallet.dispose()
    treasury.dispose()
  }
}

runIfMain(import.meta.url, 'demo:setup', setupDemo)
