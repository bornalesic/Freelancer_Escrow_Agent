// npm run demo:reset [-- the demo:setup options]
//
// Agent laptop. Starts the demo money from zero: wipes this laptop's wallets (RGB_DATA_DIR/<treasury,
// agent, client, freelancer>), their mnemonics and ESCROW_ASSET_ID in .env.local, and the mock ledger,
// then runs demo:setup. Wallets on other laptops are kept; they simply receive the new asset.
//
// Fresh mnemonics on purpose: a wiped dataDir opened again with the old mnemonic gets its BTC back but
// not its RGB state, which lives only in the dataDir.
//
// Refuses while the agent or a party server runs on this laptop: wiping a wallet another process has
// open loses its RGB state.

import { existsSync, rmSync } from 'node:fs'

import {
  envFileFrom,
  intEnv,
  loadEnv,
  mnemonicKey,
  parseArgs,
  portInUse,
  removeEnv,
  runIfMain,
  say,
  step,
  walletDir,
} from './demo-lib.ts'
import { setupDemo } from './setup-demo.ts'

const WALLETS = ['treasury', 'agent', 'client', 'freelancer']

export async function resetDemo(argv: string[]): Promise<void> {
  const envFile = envFileFrom(parseArgs(argv))
  loadEnv(envFile)

  const ports = [intEnv('AGENT_PORT', 4000), 4101, 4102]
  for (const port of ports) {
    if (await portInUse(port)) throw new Error(`something is listening on :${port}. Stop the agent and party servers on this laptop first`)
  }

  step('Wipe this laptop\'s demo wallets')
  for (const name of WALLETS) {
    const dir = walletDir(name)
    if (existsSync(dir)) {
      rmSync(dir, { recursive: true, force: true })
      say(`removed ${dir}`)
    }
  }
  removeEnv(envFile, [...WALLETS.map(mnemonicKey), 'ESCROW_ASSET_ID'])
  say(`removed the mnemonics and ESCROW_ASSET_ID from ${envFile}`)

  const { resolveLedgerPath } = await import('@escrow/wallet')
  const ledger = resolveLedgerPath(process.env['MOCK_LEDGER_PATH'])
  rmSync(ledger, { force: true })
  rmSync(`${ledger}.lock`, { force: true })
  say(`removed the mock ledger ${ledger}`)
  say('Escrows in the agent\'s store are kept: start the agent and POST /dev/reset to clear them.')

  await setupDemo(argv)
}

runIfMain(import.meta.url, 'demo:reset', resetDemo)
