import type { Condition, ParseRequest, ParseResult } from '@escrow/shared';

// Deterministic regex parser. Used when the model is not loaded, times out, or fails validation twice.
// It must never invent anything: every condition comes from literal text.

export type DraftCondition = Condition extends infer C ? (C extends Condition ? Omit<C, 'id'> : never) : never;

export const DEFAULT_TEST_COMMAND = 'npm test';
export const DEFAULT_TIMEOUT_SEC = 60;
export const MISSING_HASH_NOTE = 'A file hash check was mentioned, but no exact 64-character SHA-256 value was given, so it cannot be checked automatically.';
export const NO_CONDITIONS_NOTE = 'No machine-checkable condition was found. Add one, for example "the included tests must pass" or "include a README".';

const HEX64 = /(?<![0-9a-fA-F])[0-9a-fA-F]{64}(?![0-9a-fA-F])/g;
const FILE_TOKEN = /(?<![\w.-])(?:[\w-]+\/)*[\w-]+\.[A-Za-z][A-Za-z0-9]{0,7}(?![\w-])|\b(?:README|LICENSE|CHANGELOG|Dockerfile|Makefile)\b/g;
const NAMED_GLOBS: Record<string, string> = { readme: 'README*', license: 'LICENSE*', changelog: 'CHANGELOG*' };
const FILE_VERBS = /\b(include|includes|including|included|add|adds|provide|contain|contains|ship|with|plus|create|deliver|write|also)\b/i;
const TESTS_PASS = /\btests?\b[^.;]*\b(pass|passes|passing|succeed|succeeds|green)\b|\bpass(?:es|ing)?\b[^.;]*\btests?\b|`[^`]+`\s+(?:must|should|has to|needs to)\s+(?:pass|succeed)/i;
const COMMAND = /`((?:npm|pnpm|yarn|npx|node|pytest|python|cargo|go|make|deno|bun)\b[^`]*)`|\b((?:npm|pnpm|yarn) (?:run [\w:.-]+|test(?::[\w.-]+)?)|pytest|cargo test|go test(?: \.\/\.\.\.)?|make [\w-]+)\b/i;
const TEST_TIMEOUT = /\b(?:within|under|in less than|in under)\s+(\d+)\s*(seconds?|secs?|s|minutes?|mins?)\b/i;
export const HASH_WORDS = /\b(sha-?256|sha|hash|checksum|fingerprint)\b/i;
export const MONEY_OR_TIME = /\b(pay|paid|payment|usdt|tusdt|price|budget|deadline|due)\b/i;
export { TESTS_PASS };
const SUBJECTIVE = /\b(nice|nicer|beautiful|pretty|good|great|clean|quality|professional|modern|polished|elegant|intuitive|user[- ]friendly|fast|smooth|responsive|well[- ](?:written|designed|structured|documented)|easy to (?:use|read)|readable|maintainable|awesome|amazing|sleek|attractive|appealing|feel|feels|look|looks)\b/i;

function sentences(text: string): string[] {
  return text.split(/(?<=[.!?])\s+|\n+/).map((s) => s.trim()).filter(Boolean);
}

function clauses(sentence: string): string[] {
  return sentence.split(/;\s*|,\s*(?:and|but)\s+|\s+but\s+/).map((s) => s.trim()).filter(Boolean);
}

function fileGlob(token: string): string {
  return NAMED_GLOBS[token.toLowerCase()] ?? token;
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

export function conditionKey(c: DraftCondition | Condition): string {
  switch (c.kind) {
    case 'tests_pass': return `tests_pass:${c.command}`;
    case 'file_hash': return `file_hash:${c.sha256}:${c.fileName ?? ''}`;
    case 'file_present': return `file_present:${c.pathPattern.toLowerCase()}`;
  }
}

/** Deterministic sentence about payment + acceptance, built only from validated conditions. */
export function paymentSentence(req: ParseRequest, conditions: DraftCondition[]): string {
  const amount = `${req.amountDisplay} ${req.assetTicker}`;
  if (!conditions.length) return `The payment is ${amount}, but no automatic checks were found yet.`;
  const parts = conditions.map((c) => {
    switch (c.kind) {
      case 'tests_pass': return c.command === DEFAULT_TEST_COMMAND ? 'the tests pass' : `"${c.command}" passes`;
      case 'file_hash': return `${c.fileName ?? 'the upload'} matches the agreed hash`;
      case 'file_present': return `${displayName(c.pathPattern)} is included`;
    }
  });
  const list = parts.length > 1 ? `${parts.slice(0, -1).join(', ')} and ${parts.at(-1)}` : parts[0];
  return `The freelancer is paid ${amount} once ${list}.`;
}

/** "README*" -> "README", "logo.*" -> "logo", "src/*.ts" -> "src/*.ts" (only trailing wildcards go). */
export function displayName(pattern: string): string {
  return pattern.replace(/(\.\*|\*)+$/, '') || pattern;
}

export type UnclearReason = 'subjective' | 'not_checkable';

/** Clarification text for a quoted piece of the agreement (written by code, never by the model). */
export function clarificationFor(quote: string, reason: UnclearReason): string {
  const q = quote.trim().replace(/[.!,;:]+$/, '');
  const Q = q.charAt(0).toUpperCase() + q.slice(1);
  return reason === 'subjective'
    ? `"${Q}" is subjective, so it cannot be checked automatically.`
    : `"${Q}" has no test or file that can check it automatically.`;
}

function summaryFor(req: ParseRequest, conditions: DraftCondition[]): string {
  const job = req.title.trim();
  return `${job ? `Job "${job}". ` : ''}${paymentSentence(req, conditions)}`;
}

export function fallbackParse(req: ParseRequest): Omit<ParseResult, 'ms'> {
  const d = fallbackDraft(req);
  const clarifications = d.unclear.map((u) => clarificationFor(u.quote, u.reason));
  if (d.hashMentionedWithoutValue) clarifications.push(MISSING_HASH_NOTE);
  if (!d.conditions.length) clarifications.push(NO_CONDITIONS_NOTE);
  return {
    conditions: d.conditions.map((c, i) => ({ ...c, id: `c${i + 1}` }) as Condition),
    summary: summaryFor(req, d.conditions),
    clarifications: [...new Set(clarifications)].slice(0, 6),
    source: 'fallback',
  };
}

export interface FallbackDraft {
  conditions: DraftCondition[];
  unclear: { quote: string; reason: UnclearReason }[];
  hashMentionedWithoutValue: boolean;
}

/** Everything the regexes can find, before ids/text are attached. Also used to cross-check the model. */
export function fallbackDraft(req: ParseRequest): FallbackDraft {
  const text = req.rawText;
  const conditions: DraftCondition[] = [];
  const unclear: FallbackDraft['unclear'] = [];
  const keys = new Set<string>();
  const add = (c: DraftCondition) => {
    const k = conditionKey(c);
    if (!keys.has(k)) { keys.add(k); conditions.push(c); }
  };

  const hashed = hashConditions(text);

  for (const sentence of sentences(text)) {
    let produced = false;
    if (TESTS_PASS.test(sentence)) { add(testsCondition(sentence)); produced = true; }

    if (FILE_VERBS.test(sentence)) {
      for (const m of sentence.matchAll(FILE_TOKEN)) {
        const token = m[0];
        if (/^(e\.g|i\.e)$/i.test(token) || hashed.files.has(token)) continue;
        const glob = fileGlob(token);
        add({ kind: 'file_present', description: `A file named ${displayName(glob)} must be included.`, pathPattern: glob });
        produced = true;
      }
    }

    if (MONEY_OR_TIME.test(sentence) && !produced) continue;
    for (const clause of clauses(sentence)) {
      if (SUBJECTIVE.test(clause) && !TESTS_PASS.test(clause) && !MONEY_OR_TIME.test(clause)) {
        unclear.push({ quote: clause.length > 100 ? `${clause.slice(0, 97)}...` : clause, reason: 'subjective' });
      }
    }
  }
  hashed.conditions.forEach(add);

  return { conditions, unclear, hashMentionedWithoutValue: HASH_WORDS.test(text) && hashed.conditions.length === 0 };
}
