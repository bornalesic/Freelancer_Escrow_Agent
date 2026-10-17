// The agent's /config (asset id, ticker, precision, network). Fetched once and shared by all callers;
// retried on the next call if it failed (e.g. agent started after the page).
import { useEffect, useState } from 'react';
import type { AgentConfig } from '@escrow/shared';
import { config } from '../config';
import { fixtureEscrow } from '../fixtures/snapshot';
import { agentApi } from './api';

const FIXTURE_CONFIG: AgentConfig = {
  assetId: fixtureEscrow.assetId,
  assetTicker: fixtureEscrow.assetTicker,
  precision: fixtureEscrow.precision,
  network: 'regtest',
};

let pending: Promise<AgentConfig> | undefined;

function load(): Promise<AgentConfig> {
  if (config.fixture) return Promise.resolve(FIXTURE_CONFIG);
  pending ??= agentApi.config().catch((err) => {
    pending = undefined;
    throw err;
  });
  return pending;
}

export function useAgentConfig(): AgentConfig | undefined {
  const [cfg, setCfg] = useState<AgentConfig>();
  useEffect(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const attempt = () =>
      load().then(
        (c) => !stopped && setCfg(c),
        () => {
          if (!stopped) timer = setTimeout(attempt, 3_000);
        },
      );
    void attempt();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  }, []);
  return cfg;
}
