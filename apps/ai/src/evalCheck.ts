import type { ParseRequest, ParseResult } from '@escrow/shared';
import { NO_CONDITIONS_NOTE } from './fallback.ts';

export interface AgreementCase extends ParseRequest {
  id: string;
  expect: {
    kinds?: string[];          // each kind must appear at least once
    notKinds?: string[];       // none of these kinds may appear
    commands?: string[];       // each must be a tests_pass command
    pathPatterns?: string[];   // each must be a substring of some file_present pathPattern (case-insensitive)
    hashes?: string[];         // each must be a file_hash sha256
    minClarifications?: number; // real clarifications (the generic "no conditions" note does not count)
  };
}

/** Returns the list of failed expectations (empty = pass). Also enforces "no invented hashes" globally. */
export function checkCase(c: AgreementCase, r: Pick<ParseResult, 'conditions' | 'clarifications'>): string[] {
  const fails: string[] = [];
  const kinds = new Set(r.conditions.map((x) => x.kind));
  const e = c.expect;
  for (const k of e.kinds ?? []) if (!kinds.has(k as never)) fails.push(`missing kind ${k}`);
  for (const k of e.notKinds ?? []) if (kinds.has(k as never)) fails.push(`unexpected kind ${k}`);

  const commands = r.conditions.flatMap((x) => (x.kind === 'tests_pass' ? [x.command] : []));
  for (const cmd of e.commands ?? []) if (!commands.includes(cmd)) fails.push(`missing command "${cmd}" (got ${JSON.stringify(commands)})`);

  const patterns = r.conditions.flatMap((x) => (x.kind === 'file_present' ? [x.pathPattern.toLowerCase()] : []));
  for (const p of e.pathPatterns ?? []) {
    if (!patterns.some((x) => x.includes(p.toLowerCase()))) fails.push(`missing file "${p}" (got ${JSON.stringify(patterns)})`);
  }

  const hashes = r.conditions.flatMap((x) => (x.kind === 'file_hash' ? [x.sha256] : []));
  for (const h of e.hashes ?? []) if (!hashes.includes(h)) fails.push(`missing hash ${h.slice(0, 12)}…`);
  for (const h of hashes) if (!c.rawText.toLowerCase().includes(h)) fails.push(`INVENTED hash ${h.slice(0, 12)}…`);

  const real = r.clarifications.filter((x) => x !== NO_CONDITIONS_NOTE);
  if (real.length < (e.minClarifications ?? 0)) fails.push(`expected >= ${e.minClarifications} clarifications, got ${real.length}`);
  return fails;
}
