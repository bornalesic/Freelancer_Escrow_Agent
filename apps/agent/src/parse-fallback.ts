import type { Condition, ParseRequest, ParseResult } from '@escrow/shared';

/**
 * Deterministic parser used when apps/ai is down, slow, or returns garbage twice. Mirrors the
 * fallback described in apps/ai/CLAUDE.md so the demo never blocks on the model.
 */
export function fallbackParse(req: ParseRequest, defaultTimeoutSec: number, startedAt = Date.now()): ParseResult {
  const text = req.rawText;
  const conditions: Condition[] = [];
  const clarifications: string[] = [];

  if (/\btests?\b[^.]*\b(must |should |will |to )?pass/i.test(text) || /\bpass(es|ing)? (all |the )?tests?\b/i.test(text)) {
    conditions.push({
      id: '',
      kind: 'tests_pass',
      description: 'The included tests pass (npm test).',
      command: 'npm test',
      timeoutSec: defaultTimeoutSec,
    });
  }
  for (const sha256 of new Set(text.toLowerCase().match(/\b[0-9a-f]{64}\b/g) ?? [])) {
    conditions.push({
      id: '',
      kind: 'file_hash',
      description: `The delivered file matches the agreed fingerprint ${sha256.slice(0, 8)}….`,
      sha256,
    });
  }
  if (/\binclude[sd]?\b[^.]*\breadme\b/i.test(text) || /\breadme\b[^.]*\b(included|present|required)\b/i.test(text)) {
    conditions.push({ id: '', kind: 'file_present', description: 'A README file is included.', pathPattern: 'README*' });
  }

  // Subjective requirements a person can judge become client_review items (one per sentence, max 3).
  const subjective = /\b(looks?|colou?rs?|design|professional|clean|nice|modern|beautiful|style|feel)\b/i;
  const sentences = text.split(/(?<=[.!?])\s+/).map((s) => s.trim()).filter(Boolean);
  for (const s of sentences.filter((x) => subjective.test(x) && !/\b(tests?|readme)\b/i.test(x)).slice(0, 3)) {
    conditions.push({ id: '', kind: 'client_review', description: s.length > 200 ? `${s.slice(0, 199)}…` : s });
  }

  if (conditions.length === 0) {
    clarifications.push('No checkable condition was found. Say for example "the included tests must pass".');
  }

  return {
    conditions: conditions.map((c, i) => ({ ...c, id: `c${i + 1}` })),
    summary: `${req.title}: ${req.amountDisplay} ${req.assetTicker} is paid if the delivery passes the checks below before ${req.deadline}.`,
    clarifications,
    source: 'fallback',
    ms: Date.now() - startedAt,
  };
}
