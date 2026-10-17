// npm run setup:role -- --role client|freelancer
//
// Client or freelancer laptop, before its party server's first start with WALLET_MODE=real. Creates the
// role's mnemonic in .env.local if there is none (never printed), opens the wallet and prints its BTC
// address for the agent laptop:   npm run demo:setup -- --<role>-address <address>
// Once that BTC has arrived, running this again creates the UTXOs and prints the balances -- or just
// start the party server, which creates them itself.
//
// Refuses while this role's party server is running: two processes must never open one wallet.
// Option: --env-file <path> (default .env.local).

import {
  ensureMnemonics,
  env,
  envFileFrom,
  intEnv,
  loadEnv,
  mnemonicKey,
  openRoleWallet,
  parseArgs,
  portInUse,
  requiredEnv,
  runIfMain,
  say,
  step,
  stringArg,
  waitForIndexer,
  warnIfLocalhost,
} from './demo-lib.ts'

export async function setupRole(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const envFile = envFileFrom(args)
  loadEnv(envFile)
  const role = stringArg(args, 'role') ?? env('ROLE')
  if (role !== 'client' && role !== 'freelancer') throw new Error('--role must be client or freelancer')

  // PARTY_PORT in .env.local belongs to this laptop's ROLE; for another --role use that role's default.
  const port = env('ROLE') === role ? intEnv('PARTY_PORT', role === 'client' ? 4101 : 4102) : role === 'client' ? 4101 : 4102
  if (await portInUse(port)) {
    throw new Error(`something is listening on :${port} (the ${role} party server?). Stop it first: two processes must never open one wallet`)
  }
  for (const name of ['RGB_INDEXER_URL', 'RGB_TRANSPORT_ENDPOINT']) {
    warnIfLocalhost(name, 'On a party laptop this must point at the agent laptop\'s LAN IP (docs/INTEGRATION_PLAN.md, Phase 3).')
  }

  step('Indexer')
  const indexer = requiredEnv('RGB_INDEXER_URL')
  await waitForIndexer(indexer, 30_000)
  say(`${indexer} answers`)

  step(`${role} wallet`)
  const created = await ensureMnemonics(envFile, [mnemonicKey(role)])
  if (created.length > 0) say(`new mnemonic saved to ${envFile} (not printed)`)
  const { wallet, funded } = await openRoleWallet(role)
  try {
    const info = await wallet.info()
    say(`address   ${info.address}  (a fresh one on every run; all of them belong to this wallet)`)
    say(`BTC       ${info.btcBalanceSat} sat`)
    if (!funded) {
      step('Next')
      say(`On the agent laptop:  npm run demo:setup -- --${role}-address ${info.address}`)
      say('Then start this laptop\'s party server (WALLET_MODE=real): it creates the UTXOs once the BTC arrives.')
      return
    }
    say(`free UTXOs ${await wallet.freeUtxoCount()}`)
    for (const asset of await wallet.listAssets()) {
      say(`${(asset.ticker ?? asset.assetId).padEnd(9)} ${asset.settled} base units settled`)
    }
  } finally {
    wallet.dispose()
  }
}

runIfMain(import.meta.url, 'setup:role', setupRole)
