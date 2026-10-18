// npm run demo:reset [-- --jobs-only] [-- the demo:setup options]
//
// Agent laptop. Starts the demo from zero: forgets every job (the agent's store in AGENT_DATA_DIR and the
// party servers' auto-pay state in apps/party/data), wipes this laptop's wallets (RGB_DATA_DIR/<treasury,
// agent, client, freelancer>), their mnemonics and ESCROW_ASSET_ID in .env.local, and the mock ledger,
// then runs demo:setup. Wallets on other laptops are kept; they simply receive the new asset.
// --jobs-only: forget the jobs, keep the wallets and their money (no demo:setup). Run it on every laptop
// whose party servers should forget old auto-payments.
//
// The agent keeps its jobs across restarts on purpose (a crash must not lose money in escrow), so a
// restarted server shows old jobs until they are cleared here.
//
// Fresh mnemonics on purpose: a wiped dataDir opened again with the old mnemonic gets its BTC back but
// not its RGB state, which lives only in the dataDir.
//
// Refuses while the agent or a party server runs on this laptop: wiping a wallet another process has
// open loses its RGB state.

import { existsSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

import {
  REPO_ROOT,
  env,
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

function forgetJobs(): void {
  step('Forget every job')
  // Same defaults as apps/agent/src/config.ts and apps/party/src/config.ts.
  const dirs = [resolve(REPO_ROOT, env('AGENT_DATA_DIR') ?? './apps/agent/data'), join(REPO_ROOT, 'apps', 'party', 'data')]
  for (const dir of dirs) {
    if (!existsSync(dir)) continue
    rmSync(dir, { recursive: true, force: true })
    say(`removed ${dir}`)
  }
  say('Browsers keep their old job tokens; they are harmless and ignored.')
}

export async function resetDemo(argv: string[]): Promise<void> {
  const args = parseArgs(argv)
  const envFile = envFileFrom(args)
  loadEnv(envFile)

  const ports = [intEnv('AGENT_PORT', 4000), 4101, 4102]
  for (const port of ports) {
    if (await portInUse(port)) throw new Error(`something is listening on :${port}. Stop the agent and party servers on this laptop first`)
  }

  forgetJobs()
  if (args.has('jobs-only')) {
    say('--jobs-only: wallets kept. Start the servers again.')
    return
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

  await setupDemo(argv)
}

runIfMain(import.meta.url, 'demo:reset', resetDemo)
