import type { Condition, ExamplesCondition, ParseRequest, ParseResult } from '@escrow/shared';
import { coveredByExamples, literalExamplesDraft, type ExamplesDraft } from './examples.ts';

// Deterministic regex parser. Used when the model is not loaded, times out, or fails validation twice,
// and as a cross-check of the model's output. It must never invent anything: every condition comes
// from literal text.

/** `examples` is not in ConditionSchema until WS3 lands it (docs/AI_ASSIST_PLAN.md); after that this equals Condition. */
export type AnyCondition = Condition | ExamplesCondition;
export type DraftCondition = AnyCondition extends infer C ? (C extends AnyCondition ? Omit<C, 'id'> : never) : never;

export const DEFAULT_TEST_COMMAND = 'npm test';
export const DEFAULT_TIMEOUT_SEC = 60;
export const MISSING_HASH_NOTE = 'A file hash check was mentioned, but no exact 64-character SHA-256 value was given, so it cannot be checked automatically.';
export const NO_CONDITIONS_NOTE = 'No condition was found. Add one, for example "the included tests must pass", "include a README" or something the client will judge.';

const HEX64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const FILE_TOKEN = /(?<![\w.-])(?:[\w-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w-])|\b(?:README|LICENSE|CHANGELOG|Dockerfile|Makefile)\b/g;
const NAMED_GLOBS: Record<string, string> = { readme: 'README*', license: 'LICENSE*', changelog: 'CHANGELOG*' };
const FILE_VERBS = /\b(include|includes|including|included|add|adds|provide|contain|contains|ship|with|plus|create|deliver|write|build|make|also)\b/i;
const README = /\breadme\b/i;
const NO_README = /\b(no|not|without|don'?t need|do not need)\b[^.]*\breadme\b/i;
export const TESTS_PASS = /\btests?\b[^.;]*\b(pass|passes|passing|succeed|succeeds|green)\b|\bpass(?:es|ing)?\b[^.;]*\btests?\b|`[^`]+`\s+(?:(?:must|should|has to|needs to)\s+)?(?:pass|passes|succeed|succeeds)\b/i;
// In backticks any tool counts; in plain text only unambiguous test commands ("make sure" is English).
const COMMAND = /`((?:npm|pnpm|yarn|npx|node|pytest|python|cargo|go|make|deno|bun)\b[^`]*)`|\b((?:npm|pnpm|yarn) (?:run [\w:.-]+|test(?::[\w.-]+)?)|pytest|cargo test|go test(?: \.\/\.\.\.)?)(?![\w:-])/i;
// "any .test.js file under tests/" -> tests/**/*.test.js
const GLOB_PHRASE = /\bany\s+(\.[\w.]+)\s+files?\s+(?:under|in|inside)\s+(?:the\s+)?([\w.-]+(?:\/[\w.-]+)*)\/?/i;
const TEST_TIMEOUT = /\b(?:within|under|in less than|in under)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?)\b/i;
export const HASH_WORDS = /\b(sha-?256|sha|hash|checksum|fingerprint)\b/i;
export const MONEY_OR_TIME = /\b(pay|paid|payment|usdt|tusdt|price|budget|deadline|due)\b/i;
const SUBJECTIVE = /\b(nice|nicer|beautiful|pretty|good|great|clean|quality|professional|modern|polished|elegant|intuitive|user[- ]friendly|fast|faster|quicker|smooth|responsive|well[- ](?:written|designed|structured|documented|organi[sz]ed)|easy to (?:use|read)|readable|maintainable|awesome|amazing|sleek|attractive|appealing|feel|feels|look|looks|colou?rs?)\b/i;
const NOT_YET = /\b(later|tbd|to be (?:decided|confirmed)|will send|i'?ll send|we'?ll (?:see|decide))\b/i;
// A required feature a person checks by trying the delivery ("it has to have a cart and a checkout").
const FEATURE = /\b(has to|have to|must|should|needs?|needs to|want|wants|requires?|required)\b/i;
const ABOUT_TESTS = /\b(tests?|npm|pytest)\b/i;
const HEX_ANY = /[0-9a-f]{64}/i;
// The main "what to build" sentence; judged by the client when nothing else can be checked.
const DELIVERABLE = /^(?:please\s+)?(build|create|make|design|write|develop|implement|code|set up|fix|improve|refactor|translate|draw|deliver)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function clauses(sentence: string): string[] {
  return sentence.split(/;\s*|,\s*(?:and|but)\s+|\s+but\s+/).map((s) => s.trim()).filter(Boolean);
}

function fileGlob(token: string): string {
  return NAMED_GLOBS[token.toLowerCase()] ?? token;
}

/** File names written out in the text ("index.html", "tests/a.test.js", "Dockerfile"), unique, in order. */
export function fileTokensIn(text: string): string[] {
  return [...new Set([...text.matchAll(FILE_TOKEN)].map((m) => m[0]).filter((t) => !/^(e\.g|i\.e)$/i.test(t)))];
}

/** All literal 64-hex strings in the text, lowercased, unique, in order. */
export function hashesIn(text: string): string[] {
  return [...new Set([...text.matchAll(HEX64)].map((m) => m[0].toLowerCase()))];
}

function testsCondition(sentence: string): DraftCondition {
  const cmd = COMMAND.exec(sentence);
  const command = (cmd?.[1] ?? cmd?.[2])?.trim() || DEFAULT_TEST_COMMAND;
  let timeoutSec = DEFAULT_TIMEOUT_SEC;
  const t = TEST_TIMEOUT.exec(sentence);
  if (t) timeoutSec = Math.min(600, Number(t[1]) * (/^m/i.test(t[2]!) ? 60 : 1));
  return {
    kind: 'tests_pass',
    description: command === DEFAULT_TEST_COMMAND ? 'All the included tests must pass.' : `The command "${command}" must pass.`,
    command,
    timeoutSec,
  };
}

/** For each hash, the closest file name mentioned before it (same or previous sentence), if any. */
export function hashConditions(text: string): { conditions: DraftCondition[]; files: Set<string> } {
  const conditions: DraftCondition[] = [];
  const files = new Set<string>();
  const seen = new Set<string>();
  for (const m of text.matchAll(HEX64)) {
    const sha256 = m[0].toLowerCase();
    if (seen.has(sha256)) continue;
    seen.add(sha256);
    const before = text.slice(Math.max(0, m.index! - 200), m.index!);
    const fileName = [...before.matchAll(FILE_TOKEN)].map((f) => f[0]).filter((f) => !/^(e\.g|i\.e)$/i.test(f)).at(-1);
    if (fileName) files.add(fileName);
    conditions.push({
      kind: 'file_hash',
      description: fileName
        ? `The file ${fileName} must exactly match the agreed SHA-256 fingerprint.`
        : 'The uploaded file must exactly match the agreed SHA-256 fingerprint.',
      ...(fileName ? { fileName } : {}),
      sha256,
    });
  }
  return { conditions, files };
}

export function conditionKey(c: DraftCondition | AnyCondition): string {
  switch (c.kind) {
    case 'tests_pass': return `tests_pass:${c.command}`;
    case 'file_hash': return `file_hash:${c.sha256}:${c.fileName ?? ''}`;
    case 'file_present': return `file_present:${c.pathPattern.toLowerCase()}`;
    case 'client_review': return `client_review:${c.description.toLowerCase()}`;
    case 'examples': return `examples:${c.target.type === 'js_function' ? c.target.export : c.target.command}`;
  }
}

/** Deterministic sentence about payment + acceptance, built only from validated conditions. */
export function paymentSentence(req: ParseRequest, conditions: DraftCondition[]): string {
  const amount = `${req.amountDisplay} ${req.assetTicker}`;
  if (!conditions.length) return `The payment is ${amount}, but no conditions were found yet.`;
  const parts = conditions.flatMap((c) => {
    switch (c.kind) {
      case 'tests_pass': return [c.command === DEFAULT_TEST_COMMAND ? 'the tests pass' : `"${c.command}" passes`];
      case 'file_hash': return [`${c.fileName ?? 'the upload'} matches the agreed hash`];
      case 'file_present': return [`${displayName(c.pathPattern)} is included`];
      case 'examples': return [`${c.target.type === 'js_function' ? c.target.export : `"${c.target.command}"`} gives the agreed output for every example`];
      case 'client_review': return [];
    }
  });
  if (conditions.some((c) => c.kind === 'client_review')) parts.push('the client approves what they review');
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `The freelancer is paid ${amount} once ${list}.`;
}

/** "README*" -> "README", "logo.*" -> "logo", "src/*.ts" -> "src/*.ts" (only trailing wildcards go). */
export function displayName(pattern: string): string {
  return pattern.replace(/(\.\*|\*)+$/, '') || pattern;
}

function cleanQuote(quote: string): string {
  const q = quote.trim().replace(/^["']|["']$/g, '').replace(/[.!,;:]+$/, '').trim();
  return q.charAt(0).toUpperCase() + q.slice(1);
}

/** A client_review condition worded from the agreement's own words (stable text, so termsHash is stable). */
export function reviewCondition(quote: string): DraftCondition {
  return { kind: 'client_review', description: `${cleanQuote(quote)}.` };
}

/** Clarification text for something that cannot be agreed yet (written by code, never by the model). */
export function clarificationFor(quote: string): string {
  return `"${cleanQuote(quote)}" cannot be checked or judged as written; agree on the details before accepting.`;
}

function summaryFor(req: ParseRequest, conditions: DraftCondition[]): string {
  const job = req.title.trim();
  return `${job ? `Job "${job}". ` : ''}${paymentSentence(req, conditions)}`;
}

export interface FallbackOptions {
  /** Add an `examples` check (only when the contract and the verifier support it). */
  examples?: boolean;
  /** Examples already proposed (literal + model); default: only the examples written in the agreement. */
  draft?: ExamplesDraft;
}

export function fallbackParse(req: ParseRequest, opts: FallbackOptions = {}): Omit<ParseResult, 'ms'> {
  const d = fallbackDraft(req);
  const examples = opts.examples ? (opts.draft ?? literalExamplesDraft(req.rawText)) : undefined;
  const conditions: DraftCondition[] = [
    ...d.conditions,
    ...(examples ? [examples] : []),
    ...d.review.filter((q) => !coveredByExamples(q, examples)).map(reviewCondition),
  ];
  const clarifications = d.unclear.map(clarificationFor);
  if (d.hashMentionedWithoutValue) clarifications.push(MISSING_HASH_NOTE);
  if (!conditions.length) clarifications.push(NO_CONDITIONS_NOTE);
  return {
    conditions: conditions.map((c, i) => ({ ...c, id: `c${i + 1}` }) as Condition),
    summary: summaryFor(req, conditions),
    clarifications: [...new Set(clarifications)].slice(0, 6),
    source: 'fallback',
  };
}

export interface FallbackDraft {
  conditions: DraftCondition[];       // automatic conditions only
  review: string[];                   // quotes the client will judge (become client_review conditions)
  unclear: string[];                  // quotes that cannot be agreed yet (become clarifications)
  hashMentionedWithoutValue: boolean;
}

/** Everything the regexes can find, before ids/text are attached. Also used to cross-check the model. */
export function fallbackDraft(req: ParseRequest): FallbackDraft {
  const text = req.rawText;
  const conditions: DraftCondition[] = [];
  const review: string[] = [];
  const unclear: string[] = [];
  const keys = new Set<string>();
  const add = (c: DraftCondition) => {
    const k = conditionKey(c);
    if (!keys.has(k)) { keys.add(k); conditions.push(c); }
  };
  const addFile = (token: string) => {
    const glob = fileGlob(token);
    add({ kind: 'file_present', description: `A file named ${displayName(glob)} must be included.`, pathPattern: glob });
  };

  const hashed = hashConditions(text);

  for (const sentence of sentences(text)) {
    let produced = false;
    if (TESTS_PASS.test(sentence)) { add(testsCondition(sentence)); produced = true; }

    if (README.test(sentence) && !NO_README.test(sentence)) { addFile('README'); produced = true; }
    const glob = GLOB_PHRASE.exec(sentence);
    if (glob) {
      const pathPattern = `${glob[2]}/**/*${glob[1]}`;
      add({ kind: 'file_present', description: `At least one ${glob[1]} file must be inside ${glob[2]}/.`, pathPattern });
      produced = true;
    }
    if (FILE_VERBS.test(sentence)) {
      for (const m of sentence.matchAll(FILE_TOKEN)) {
        const token = m[0];
        if (/^(e\.g|i\.e)$/i.test(token) || /^readme(\.|$)/i.test(token) || hashed.files.has(token)) continue;
        addFile(token);
        produced = true;
      }
    }

    if (MONEY_OR_TIME.test(sentence) && !produced) continue;
    for (const clause of clauses(sentence)) {
      if (TESTS_PASS.test(clause) || MONEY_OR_TIME.test(clause)) continue;
      const quote = clause.length > 100 ? `${clause.slice(0, 97)}...` : clause;
      const words = clause.replace(FILE_TOKEN, ' '); // "clean.py" is a file name, not a wish for clean code
      if (SUBJECTIVE.test(words)) review.push(quote);
      else if (!produced && NOT_YET.test(words) && !HASH_WORDS.test(words)) unclear.push(quote);
      else if (!produced && FEATURE.test(words) && !ABOUT_TESTS.test(words) && !HASH_WORDS.test(words) && !HEX_ANY.test(clause)) {
        review.push(quote);
      }
    }
  }
  hashed.conditions.forEach(add);

  // Never leave an escrow with nothing to check: the client judges the main deliverable itself.
  if (!conditions.length && !review.length) {
    const main = sentences(text).find((s) => DELIVERABLE.test(s) && !MONEY_OR_TIME.test(s));
    if (main) review.push(main.length > 100 ? `${main.slice(0, 97)}...` : main);
  }

  return { conditions, review, unclear, hashMentionedWithoutValue: HASH_WORDS.test(text) && hashed.conditions.length === 0 };
}
