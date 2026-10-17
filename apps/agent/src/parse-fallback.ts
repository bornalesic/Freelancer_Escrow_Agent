import type { ParseRequest, ParseResult } from '@escrow/shared';
// WS2's deterministic parser (apps/ai/src/fallback.ts): pure regexes, no model import, and tested against
// every case in fixtures/agreements.json. The agent needs it locally because the AI runs on another laptop:
// when that laptop is unreachable, this is what proposes the terms. One parser, so the two never drift.
import { DEFAULT_TIMEOUT_SEC, fallbackParse as parseLiterally } from '@escrow/ai/src/fallback.ts';

/**
 * Deterministic parser used when apps/ai is down, slow, or returns garbage twice, so the demo never
 * blocks on the model. A test timeout the agreement doesn't state uses VERIFY_DEFAULT_TIMEOUT_SEC.
 */
export function fallbackParse(req: ParseRequest, defaultTimeoutSec: number, startedAt = Date.now()): ParseResult {
  const r = parseLiterally(req);
  return {
    ...r,
    conditions: r.conditions.map((c) =>
      c.kind === 'tests_pass' && c.timeoutSec === DEFAULT_TIMEOUT_SEC ? { ...c, timeoutSec: defaultTimeoutSec } : c,
    ),
    ms: Date.now() - startedAt,
  };
}
