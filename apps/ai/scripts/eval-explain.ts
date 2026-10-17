// Runs the demo's event sequence (fail-then-pass) through /explain/sync and prints every explanation.
//   npm run eval:explain -w apps/ai            # against the running service (AI_URL)
// Read the output: every line must be true, short, and say nothing the event does not say.
import type { Escrow, ExplainSyncResult, LogEvent } from '@escrow/shared';
import { loadEnvLocal } from '../src/config.ts';
import { EXPLAIN_PROMPT_VERSION } from '../src/prompts.ts';

loadEnvLocal();
const base = (process.env.AI_URL ?? 'http://localhost:4300').replace(/\/$/, '');

const tapFail = `TAP version 13
ok 1 - lowercases text
ok 2 - replaces spaces with dashes
not ok 3 - strips punctuation: "Hello, World!" → "hello-world"
ok 4 - keeps numbers
# tests 4
# pass 3
# fail 1`;

const escrow: Escrow = {
  id: 'esc_7f3a', title: 'Slugify function', rawText: 'Build slugify...', amount: '50000000',
  assetId: 'rgb:demo', assetTicker: 'tUSDT', precision: 6, deadline: '2026-10-17T12:30:00Z', state: 'FUNDED',
  summary: 'A slugify function.', clarifications: [],
  conditions: [
    { id: 'c1', kind: 'tests_pass', description: 'All the included tests must pass.', command: 'npm test', timeoutSec: 60 },
    { id: 'c2', kind: 'file_present', description: 'A README file must be included.', pathPattern: 'README*' },
  ],
  acceptances: [],
  deliveries: [{ n: 1, fileName: 'slugify-v1.zip', sha256: 'a'.repeat(64), sizeBytes: 1200, at: '2026-10-17T12:05:00Z' }],
  createdAt: '2026-10-17T12:00:00Z', updatedAt: '2026-10-17T12:05:00Z',
};

let seq = 0;
const ev = (type: LogEvent['type'], actor: LogEvent['actor'], title: string, data?: Record<string, unknown>): LogEvent => ({
  id: `esc_7f3a:${String(++seq).padStart(4, '0')}`, escrowId: 'esc_7f3a', at: new Date().toISOString(),
  actor, type, title, data, explain: true,
});
const v2 = { ...escrow, deliveries: [...escrow.deliveries, { ...escrow.deliveries[0]!, n: 2, fileName: 'slugify-v2.zip' }] };

const steps: [LogEvent, Escrow][] = [
  [ev('escrow.created', 'client', 'Escrow created'), escrow],
  [ev('terms.proposed', 'ai', 'Terms proposed: 2 conditions'), escrow],
  [ev('terms.accepted', 'freelancer', 'Freelancer accepted the terms', { role: 'freelancer' }), escrow],
  [ev('terms.agreed', 'agent', 'Both parties agreed'), escrow],
  [ev('funding.invoice_created', 'wallet', 'Funding invoice created'), escrow],
  [ev('funding.settled', 'wallet', 'Funds locked', { txid: 'f'.repeat(64) }), escrow],
  [ev('delivery.received', 'freelancer', 'Delivery #1 received', { n: 1, fileName: 'slugify-v1.zip' }), escrow],
  [ev('verify.condition_result', 'verifier', 'c1 failed', { conditionId: 'c1', passed: false, evidence: { exitCode: 1, stdoutTail: tapFail, durationMs: 900 } }), escrow],
  [ev('verify.condition_result', 'verifier', 'c2 passed', { conditionId: 'c2', passed: true, evidence: { matched: ['README.md'], durationMs: 3 } }), escrow],
  [ev('verify.finished', 'verifier', '1 of 2 conditions passed', { results: [
    { conditionId: 'c1', passed: false, evidence: { durationMs: 900 } },
    { conditionId: 'c2', passed: true, evidence: { durationMs: 3 } }] }), escrow],
  [ev('decision.made', 'agent', 'Decision: retry', { decision: { action: 'retry', reason: 'Condition c1 failed; the deadline has not passed.', failed: ['c1'] } }), escrow],
  [ev('delivery.received', 'freelancer', 'Delivery #2 received', { n: 2, fileName: 'slugify-v2.zip' }), v2],
  [ev('verify.finished', 'verifier', '2 of 2 conditions passed', { results: [
    { conditionId: 'c1', passed: true, evidence: { durationMs: 850 } },
    { conditionId: 'c2', passed: true, evidence: { durationMs: 2 } }] }), v2],
  [ev('decision.made', 'agent', 'Decision: release', { decision: { action: 'release', reason: 'All conditions passed.' } }), v2],
  [ev('payout.sent', 'wallet', 'Payout sent', { txid: 'e'.repeat(64) }), v2],
  [ev('payout.settled', 'wallet', 'Payout settled'), v2],
];

console.log(`prompt ${EXPLAIN_PROMPT_VERSION}, ${steps.length} events against ${base}\n`);
let ai = 0;
for (const [event, esc] of steps) {
  const t0 = Date.now();
  const res = await fetch(`${base}/explain/sync`, {
    method: 'POST', headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ event, escrow: esc }), signal: AbortSignal.timeout(40_000),
  });
  const r = (await res.json()) as ExplainSyncResult;
  if (r.source === 'ai') ai++;
  console.log(`${event.type.padEnd(24)} ${String(Date.now() - t0).padStart(5)} ms  ${r.source.padEnd(8)} ${r.text}`);
}
console.log(`\n${ai}/${steps.length} from the model (the rest used templates)`);
