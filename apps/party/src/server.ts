import { join } from 'node:path'

import { buildApp } from './app.ts'
import { REPO_ROOT, loadConfig } from './config.ts'
import { makeLog } from './log.ts'
import { errorMessage } from './util.ts'

const boot = makeLog('party')

// Per-laptop config. Variables already set (ROLE and PARTY_PORT from cross-env in dev:client /
// dev:freelancer) win over the file.
try {
  process.loadEnvFile(join(REPO_ROOT, '.env.local'))
} catch {
  boot.warn('no .env.local found, using defaults and process env')
}

try {
  const config = loadConfig()
  const { app, log } = await buildApp({ config })
  await app.listen({ host: '0.0.0.0', port: config.port })
  log.info(`party server on :${config.port} · role=${config.role} · wallet=${config.walletMode}`)
  const shutdown = () => {
    log.info('shutting down')
    void app.close().finally(() => process.exit(0))
  }
  process.on('SIGINT', shutdown)
  process.on('SIGTERM', shutdown)
} catch (err) {
  boot.error(`failed to start: ${errorMessage(err)}`)
  process.exit(1)
}
