// Canned QVAC assist answers for `?fixture=1` (UI work without an agent). Test data only: simple keyword
// rules that mimic what apps/ai returns, so every assist screen can be looked at. Schema-checked in
// assist.test.ts.
import {
  isAutomaticCondition, verifiability,
  type AnswerRequest, type AnswerResult, type ClarifyQuestion, type ClarifyRequest, type ClarifyResult,
  type DryRunResponse, type EstimateRequest, type EstimateResult, type JobSize, type MatchRequest, type MatchResult,
  type RewriteRequest, type RewriteResult, type RewriteSuggestion, type SplitRequest, type SplitResult,
} from '@escrow/shared';
import type { AssistName, AssistTypes } from '../lib/assist';
import { fixtureViews } from './snapshot';

const meta = { source: 'ai' as const, model: 'fixture', ms: 640 };
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function clarify(req: ClarifyRequest): ClarifyResult {
  const text = req.rawText.toLowerCase();
  const qs: Omit<ClarifyQuestion, 'id'>[] = [];
  if (!/javascript|typescript|python|node|html|css/.test(text)) {
    qs.push({ topic: 'Language', question: 'Which programming language should it be written in?', why: 'The checks run the code, so they need to know the language.', options: ['JavaScript (Node.js)', 'Python', 'TypeScript'] });
  }
  if (!/tests? must pass|→|becomes|returns "/.test(text) && /function|script|tool|program/.test(text)) {
    qs.push({ topic: 'Example', question: 'Can you give one example input and the exact output you expect, like "abc" → "ABC"?', why: 'An exact example becomes an automatic check instead of something you judge yourself.', options: [] });
  }
  if (/colou?rs?/.test(text) && !/orange|red|yellow|brown|cream|gold|#[0-9a-f]{3}/.test(text)) {
    qs.push({ topic: 'Colours', question: 'Which warm colours do you have in mind?', why: 'Named colours make the review easier to judge.', options: ['Orange and cream', 'Red and gold', 'Brown and beige'] });
  }
  return { questions: qs.slice(0, 3).map((q, i) => ({ id: `q${i + 1}`, ...q })), ...meta };
}

const RULES: { when: RegExp; rewrite: string; becomes: RewriteSuggestion['becomes'] }[] = [
  { when: /docs?|documentation|readme/i, rewrite: 'Include a README.md file that explains how to install and use it.', becomes: 'file_present' },
  { when: /clean code|code clean|readable|quality|tidy/i, rewrite: '`npm run lint` must pass.', becomes: 'tests_pass' },
  { when: /fast|quick|performance/i, rewrite: 'The included tests must pass within 10 seconds.', becomes: 'tests_pass' },
];

function rewrite(req: RewriteRequest): RewriteResult {
  const suggestions = req.conditions.filter((c) => c.kind === 'client_review').flatMap((c) => {
    const rule = RULES.find((r) => r.when.test(c.description));
    if (!rule) return [];
    const d = c.description.replace(/[.!]+$/, '');
    const at = req.rawText.toLowerCase().indexOf(d.toLowerCase());
    return [{ conditionId: c.id, quote: at >= 0 ? req.rawText.slice(at, at + d.length) : d, rewrite: rule.rewrite, becomes: rule.becomes }];
  });
  return { ...verifiability(req.conditions), suggestions, ...meta };
}

const BANDS: Record<JobSize, { amount: [number, number]; minutes: [number, number] }> = {
  tiny: { amount: [10, 80], minutes: [30, 480] },
  small: { amount: [50, 400], minutes: [120, 4320] },
  medium: { amount: [300, 3000], minutes: [2880, 20160] },
  large: { amount: [2000, 20000], minutes: [20160, 120960] },
};

function estimate(req: EstimateRequest): EstimateResult {
  const t = req.rawText.toLowerCase();
  const size: JobSize = /shop|platform|marketplace|whole app/.test(t) ? 'large' : /website|backend|dashboard|login/.test(t) ? 'medium' : /page|landing|tool|logo/.test(t) ? 'small' : 'tiny';
  const { amount: [low, high], minutes: [tLow, tHigh] } = BANDS[size];
  const offered = BigInt(req.amountDisplay.split('.')[0] || '0');
  const warnings: string[] = [];
  if (offered < BigInt(low)) warnings.push(`${req.amountDisplay} ${req.assetTicker} looks low for a ${size} job (typical ${low}–${high} ${req.assetTicker}).`);
  else if (offered > BigInt(high)) warnings.push(`${req.amountDisplay} ${req.assetTicker} looks high for a ${size} job (typical ${low}–${high} ${req.assetTicker}).`);
  if (req.deadlineMinutes < tLow) warnings.push(`${req.deadlineMinutes} min looks short for a ${size} job.`);
  return { size, reason: `It reads like a ${size} job.`, amount: { low: String(low), high: String(high) }, minutes: { low: tLow, high: tHigh }, warnings, ...meta };
}

function answer(req: AnswerRequest): AnswerResult {
  const words = req.question.toLowerCase().match(/[a-z]{4,}/g) ?? [];
  const sentence = req.rawText.split(/(?<=[.!?])\s+/).find((s) => words.some((w) => !['should', 'does', 'need', 'what', 'have', 'with', 'this'].includes(w) && s.toLowerCase().includes(w)));
  return sentence
    ? { answered: true, answer: `Yes. The terms say: "${sentence.replace(/[.!]+$/, '')}".`, quote: sentence, ...meta }
    : { answered: false, answer: "The terms don't say. Ask the client before you accept.", ...meta };
}

const words = (s: string) => new Set(s.toLowerCase().match(/[a-z+#.]{2,}/g) ?? []);

function match(req: MatchRequest): MatchResult {
  const skills = words(req.skills);
  const ranked = req.jobs.map((j) => {
    const hits = [...skills].filter((w) => words(`${j.title} ${j.rawText}`).has(w));
    const fit = hits.length >= 2 ? 'good' as const : hits.length === 1 ? 'partial' as const : 'poor' as const;
    return { id: j.id, fit, reason: hits.length ? `Matches your skills: ${hits.join(', ')}.` : 'None of your listed skills show up in this job.' };
  });
  const order = { good: 0, partial: 1, poor: 2 };
  return { ranked: ranked.sort((a, b) => order[a.fit] - order[b.fit]), ...meta };
}

function split(req: SplitRequest): SplitResult {
  const load = new Map(req.members.map((m) => [m.name, [] as string[]]));
  for (const c of req.conditions) {
    const want = c.kind === 'client_review' ? /design|css|ui|ux/i : /readme|docs?|license/i.test(c.description) ? /writ|doc|copy/i : /javascript|node|python|code|test|dev/i;
    const fit = req.members.find((m) => want.test(m.skills));
    const least = [...load.entries()].sort((a, b) => a[1].length - b[1].length)[0]![0];
    load.get(fit?.name ?? least)!.push(c.id);
  }
  return {
    assignments: req.members.map((m) => ({
      member: m.name,
      conditionIds: load.get(m.name)!,
      note: load.get(m.name)!.length ? `${m.name} lists ${m.skills.split(',')[0]!.trim()}.` : "Nothing assigned; can review the others' work.",
    })),
    ...meta,
  };
}

const HANDLERS: { [N in AssistName]: (req: AssistTypes[N][0]) => AssistTypes[N][1] } = { clarify, rewrite, estimate, answer, match, split };

export async function fixtureAssist<N extends AssistName>(name: N, body: AssistTypes[N][0]): Promise<AssistTypes[N][1]> {
  await sleep(700);
  return HANDLERS[name](body);
}

/** A practice run: a file named like "...v1..." fails the first automatic check (with a hint), anything else passes. */
export async function fixtureDryRun(escrowId: string, fileName: string): Promise<DryRunResponse> {
  await sleep(1500);
  const escrow = fixtureViews.find((v) => v.escrow.id === escrowId)?.escrow ?? fixtureViews[0]!.escrow;
  const automatic = escrow.conditions.filter(isAutomaticCondition);
  const fails = /v1/i.test(fileName);
  const results = automatic.map((c, i) => ({
    conditionId: c.id,
    passed: !(fails && i === 0),
    evidence: fails && i === 0
      ? { exitCode: 1, durationMs: 840, stdoutTail: '✖ strips punctuation: "Hello, World!" → "hello-world"\n  actual: \'hello,-world!\',\n  expected: \'hello-world\',' }
      : { durationMs: 12 },
  }));
  return {
    results,
    passed: results.filter((r) => r.passed).length,
    total: results.length,
    ...(fails && automatic[0] ? {
      hints: {
        items: [{
          conditionId: automatic[0].id,
          why: 'The test "strips punctuation: \\"Hello, World!\\" → \\"hello-world\\"" failed: expected "hello-world" but got "hello,-world!".',
          hint: 'In slugify.js the function only lowercases and replaces spaces; add .replace(/[^a-z0-9-]/g, "") to strip everything that is not a letter, number or dash.',
        }],
        ...meta,
      },
    } : {}),
  };
}
