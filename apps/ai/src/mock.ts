import type { ParseResult } from '@escrow/shared';
import { buildFacts } from './facts.ts';
import { fallbackParse } from './fallback.ts';
import type { AiHandlers } from './server.ts';
import { templateFor } from './templates.ts';

// AI_MODE=mock: no model, no @qvac/sdk import. Runs anywhere (WSL included) as part of `npm run dev:mock`.

const sleep = (ms: number, signal?: AbortSignal) =>
  new Promise<void>((resolve) => {
    const t = setTimeout(resolve, ms);
    signal?.addEventListener('abort', () => { clearTimeout(t); resolve(); }, { once: true });
  });

const PARSE_DELAY_MS = 800;   // long enough for the UI to show the DRAFT state
const WORD_DELAY_MS = 40;
const REVIEW_DELAY_MS = 1200;

export function mockHandlers(): AiHandlers {
  return {
    health: () => ({ ok: true, model: 'mock', loaded: true, device: 'none', mode: 'mock' }),

    async parse(req) {
      const t0 = Date.now();
      await sleep(PARSE_DELAY_MS);
      if (/slugify/i.test(req.rawText)) {
        const result: ParseResult = {
          summary: `The freelancer builds a JavaScript slugify function that lowercases text, turns spaces into dashes and removes other characters. The ${req.amountDisplay} ${req.assetTicker} are released when the included tests pass and a README is included.`,
          conditions: [
            { id: 'c1', kind: 'tests_pass', description: 'All the included tests must pass.', command: 'npm test', timeoutSec: 60 },
            { id: 'c2', kind: 'file_present', description: 'A README file must be included.', pathPattern: 'README*' },
          ],
          clarifications: [],
          source: 'ai',
          model: 'mock',
          ms: Date.now() - t0,
        };
        return result;
      }
      return { ...fallbackParse(req), ms: Date.now() - t0 };
    },

    // Mirrors the demo script: delivery #1 looks unmet (client disputes), later deliveries look met.
    async review(req) {
      const t0 = Date.now();
      await sleep(REVIEW_DELAY_MS);
      const met = req.deliveryN > 1;
      return {
        items: req.escrow.conditions.filter((c) => c.kind === 'client_review').map((c) => ({
          conditionId: c.id,
          opinion: met ? 'looks_met' as const : 'looks_unmet' as const,
          note: met
            ? `Mock opinion: in delivery #${req.deliveryN} this looks met.`
            : `Mock opinion: in delivery #${req.deliveryN} this does not look met yet.`,
        })),
        source: 'ai',
        model: 'mock',
        ms: Date.now() - t0,
      };
    },

    async explain(req, onDelta, signal) {
      const text = templateFor(buildFacts(req.event, req.escrow));
      const words = text.split(' ');
      for (const [i, w] of words.entries()) {
        if (signal?.aborted) break;
        onDelta?.(i === 0 ? w : ` ${w}`);
        await sleep(WORD_DELAY_MS, signal);
      }
      return { text, source: 'template' };
    },
  };
}
