import path from 'node:path';
import { buildApp } from './app';
import { REPO_ROOT, loadConfig } from './config';
import { log } from './log';
import { errorMessage } from './util';

// Per-laptop config. Variables already set (e.g. by cross-env in dev:mock) win over the file.
try {
  process.loadEnvFile(path.join(REPO_ROOT, '.env.local'));
} catch {
  log.warn('no .env.local found, using defaults and process env');
}

try {
  const config = loadConfig();
  const { app } = await buildApp({ config });
  await app.listen({ host: '0.0.0.0', port: config.port });
  log.info(
    `escrow agent on :${config.port} · wallet=${config.walletMode} · network=${config.network} · ai=${config.aiUrl} · data=${config.dataDir}`,
  );
  const shutdown = () => {
    log.info('shutting down');
    app.close().finally(() => process.exit(0));
  };
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
} catch (err) {
  log.error(`failed to start: ${errorMessage(err)}`);
  process.exit(1);
}
