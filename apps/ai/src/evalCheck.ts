import type { Condition, ParseRequest, ParseResult } from '@escrow/shared';
import { NO_CONDITIONS_NOTE } from './fallback.ts';
import { patternsMatch } from './glob.ts';

// Scoring for fixtures/agreements.json (format by WS4, see its $comment).

export interface ExpectedCondition {
  kind: Condition['kind'];
  [field: string]: unknown;
}

export interface AgreementCase {
  id: string;
  title: string;
  rawText: string;
  amountDisplay: string;
  assetTicker: string;
  deadlineMinutes: number;
  expect: {
    conditions: ExpectedCondition[];   // partial matches: kind + listed fields
    extraConditionsAllowed: boolean;   // false = every actual condition must match some expected one
    minClarifications: number;         // real clarifications (the generic "no conditions" note does not count)
  };
}

export interface AgreementFile {
  $comment?: string;
  cases: AgreementCase[];
}

export function toParseRequest(c: AgreementCase, now = Date.now()): ParseRequest {
  return {
    title: c.title,
    rawText: c.rawText,
    amountDisplay: c.amountDisplay,
    assetTicker: c.assetTicker,
    deadline: new Date(now + c.deadlineMinutes * 60_000).toISOString(),
  };
}

const FREE_FIELDS = new Set(['kind', 'id', 'description', 'timeoutSec']);

function fieldMatches(field: string, expected: unknown, actual: unknown): boolean {
  if (actual === undefined) return false;
  switch (field) {
    case 'pathPattern': return patternsMatch(String(expected), String(actual));
    case 'sha256':
    case 'fileName': return String(actual).toLowerCase() === String(expected).toLowerCase();
    case 'command': return String(actual).trim() === String(expected).trim();
    default: return actual === expected;
  }
}

export function conditionMatches(actual: Condition, expected: ExpectedCondition): boolean {
  if (actual.kind !== expected.kind) return false;
  return Object.entries(expected).every(([k, v]) => FREE_FIELDS.has(k) || fieldMatches(k, v, (actual as Record<string, unknown>)[k]));
}

function describe(c: Condition | ExpectedCondition): string {
  const o = c as Record<string, unknown>;
  const detail = o.pathPattern ?? o.command ?? (o.sha256 ? `${String(o.sha256).slice(0, 12)}…` : undefined) ?? o.description;
  return `${c.kind}${detail ? ` "${detail}"` : ''}`;
}

/** Returns the list of failed expectations (empty = pass). Also enforces "no invented hashes" globally. */
export function checkCase(c: AgreementCase, r: Pick<ParseResult, 'conditions' | 'clarifications'>): string[] {
  const fails: string[] = [];
  const e = c.expect;
  for (const exp of e.conditions) {
    if (!r.conditions.some((a) => conditionMatches(a, exp))) fails.push(`missing ${describe(exp)}`);
  }
  if (!e.extraConditionsAllowed) {
    for (const a of r.conditions) {
      if (!e.conditions.some((exp) => conditionMatches(a, exp))) fails.push(`unexpected ${describe(a)}`);
    }
  }
  for (const a of r.conditions) {
    if (a.kind === 'file_hash' && !c.rawText.toLowerCase().includes(a.sha256)) fails.push(`INVENTED hash ${a.sha256.slice(0, 12)}…`);
  }
  const real = r.clarifications.filter((x) => x !== NO_CONDITIONS_NOTE);
  if (real.length < e.minClarifications) fails.push(`expected >= ${e.minClarifications} clarifications, got ${real.length}`);
  return fails;
}
