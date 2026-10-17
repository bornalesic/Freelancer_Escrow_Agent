import { ConditionSchema, type Condition, type ParseRequest } from '@escrow/shared';
import {
  DEFAULT_TEST_COMMAND, DEFAULT_TIMEOUT_SEC, HASH_WORDS, MISSING_HASH_NOTE, MONEY_OR_TIME, NO_CONDITIONS_NOTE, TESTS_PASS,
  clarificationFor, conditionKey, displayName, fallbackDraft, paymentSentence,
  type DraftCondition, type UnclearReason,
} from './fallback.ts';

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

const KIND_ALIASES: Record<string, Condition['kind']> = {
  tests_pass: 'tests_pass', test_pass: 'tests_pass', tests: 'tests_pass', test: 'tests_pass',
  file_present: 'file_present', file_exists: 'file_present', file: 'file_present',
  file_hash: 'file_hash', hash: 'file_hash', sha256: 'file_hash',
};
const NAMED_GLOBS: Record<string, string> = { readme: 'README*', license: 'LICENSE*', changelog: 'CHANGELOG*' };

const s = (v: unknown) => (typeof v === 'string' ? v.trim() : '');
const norm = (t: string) => t.toLowerCase().replace(/[“”]/g, '"').replace(/[‘’]/g, "'").replace(/\s+/g, ' ').trim();
const stem = (pattern: string) => displayName(pattern).replace(/\*/g, '').toLowerCase();

function normalizePattern(raw: string): string {
  const p = raw.replace(/^\.\//, '').replace(/\.+$/, '');
  const named = NAMED_GLOBS[p.replace(/(\.\*|\*|\.md|\.txt)$/i, '').toLowerCase()];
  return named ?? p;
}

/**
 * Turns raw model output into validated conditions. The model proposes; this function keeps it grounded:
 *  - drops anything not literally supported by the agreement (invented hashes, files, commands, test checks,
 *    quotes), and
 *  - cross-checks against the deterministic parser, adding literal requirements the model missed.
 * Clarification sentences and the payment half of the summary are written here, never by the model.
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

  // 1. Model conditions, each checked against the agreement text.
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
      const pathPattern = normalizePattern(s(c.pathPattern));
      if (!pathPattern) return { ok: false, error: `conditions[${i}].pathPattern must be a non-empty string` };
      if (!stem(pathPattern) || !text.includes(stem(pathPattern))) {
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
      const fileName = s(c.fileName);
      drafts.push({
        kind, sha256,
        description: description || 'The uploaded file must exactly match the agreed SHA-256 fingerprint.',
        ...(fileName ? { fileName } : {}),
      });
    }
  }

  // 2. Cross-check: literal requirements the regex parser finds but the model missed.
  const fb = fallbackDraft(req);
  for (const f of fb.conditions) {
    const covered =
      f.kind === 'tests_pass' ? drafts.some((d) => d.kind === 'tests_pass')
      : f.kind === 'file_hash' ? drafts.some((d) => d.kind === 'file_hash' && d.sha256 === f.sha256)
      : drafts.some((d) =>
          (d.kind === 'file_present' && (stem(d.pathPattern).includes(stem(f.pathPattern)) || stem(f.pathPattern).includes(stem(d.pathPattern))))
          || (d.kind === 'file_hash' && d.fileName?.toLowerCase() === stem(f.pathPattern)));
    if (!covered) {
      notes.push(`cross-check added ${conditionKey(f)}`);
      drafts.push(f);
    }
  }

  // 3. A file with an agreed hash is necessarily present; drop the redundant presence check.
  const hashedFiles = new Set(drafts.flatMap((d) => (d.kind === 'file_hash' && d.fileName ? [d.fileName.toLowerCase()] : [])));
  const keys = new Set<string>();
  const unique = drafts.filter((d) => {
    if (d.kind === 'file_present' && hashedFiles.has(d.pathPattern.toLowerCase())) return false;
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

  // 4. Unclear items: only quotes literally in the agreement and not already covered by a check.
  const normText = norm(rawText);
  const isCovered = (q: string) =>
    (TESTS_PASS.test(q) && conditions.some((c) => c.kind === 'tests_pass')) ||
    conditions.some((c) => c.kind === 'file_present' && q.includes(stem(c.pathPattern))) ||
    /[0-9a-f]{64}/.test(q);
  const quotes: { quote: string; reason: UnclearReason }[] = [];
  for (const item of Array.isArray(o.unclear) ? o.unclear : []) {
    const u = (item ?? {}) as Record<string, unknown>;
    const quote = s(u.quote).replace(/^["']|["']$/g, '').replace(/[.!,;:]+$/, '');
    const q = norm(quote);
    const reason: UnclearReason = u.reason === 'not_checkable' ? 'not_checkable' : 'subjective';
    if (q.length < 3 || !normText.includes(q)) { notes.push(`dropped unclear quote not in agreement: ${JSON.stringify(quote)}`); continue; }
    if (MONEY_OR_TIME.test(q)) { notes.push(`dropped unclear quote about payment/deadline: ${JSON.stringify(quote)}`); continue; }
    if (isCovered(q)) { notes.push(`dropped unclear quote already covered by a check: ${JSON.stringify(quote)}`); continue; }
    quotes.push({ quote, reason });
  }
  const bare = (t: string) => norm(t).replace(/[.!,;:]+$/, '');
  for (const f of fb.unclear) {
    const q = bare(f.quote);
    if (!quotes.some((x) => { const n = bare(x.quote); return n.includes(q) || q.includes(n); })) {
      notes.push(`cross-check added unclear ${JSON.stringify(f.quote)}`);
      quotes.push(f);
    }
  }

  const clarifications = quotes.map((x) => clarificationFor(x.quote, x.reason));
  if (HASH_WORDS.test(rawText) && !conditions.some((c) => c.kind === 'file_hash') && !quotes.some((x) => HASH_WORDS.test(x.quote))) {
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
