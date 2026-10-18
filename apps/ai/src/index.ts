import { assistHandlers } from './assistHandlers.ts';
import { loadEnvLocal, readConfig, type AiConfig } from './config.ts';
import { examplesInContract } from './examples.ts';
import { explainEvent } from './explain.ts';
import type { QvacEngine } from './llm.ts';
import { mockHandlers } from './mock.ts';
import { parseAgreement } from './parse.ts';
import { reviewDelivery } from './review.ts';
import { buildServer, type AiHandlers } from './server.ts';

const log = (msg: string) => console.log(`${new Date().toISOString().slice(11, 23)} ${msg}`);

function realHandlers(cfg: AiConfig, engine: QvacEngine, examples: boolean): AiHandlers {
  const exampleModel = examples && cfg.examples === 'model';
  return {
    health: () => {
      const s = engine.status();
      return { ok: true, model: s.model, loaded: s.loaded, device: s.device, mode: 'real', loading: s.loading, progress: s.progress, error: s.error, queued: s.queued };
    },
    parse: (req) => parseAgreement(req, { engine, budgetMs: cfg.parseBudgetMs, log, examples, exampleModel }),
    explain: (req, onDelta, signal) => explainEvent(req, { engine, budgetMs: cfg.explainBudgetMs, log }, onDelta, signal),
    review: (req) => reviewDelivery(req, { engine, budgetMs: cfg.reviewBudgetMs, log }),
    assist: assistHandlers({ engine, budgetMs: cfg.assistBudgetMs, log, examples }),
  };
}

loadEnvLocal();
const cfg = readConfig();
// `examples` checks only once the verifier can run them: AI_EXAMPLES not off AND the kind is in ConditionSchema.
const examples = cfg.examples !== 'off' && examplesInContract();
// The SDK resolves QVAC_CONFIG_PATH against the cwd; pin it to apps/ai so it works from any directory.
if (cfg.qvacConfigPath) process.env.QVAC_CONFIG_PATH = cfg.qvacConfigPath;

let engine: QvacEngine | undefined;
let handlers: AiHandlers;
if (cfg.mode === 'real') {
  const { QvacEngine } = await import('./llm.ts');
  engine = new QvacEngine(cfg, log);
  handlers = realHandlers(cfg, engine, examples);
} else {
  handlers = mockHandlers({ examples });
}

const app = await buildServer(handlers, log);
await app.listen({ port: cfg.port, host: cfg.host });
log(`ai: listening on http://${cfg.host}:${cfg.port} (AI_MODE=${cfg.mode}${cfg.mode === 'real' ? `, models ${cfg.models.join(' > ')}, device ${cfg.device}` : ''})`);
log(`ai: budgets parse ${cfg.parseBudgetMs} ms, explain ${cfg.explainBudgetMs} ms, review ${cfg.reviewBudgetMs} ms, assist ${cfg.assistBudgetMs} ms`);
log(`ai: example checks ${examples ? (cfg.examples === 'model' ? 'on, model proposes cases too (AI_EXAMPLES=model; not safe with the 2B)' : 'on, examples written in the agreement')
  : cfg.examples === 'off' ? 'off (AI_EXAMPLES=off)' : 'off (the `examples` kind is not in ConditionSchema yet)'}`);
void engine?.load(); // /health reports loaded:false until the model is ready

let stopping = false;
async function stop(signal: string) {
  if (stopping) return;
  stopping = true;
  log(`ai: ${signal}, shutting down`);
  const force = setTimeout(() => process.exit(1), 5000);
  await app.close().catch(() => {});
  await engine?.shutdown();
  clearTimeout(force);
  process.exit(0);
}
process.on('SIGINT', () => void stop('SIGINT'));
process.on('SIGTERM', () => void stop('SIGTERM'));
