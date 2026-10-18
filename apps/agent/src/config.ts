import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { WalletMode } from '@escrow/shared';

/** Repo root; relative paths in env (e.g. AGENT_DATA_DIR=./apps/agent/data) resolve against it. */
export const REPO_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../../..');

export interface Config {
  port: number;
  nodeEnv: string;
  dataDir: string;
  walletMode: WalletMode;
  autoMine: boolean;
  aiUrl: string;
  clientPartyUrl?: string;
  verifyDefaultTimeoutSec: number;
  aiParseTimeoutMs: number;
  aiExplainTimeoutMs: number;
  aiReviewTimeoutMs: number;
  /** Agent → apps/ai `/assist/*` (the proxy and the dry run's hints). */
  aiAssistTimeoutMs: number;
  /** AI_EXAMPLES is not `off`: examples written in the agreement become an `examples` check (also in our fallback). */
  examples: boolean;
  /** How long the client has to approve or dispute before the agent releases. */
  reviewWindowSec: number;
  /** How long a taken marketplace listing waits for the client's payment before it reopens. */
  fundingWindowSec: number;
  /** How long a counteroffer waits for the client before it expires (never past the job's deadline). */
  offerWindowSec: number;
  network: string;
  assetId: string;
  assetTicker: string;
  precision: number;
  walletPollMs: number;
  mockSettleMs: number;
  bitcoind: { url?: string; user?: string; pass?: string };
  /** Interval of the background ticker (deadlines, stuck steps). Not an env var. */
  tickMs: number;
}

/** Fallback asset id when WALLET_MODE=mock and ESCROW_ASSET_ID is empty. */
export const MOCK_ASSET_ID = 'mock-tusdt';

type Env = Record<string, string | undefined>;

function str(env: Env, key: string): string | undefined {
  const v = env[key]?.trim();
  return v ? v : undefined;
}

function num(env: Env, key: string, fallback: number): number {
  const v = str(env, key);
  if (v === undefined) return fallback;
  const n = Number(v);
  if (!Number.isFinite(n)) throw new Error(`${key} must be a number, got "${v}"`);
  return n;
}

function bool(env: Env, key: string, fallback: boolean): boolean {
  const v = str(env, key);
  return v === undefined ? fallback : v === 'true' || v === '1';
}

export function loadConfig(env: Env = process.env): Config {
  const walletMode = str(env, 'WALLET_MODE') ?? 'mock';
  if (walletMode !== 'mock' && walletMode !== 'real') {
    throw new Error(`WALLET_MODE must be "mock" or "real", got "${walletMode}"`);
  }
  const assetId = str(env, 'ESCROW_ASSET_ID') ?? (walletMode === 'mock' ? MOCK_ASSET_ID : undefined);
  if (!assetId) throw new Error('ESCROW_ASSET_ID is required when WALLET_MODE=real (run npm run demo:setup)');

  return {
    port: num(env, 'AGENT_PORT', 4000),
    nodeEnv: str(env, 'NODE_ENV') ?? 'development',
    dataDir: path.resolve(REPO_ROOT, str(env, 'AGENT_DATA_DIR') ?? './apps/agent/data'),
    walletMode,
    autoMine: bool(env, 'AUTO_MINE', true),
    aiUrl: (str(env, 'AI_URL') ?? 'http://localhost:4300').replace(/\/$/, ''),
    clientPartyUrl: str(env, 'CLIENT_PARTY_URL')?.replace(/\/$/, ''),
    verifyDefaultTimeoutSec: num(env, 'VERIFY_DEFAULT_TIMEOUT_SEC', 60),
    aiParseTimeoutMs: num(env, 'AI_PARSE_TIMEOUT_MS', 90_000),
    aiExplainTimeoutMs: num(env, 'AI_EXPLAIN_TIMEOUT_MS', 30_000),
    aiReviewTimeoutMs: num(env, 'AI_REVIEW_TIMEOUT_MS', 30_000),
    aiAssistTimeoutMs: num(env, 'AI_ASSIST_TIMEOUT_MS', 20_000),
    examples: str(env, 'AI_EXAMPLES')?.toLowerCase() !== 'off',
    reviewWindowSec: num(env, 'REVIEW_WINDOW_SEC', 120),
    fundingWindowSec: num(env, 'FUNDING_WINDOW_SEC', 600),
    offerWindowSec: num(env, 'OFFER_WINDOW_SEC', 900),
    network: str(env, 'RGB_NETWORK') ?? 'regtest',
    assetId,
    assetTicker: str(env, 'ESCROW_ASSET_TICKER') ?? 'TUSDT', // rgb-lib only accepts upper-case tickers
    precision: num(env, 'ESCROW_ASSET_PRECISION', 6),
    walletPollMs: num(env, 'WALLET_POLL_MS', 2000),
    mockSettleMs: num(env, 'MOCK_SETTLE_MS', 3000),
    bitcoind: {
      url: str(env, 'BITCOIND_RPC_URL'),
      user: str(env, 'BITCOIND_RPC_USER'),
      pass: str(env, 'BITCOIND_RPC_PASS'),
    },
    tickMs: 5000,
  };
}
