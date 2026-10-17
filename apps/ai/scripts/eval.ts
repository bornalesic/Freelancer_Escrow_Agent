// Runs fixtures/agreements.json through /parse and scores each case.
//   npm run eval -w apps/ai                 # against the running service (AI_URL, default http://localhost:4300)
//   npm run eval -w apps/ai -- --fallback   # in-process fallback parser only (no server needed)
// A case passes only if the expectations hold AND the result came from the model (source "ai").
import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { ParseResult } from '@escrow/shared';
import { loadEnvLocal, REPO_ROOT } from '../src/config.ts';
import { checkCase, toParseRequest, type AgreementCase, type AgreementFile } from '../src/evalCheck.ts';
import { fallbackParse } from '../src/fallback.ts';
import { PARSE_PROMPT_VERSION } from '../src/prompts.ts';

loadEnvLocal();
const fallbackOnly = process.argv.includes('--fallback');
const verbose = process.argv.includes('--verbose');
const base = (process.env.AI_URL ?? 'http://localhost:4300').replace(/\/$/, '');
const cases = (JSON.parse(readFileSync(path.join(REPO_ROOT, 'fixtures/agreements.json'), 'utf8')) as AgreementFile).cases;

async function parse(c: AgreementCase): Promise<ParseResult> {
  const req = toParseRequest(c);
  if (fallbackOnly) return { ...fallbackParse(req), ms: 0 };
  const res = await fetch(`${base}/parse`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(req),
    signal: AbortSignal.timeout(120_000),
  });
  if (!res.ok) throw new Error(`HTTP ${res.status}: ${await res.text()}`);
  return (await res.json()) as ParseResult;
}

if (!fallbackOnly) {
  try {
    const h = await (await fetch(`${base}/health`, { signal: AbortSignal.timeout(5000) })).json();
    console.log(`AI service ${base}: ${JSON.stringify(h)}`);
  } catch {
    console.error(`AI service not reachable at ${base}. Start it with "npm run dev:ai" or use --fallback.`);
    process.exit(2);
  }
}
console.log(`prompt ${PARSE_PROMPT_VERSION}, ${cases.length} cases${fallbackOnly ? ' (fallback parser)' : ''}\n`);

let passed = 0;
const latencies: number[] = [];
for (const c of cases) {
  try {
    const r = await parse(c);
    latencies.push(r.ms);
    const fails = checkCase(c, r);
    if (!fallbackOnly && r.source !== 'ai') fails.push(`source=${r.source}`);
    if (!fails.length) passed++;
    const kinds = r.conditions.map((x) => x.kind).join(',') || '-';
    console.log(`${fails.length ? 'FAIL' : 'PASS'}  ${c.id.padEnd(20)} ${String(r.ms).padStart(6)} ms  ${r.source.padEnd(8)} [${kinds}] clar=${r.clarifications.length}`);
    for (const f of fails) console.log(`        - ${f}`);
    if (verbose || fails.length) {
      console.log(`        summary: ${r.summary}`);
      for (const x of r.conditions) console.log(`        ${JSON.stringify(x)}`);
      for (const x of r.clarifications) console.log(`        ? ${x}`);
    }
  } catch (e) {
    console.log(`ERROR ${c.id.padEnd(20)} ${(e as Error).message}`);
  }
}

const sorted = [...latencies].sort((a, b) => a - b);
const avg = latencies.length ? Math.round(latencies.reduce((a, b) => a + b, 0) / latencies.length) : 0;
console.log(`\n${passed}/${cases.length} passed; latency avg ${avg} ms, max ${sorted.at(-1) ?? 0} ms`);
process.exit(passed >= Math.ceil(cases.length * 0.8) ? 0 : 1);
