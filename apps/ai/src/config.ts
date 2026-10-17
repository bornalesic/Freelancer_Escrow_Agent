import { existsSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const APP_DIR = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const REPO_ROOT = path.resolve(APP_DIR, '../..');

/** Loads `<repo>/.env.local` if present. Variables already set win (e.g. `cross-env AI_MODE=mock`). */
export function loadEnvLocal(): void {
  const file = path.join(REPO_ROOT, '.env.local');
  if (existsSync(file)) process.loadEnvFile(file);
}

export interface AiConfig {
  port: number;
  host: string;
  mode: 'mock' | 'real';
  /** Model constant names from @qvac/sdk, tried in order until one loads. */
  models: string[];
  device: 'gpu' | 'cpu';
  reasoningBudget: number;
  qvacConfigPath?: string;
  /** Internal budgets; kept below the agent's own timeouts so we always answer (with a fallback) first. */
  parseBudgetMs: number;
  explainBudgetMs: number;
  /** Context window for the whole model; split across `parallel` slots. */
  ctxSize: number;
  parallel: number;
}

// Not env-configurable on purpose (only .env.example vars are allowed). Tuned on the GTX 1650 4 GB.
const CTX_SIZE = 8192;
const PARALLEL = 2;
const MARGIN_MS = 5000;

function int(v: string | undefined, def: number): number {
  const n = Number.parseInt(v ?? '', 10);
  return Number.isFinite(n) ? n : def;
}

export function readConfig(env: NodeJS.ProcessEnv = process.env): AiConfig {
  const mode = env.AI_MODE?.trim() === 'real' ? 'real' : 'mock';
  const models = [env.AI_MODEL, env.AI_FALLBACK_MODEL]
    .map((m) => m?.trim())
    .filter((m): m is string => !!m);
  const qvacConfigPath = env.QVAC_CONFIG_PATH?.trim();
  return {
    port: int(env.AI_PORT, 4300),
    host: env.AI_HOST?.trim() || '0.0.0.0',
    mode,
    models: models.length ? [...new Set(models)] : ['QWEN3_5_2B_MULTIMODAL_Q4_K_M'],
    device: env.AI_DEVICE?.trim() === 'cpu' ? 'cpu' : 'gpu',
    reasoningBudget: int(env.AI_REASONING_BUDGET, 0),
    qvacConfigPath: qvacConfigPath ? path.resolve(APP_DIR, qvacConfigPath) : undefined,
    parseBudgetMs: Math.max(5000, int(env.AI_PARSE_TIMEOUT_MS, 90_000) - MARGIN_MS),
    explainBudgetMs: Math.max(3000, int(env.AI_EXPLAIN_TIMEOUT_MS, 30_000) - MARGIN_MS),
    ctxSize: CTX_SIZE,
    parallel: PARALLEL,
  };
}
