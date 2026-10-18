import { randomBytes } from 'node:crypto';
import type { HintItem, HintRequest, HintResult, VerificationResult } from '@escrow/shared';
import { runAssist, sentence, type AssistDeps } from './assist.ts';
import { HINT_SYSTEM, hintUserPrompt, perId, textSlot } from './assistPrompts.ts';
import { assertionPair, failingTestNames } from './facts.ts';
import { displayName, type AnyCondition } from './fallback.ts';
import { detectInjection, filesForPrompt, isNoteGrounded } from './review.ts';

// POST /assist/hint: why each failed check failed (written by code from the evidence, always correct) and a
// hint where to look (written by the model from the delivered files, template if it fails a guard).
// Used by the agent's dry run, before anything is submitted. Advice only.

interface Failed {
  condition: AnyCondition;
  result: VerificationResult;
  tests: string[];
  pair?: { actual: string; expected: string };
}

const q = (s: string) => JSON.stringify(s);
const PROMISE = /\b(?:will (?:now )?pass|guarantee[sd]?|paid|payment|approved?|release[sd]?)\b/i;

export function failedChecks(req: HintRequest): Failed[] {
  const byId = new Map(req.escrow.conditions.map((c) => [c.id, c as AnyCondition]));
  return req.results.flatMap((result) => {
    const condition = byId.get(result.conditionId);
    if (result.passed || !condition || condition.kind === 'client_review') return [];
    const out = result.evidence.stdoutTail;
    return [{ condition, result, tests: failingTestNames(out, 2), pair: assertionPair(out) }];
  });
}

function command(c: AnyCondition): string | undefined {
  return c.kind === 'tests_pass' ? c.command : undefined;
}

export function templateWhy(f: Failed): string {
  const { condition: c, result: r } = f;
  const e = r.evidence;
  if (e.error && /timed out/i.test(e.error)) return `The check did not finish in time (${e.error.replace(/\.$/, '')}).`;
  switch (c.kind) {
    case 'tests_pass':
    case 'examples': {
      const test = f.tests[0];
      const values = f.pair ? `: expected ${q(f.pair.expected)} but got ${q(f.pair.actual)}` : '';
      if (test) return `The test ${q(test)} failed${values}.`;
      if (e.error) return `The check could not run: ${e.error.replace(/\.$/, '')}.`;
      return `${c.kind === 'tests_pass' ? `"${c.command}"` : 'The acceptance examples'} failed${e.exitCode !== undefined ? ` with exit code ${e.exitCode}` : ''}${values}.`;
    }
    case 'file_present':
      return `No file in the upload matches ${q(c.pathPattern)}.`;
    case 'file_hash':
      if (e.error) return `${e.error.replace(/\.$/, '')}.`;
      return `${c.fileName ?? 'The upload'} is not the agreed file: its fingerprint starts ${e.actualSha256?.slice(0, 12) ?? '?'}…, the agreed one ${c.sha256.slice(0, 12)}….`;
    case 'client_review':
      return 'The client judges this one.';
  }
}

export function templateHint(f: Failed): string {
  const { condition: c, result: r } = f;
  if (r.evidence.error && /timed out/i.test(r.evidence.error)) return 'Make sure the tests finish quickly and do not wait for input or the network.';
  if (r.evidence.error && /unpack/i.test(r.evidence.error)) return 'Upload a .zip of the project folder, or a single file.';
  switch (c.kind) {
    case 'tests_pass':
      return f.pair
        ? `Change the code so it returns ${q(f.pair.expected)} for this case, then run "${c.command}" in your project folder before submitting.`
        : `Run "${c.command}" in your project folder, fix what fails, and check again.`;
    case 'examples':
      return f.pair
        ? `Change ${c.target.type === 'js_function' ? c.target.export : 'the program'} so this input gives ${q(f.pair.expected)}; "Download acceptance test" runs the same examples on your machine.`
        : 'Download the acceptance test and run it with "node --test" in your project folder to see what fails.';
    case 'file_present':
      return `Add ${displayName(c.pathPattern)} to the top level of your upload.`;
    case 'file_hash':
      return 'Upload the exact agreed file, without changing it.';
    case 'client_review':
      return '';
  }
}

function factLine(f: Failed): string {
  const c = f.condition;
  const parts = [`- ${c.id} (${c.kind}${command(c) ? `, command "${command(c)}"` : ''}): ${c.description}`];
  if (f.tests.length) parts.push(`failing test: ${f.tests.map(q).join(', ')}`);
  if (f.pair) parts.push(`expected ${q(f.pair.expected)}, got ${q(f.pair.actual)}`);
  if (!f.tests.length && !f.pair) parts.push(templateWhy(f));
  return parts.join('; ');
}

const templateItem = (f: Failed): HintItem => ({ conditionId: f.condition.id, why: templateWhy(f), hint: templateHint(f) });

export async function hintDelivery(req: HintRequest, deps: AssistDeps): Promise<HintResult> {
  const failed = failedChecks(req);
  if (!failed.length) return { items: [], source: 'fallback', ms: 0 };
  return runAssist('hint', deps, () => ({ items: failed.map(templateItem) }), async (ask) => {
    if (detectInjection(req.files)) {
      deps.log(`hint ${req.escrow.id}: guard: delivery contains text aimed at the AI; template hints only`);
      return undefined;
    }
    const { fileList, fencedFiles } = filesForPrompt(req.files, randomBytes(4).toString('hex'));
    const ids = failed.map((f) => f.condition.id);
    const json = (await ask({
      system: HINT_SYSTEM,
      user: hintUserPrompt({ facts: failed.map(factLine), fileList, fencedFiles }),
      schema: perId(ids, textSlot('hint')),
      predict: 100 + 140 * ids.length, // 150 cut a two-sentence hint off in the probe
    })) as Record<string, { hint?: unknown } | undefined>;
    return {
      items: failed.map((f) => {
        const hint = sentence(json?.[f.condition.id]?.hint, 300);
        const ok = hint.length >= 10 && isNoteGrounded(hint, req.files) && !PROMISE.test(hint);
        if (!ok) deps.log(`hint ${req.escrow.id} ${f.condition.id}: guard: template instead of ${JSON.stringify(hint)}`);
        return { conditionId: f.condition.id, why: templateWhy(f), hint: ok ? hint : templateHint(f) };
      }),
    };
  });
}
