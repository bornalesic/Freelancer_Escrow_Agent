import type { ClarifyQuestion, ClarifyRequest, ClarifyResult } from '@escrow/shared';
import { runAssist, sentence, str, type AssistDeps } from './assist.ts';
import { CLARIFY_OUTPUT_SCHEMA, CLARIFY_SYSTEM, clarifyUserPrompt } from './assistPrompts.ts';
import { findTarget, literalExamples } from './examples.ts';
import { TESTS_PASS, fileTokensIn } from './fallback.ts';

// POST /assist/clarify: up to 3 interview questions before the agreement is parsed. Code knows the common
// gaps (language, how it is checked, an example, output format, input size) and drops any model question
// whose answer is already in the agreement or that is about money/time. The answers are appended to the
// agreement as "Details" lines (withInterviewAnswers in @escrow/shared), so they become part of the terms.

type Question = Omit<ClarifyQuestion, 'id'>;

const CODE = /\b(?:function|script|program|app|api|library|module|cli|command[- ]line|bot|algorithm|class|method|code|parser|tool|backend|server|endpoint)\b/i;
const LANGUAGE = /\b(?:java\s?script|typescript|node(?:\.?js)?|python|java|ruby|rust|golang|go|c\+\+|c#|php|kotlin|swift|bash|shell|sql|html|css|react|vue|svelte)\b|\.(?:[mc]?js|ts|py|rb|rs|go|java|php|sh)\b/i;
const WEB = /\b(?:website|web ?site|landing|page|html|css|logo|design)\b/i;
const OUTPUT = /\b(?:exports?|generates?|reports?|outputs?|converts?|saves?|produces?)\b/i;
const FORMAT = /\b(?:json|csv|xml|html|pdf|png|jpe?g|svg|markdown|txt|plain text|text|string|yaml|xlsx?|excel|slug|number)\b/i;
const INPUT = /\b(?:files?|data|dataset|csv|logs?|images?|photos?|videos?|documents?|records|rows)\b/i;
const PROCESS = /\b(?:process(?:es)?|parses?|reads?|imports?|uploads?|handles?|loads?|converts?)\b/i;
const SIZE = /\b(?:\d+\s*(?:kb|mb|gb|rows|lines|records|files)|small|large|big|huge|size)\b/i;
// Payment and deadline are set on the form. Not "budget": "a budget overview" is a deliverable.
const ABOUT_MONEY = /\b(?:pay|paid|payment|price|cost|usdt|tusdt|deadline|due date|how much|how long)\b/i;

/** Gaps the code can see, in priority order. */
export function knownGaps(rawText: string): Question[] {
  const gaps: Question[] = [];
  const code = CODE.test(rawText) && !WEB.test(rawText);
  const target = findTarget(rawText);
  const literal = literalExamples(rawText, target);
  const tests = TESTS_PASS.test(rawText);
  const named = fileTokensIn(rawText).length > 0;
  if (code && !LANGUAGE.test(rawText)) {
    gaps.push({ topic: 'Language', question: 'Which programming language should it be written in?', why: 'The checks run the code, so they need to know the language.', options: ['JavaScript (Node.js)', 'Python', 'TypeScript'] });
  }
  if (!tests && !named && !literal.length) {
    gaps.push({ topic: 'Checking', question: 'How should the finished work be checked?', why: 'Only what can be checked automatically is paid without you reviewing it.', options: ['Included tests must pass', 'Exact example outputs', 'I will review it myself'] });
  }
  if (code && !tests && !literal.length) {
    gaps.push({ topic: 'Example', question: 'Can you give one example input and the exact output you expect, like "abc" → "ABC"?', why: 'An exact example becomes an automatic check instead of something you judge yourself.', options: [] });
  }
  if (OUTPUT.test(rawText) && !FORMAT.test(rawText)) {
    gaps.push({ topic: 'Output format', question: 'What format should the output be in?', why: 'The format decides what an automatic check compares.', options: ['JSON', 'CSV', 'Plain text'] });
  }
  if (INPUT.test(rawText) && PROCESS.test(rawText) && !SIZE.test(rawText)) {
    gaps.push({ topic: 'Input size', question: 'How big are the input files?', why: 'Tests need realistic input sizes and time limits.', options: ['Under 1 MB', '1–100 MB', 'Over 100 MB'] });
  }
  return gaps;
}

/** True when the agreement already answers a question on this topic, or the topic does not apply to it. */
function alreadyAnswered(topic: string, rawText: string): boolean {
  const t = topic.toLowerCase();
  if (/language/.test(t)) return LANGUAGE.test(rawText);
  if (/format/.test(t)) return FORMAT.test(rawText);
  if (/size/.test(t)) return SIZE.test(rawText) || !INPUT.test(rawText); // slugify has no input files
  if (/example/.test(t)) return literalExamples(rawText, findTarget(rawText)).length > 0;
  if (/\b(?:file|name)\b/.test(t)) return fileTokensIn(rawText).length > 0;
  if (/test|check/.test(t)) return TESTS_PASS.test(rawText);
  return false;
}

const sameTopic = (a: string, b: string) => a.toLowerCase().split(/\s+/)[0] === b.toLowerCase().split(/\s+/)[0];

export function cleanQuestions(raw: unknown, rawText: string, notes: string[]): Question[] {
  const items = Array.isArray((raw as { questions?: unknown })?.questions) ? (raw as { questions: unknown[] }).questions : [];
  const out: Question[] = [];
  for (const item of items) {
    const o = (item ?? {}) as Record<string, unknown>;
    const topic = str(o.topic).replace(/[:.?]+$/, '');
    const question = sentence(o.question, 160);
    const why =
      !topic || topic.length > 30 || topic.split(/\s+/).length > 3 ? 'bad topic'
      : !question.endsWith('?') ? 'not a question'
      : ABOUT_MONEY.test(question) || ABOUT_MONEY.test(topic) ? 'about payment or the deadline'
      : alreadyAnswered(topic, rawText) ? 'already answered in the agreement'
      : out.some((x) => sameTopic(x.topic, topic) || x.question === question) ? 'duplicate'
      : '';
    if (why) {
      notes.push(`clarify: dropped ${JSON.stringify(question || topic)} (${why})`);
      continue;
    }
    const options = (Array.isArray(o.options) ? o.options : []).map((x) => str(x)).filter((x) => x && x.length <= 40 && !ABOUT_MONEY.test(x) && !/^(?:free text|other)$/i.test(x)).slice(0, 4);
    out.push({ topic, question, why: sentence(o.why, 160) || 'Your answer makes the checks more precise.', options: [...new Set(options)] });
  }
  return out;
}

const withIds = (qs: Question[]): ClarifyQuestion[] => qs.slice(0, 3).map((q, i) => ({ id: `q${i + 1}`, ...q }));

export async function clarifyAgreement(req: ClarifyRequest, deps: AssistDeps): Promise<ClarifyResult> {
  const gaps = knownGaps(req.rawText);
  return runAssist('clarify', deps, () => ({ questions: withIds(gaps) }), async (ask) => {
    const json = await ask({ system: CLARIFY_SYSTEM, user: clarifyUserPrompt(req.title, req.rawText), schema: CLARIFY_OUTPUT_SCHEMA, predict: 350 });
    const notes: string[] = [];
    const model = cleanQuestions(json, req.rawText, notes);
    for (const n of notes) deps.log(`clarify: guard: ${n}`);
    // The two most important code-known gaps, then the model's own questions (job-specific, like "which
    // warm colours?"), then the remaining gaps.
    const own = model.filter((m) => !gaps.some((g) => sameTopic(g.topic, m.topic)));
    return { questions: withIds([...gaps.slice(0, 2), ...own, ...gaps.slice(2)]) };
  });
}
