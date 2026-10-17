import { ConditionSchema, type Condition, type ParseRequest } from '@escrow/shared';
import {
  DEFAULT_TEST_COMMAND, DEFAULT_TIMEOUT_SEC, HASH_WORDS, MISSING_HASH_NOTE, MONEY_OR_TIME, NO_CONDITIONS_NOTE, TESTS_PASS,
  clarificationFor, conditionKey, displayName, fallbackDraft, fileTokensIn, paymentSentence, reviewCondition,
  type DraftCondition,
} from './fallback.ts';
import { globToRegExp, hasWildcard } from './glob.ts';

export interface ParseDraft {
  summary: string;
  conditions: Condition[];
  clarifications: string[];
}

export type PostResult =
  | { ok: true; value: ParseDraft; notes: string[] }
  | { ok: false; error: string };

/** Parses the first balanced JSON object in model text (tolerates code fences, chatter or junk after it). */
export function extractJson(text: string): unknown {
  const start = text.indexOf('{');
  if (start < 0) throw new Error('no JSON object in output');
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = start; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === '\\') escaped = true;
      else if (ch === '"') inString = false;
    } else if (ch === '"') inString = true;
    else if (ch === '{') depth++;
    else if (ch === '}' && --depth === 0) return JSON.parse(text.slice(start, i + 1));
  }
  throw new Error('unterminated JSON object (output cut off?)');
}

const KIND_ALIASES: Record<string, 'tests_pass' | 'file_present' | 'file_hash'> = {
  tests_pass: 'tests_pass', test_pass: 'tests_pass', tests: 'tests_pass', test: 'tests_pass',
  file_present: 'file_present', file_exists: 'file_present', file: 'file_present',
  file_hash: 'file_hash', hash: 'file_hash', sha256: 'file_hash',
};
const NAMED_GLOBS: Record<string, string> = { readme: 'README*', license: 'LICENSE*', changelog: 'CHANGELOG*' };

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const norm = (t: string) => t.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const bare = (t: string) => norm(t).replace(/^["']|["']$/g, '').replace(/[.!,;:]+$/, '');
const stem = (pattern: string) => displayName(pattern).replace(/\*/g, '').toLowerCase();
const quotesOf = (v: unknown) =>
  (Array.isArray(v) ? v : []).map((x) => s(typeof x === 'object' && x ? (x as Record<string, unknown>).quote : x)).filter(Boolean);

function normalizePattern(raw: string): string {
  const p = raw.replace(/^\.\//, '').replace(/\.+$/, '');
  const named = NAMED_GLOBS[p.replace(/(\.\*|\*|\.md|\.txt)$/i, '').toLowerCase()];
  return named ?? p;
}

/**
 * A concrete file name must appear whole in the agreement ("tests/test.js" is not grounded by "any .test.js
 * file under tests/"). A glob only needs its literal pieces ("tests", ".test.js" in "tests/**\/*.test.js").
 */
function patternIsGrounded(pattern: string, rawText: string): boolean {
  if (!hasWildcard(pattern)) {
    const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, '\\$&');
    return new RegExp(`(?<![\\w./-])${escaped}(?![\\w/-])`, 'i').test(rawText);
  }
  const text = rawText.toLowerCase();
  const pieces = pattern.toLowerCase().split(/[*/]+/).filter(Boolean);
  return pieces.length > 0 && pieces.every((p) => text.includes(p.replace(/\.$/, '')));
}

const BROAD_GLOBS = new Set(Object.values(NAMED_GLOBS));

/** A fuzzy glob that matches exactly one file named in the agreement becomes that file ("contract.*pdf"). */
function sharpenPattern(pattern: string, rawText: string): string {
  if (!hasWildcard(pattern) || BROAD_GLOBS.has(pattern)) return pattern;
  const re = globToRegExp(pattern);
  const hits = fileTokensIn(rawText).filter((t) => re.test(t));
  return hits.length === 1 ? hits[0]! : pattern;
}

/**
 * Turns raw model output into validated conditions. The model proposes; this function keeps it grounded:
 *  - drops anything not literally supported by the agreement (invented hashes, files, commands, test checks,
 *    quotes), and
 *  - cross-checks against the deterministic parser, adding literal requirements the model missed.
 * The model only points at phrases (`review`, `unclear`); code turns them into client_review conditions and
 * clarification sentences, and writes the payment half of the summary.
 */
export function postprocess(raw: unknown, req: ParseRequest): PostResult {
  const rawText = req.rawText;
  if (!raw || typeof raw !== 'object') return { ok: false, error: 'output is not a JSON object' };
  const o = raw as Record<string, unknown>;
  const deliverable = s(o.deliverable).replace(/\s+/g, ' ');
  if (!deliverable) return { ok: false, error: '"deliverable" must be a non-empty string' };
  if (!Array.isArray(o.conditions)) return { ok: false, error: '"conditions" must be an array' };

  const text = rawText.toLowerCase();
  const testsAgreed = TESTS_PASS.test(rawText);
  const notes: string[] = [];
  const drafts: DraftCondition[] = [];

  // 1. Model conditions (automatic kinds), each checked against the agreement text.
  for (const [i, item] of o.conditions.entries()) {
    if (!item || typeof item !== 'object') return { ok: false, error: `conditions[${i}] is not an object` };
    const c = item as Record<string, unknown>;
    const kind = KIND_ALIASES[s(c.kind).toLowerCase()];
    if (!kind) return { ok: false, error: `conditions[${i}].kind "${s(c.kind)}" is not one of tests_pass, file_present, file_hash` };
    const description = s(c.description);

    if (kind === 'tests_pass') {
      if (!testsAgreed) {
        notes.push(`dropped tests_pass "${s(c.command)}": the agreement does not say tests must pass`);
        continue;
      }
      let command = s(c.command) || DEFAULT_TEST_COMMAND;
      if (command !== DEFAULT_TEST_COMMAND && !text.includes(command.toLowerCase())) {
        notes.push(`replaced invented test command "${command}" with "${DEFAULT_TEST_COMMAND}"`);
        command = DEFAULT_TEST_COMMAND;
      }
      const t = Math.round(Number(c.timeoutSec));
      const timeoutSec = Number.isFinite(t) && t > 0 ? Math.min(600, Math.max(5, t)) : DEFAULT_TIMEOUT_SEC;
      drafts.push({ kind, description: description || 'All the included tests must pass.', command, timeoutSec });
    } else if (kind === 'file_present') {
      const asked = normalizePattern(s(c.pathPattern));
      if (!asked) return { ok: false, error: `conditions[${i}].pathPattern must be a non-empty string` };
      const pathPattern = sharpenPattern(asked, rawText);
      if (pathPattern !== asked) notes.push(`sharpened file_present "${asked}" to "${pathPattern}"`);
      if (!patternIsGrounded(pathPattern, rawText)) {
        notes.push(`dropped file_present "${pathPattern}": that file is not named in the agreement`);
        continue;
      }
      drafts.push({ kind, description: description || `A file named ${displayName(pathPattern)} must be included.`, pathPattern });
    } else {
      const sha256 = s(c.sha256).toLowerCase();
      if (!/^[0-9a-f]{64}$/.test(sha256) || !text.includes(sha256)) {
        notes.push(`dropped file_hash ${sha256.slice(0, 12)}…: hash not literally in the agreement`);
        continue;
      }
      let fileName = s(c.fileName);
      if (fileName && !patternIsGrounded(fileName, rawText)) {
        notes.push(`dropped invented fileName "${fileName}" from file_hash ${sha256.slice(0, 12)}…`);
        fileName = '';
      }
      drafts.push({
        kind, sha256,
        description: description || 'The uploaded file must exactly match the agreed SHA-256 fingerprint.',
        ...(fileName ? { fileName } : {}),
      });
    }
  }

  // 2. Cross-check: literal automatic requirements the regex parser finds but the model missed.
  const fb = fallbackDraft(req);
  for (const f of fb.conditions) {
    // Same hash but the model left out which file it belongs to: take the file named next to it.
    if (f.kind === 'file_hash' && f.fileName) {
      const mine = drafts.find((d) => d.kind === 'file_hash' && d.sha256 === f.sha256);
      if (mine?.kind === 'file_hash' && !mine.fileName) {
        mine.fileName = f.fileName;
        notes.push(`cross-check set fileName "${f.fileName}" on file_hash ${f.sha256.slice(0, 12)}…`);
      }
    }
    const covered =
      f.kind === 'tests_pass' ? drafts.some((d) => d.kind === 'tests_pass')
      : f.kind === 'file_hash' ? drafts.some((d) => d.kind === 'file_hash' && d.sha256 === f.sha256)
      : f.kind === 'file_present' ? drafts.some((d) =>
          (d.kind === 'file_present' && (stem(d.pathPattern).includes(stem(f.pathPattern)) || stem(f.pathPattern).includes(stem(d.pathPattern))))
          || (d.kind === 'file_hash' && d.fileName?.toLowerCase() === stem(f.pathPattern)))
      : true;
    if (!covered) {
      notes.push(`cross-check added ${conditionKey(f)}`);
      drafts.push(f);
    }
  }

  // 3. A file with an agreed hash is necessarily present; drop the redundant presence check.
  const hashedFiles = new Set(drafts.flatMap((d) => (d.kind === 'file_hash' && d.fileName ? [d.fileName.toLowerCase()] : [])));
  const automatic = drafts.filter((d) => !(d.kind === 'file_present' && hashedFiles.has(d.pathPattern.toLowerCase())));

  // 4. Quotes: `review` → client_review conditions, `unclear` → clarifications. Only quotes literally in the
  //    agreement, not about payment/deadline, and not already covered by an automatic check survive.
  const normText = norm(rawText);
  const isCovered = (q: string) =>
    (TESTS_PASS.test(q) && automatic.some((c) => c.kind === 'tests_pass')) ||
    automatic.some((c) => c.kind === 'file_present' && q.includes(stem(c.pathPattern))) ||
    /[0-9a-f]{64}/.test(q);
  const accept = (field: string, quotes: string[]) => {
    const kept: string[] = [];
    for (const quote of quotes) {
      const q = bare(quote);
      if (q.length < 3 || !normText.includes(q)) { notes.push(`dropped ${field} quote not in agreement: ${JSON.stringify(quote)}`); continue; }
      if (MONEY_OR_TIME.test(q)) { notes.push(`dropped ${field} quote about payment/deadline: ${JSON.stringify(quote)}`); continue; }
      if (isCovered(q)) { notes.push(`dropped ${field} quote already covered by a check: ${JSON.stringify(quote)}`); continue; }
      kept.push(quote);
    }
    return kept;
  };
  const merge = (field: string, mine: string[], theirs: string[]) => {
    const out = [...mine];
    for (const f of theirs) {
      const q = bare(f);
      if (!out.some((x) => { const n = bare(x); return n.includes(q) || q.includes(n); })) {
        notes.push(`cross-check added ${field} ${JSON.stringify(f)}`);
        out.push(f);
      }
    }
    // Keep the longer of two overlapping quotes.
    return out.filter((x, i) => !out.some((y, j) => j !== i && bare(y).includes(bare(x)) && (bare(y) !== bare(x) || j < i)));
  };
  const reviewQuotes = merge('review', accept('review', quotesOf(o.review)), fb.review);
  const unclearQuotes = merge('unclear', accept('unclear', quotesOf(o.unclear)), fb.unclear)
    .filter((u) => !reviewQuotes.some((r) => bare(r).includes(bare(u)) || bare(u).includes(bare(r))));

  const keys = new Set<string>();
  const unique = [...automatic, ...reviewQuotes.map(reviewCondition)].filter((d) => {
    const k = conditionKey(d);
    if (keys.has(k)) return false;
    keys.add(k);
    return true;
  });

  const conditions: Condition[] = [];
  for (const [i, d] of unique.entries()) {
    const r = ConditionSchema.safeParse({ ...d, id: `c${i + 1}` });
    if (!r.success) {
      return { ok: false, error: `conditions[${i}]: ${r.error.issues.map((x) => `${x.path.join('.')} ${x.message}`).join('; ')}` };
    }
    conditions.push(r.data);
  }

  const clarifications = unclearQuotes.map(clarificationFor);
  if (HASH_WORDS.test(rawText) && !conditions.some((c) => c.kind === 'file_hash')
    && ![...reviewQuotes, ...unclearQuotes].some((x) => HASH_WORDS.test(x))) {
    clarifications.push(MISSING_HASH_NOTE);
  }
  if (!conditions.length) clarifications.push(NO_CONDITIONS_NOTE);

  const lead = /[.!?]$/.test(deliverable) ? deliverable : `${deliverable}.`;
  return {
    ok: true,
    value: {
      summary: `${lead.slice(0, 300)} ${paymentSentence(req, unique)}`,
      conditions,
      clarifications: [...new Set(clarifications)].slice(0, 6),
    },
    notes,
  };
}
