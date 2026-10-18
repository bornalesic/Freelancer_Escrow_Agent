import type { EstimateRequest, EstimateResult, JobSize } from '@escrow/shared';
import { inventedNumbers, runAssist, sentence, str, type AssistDeps } from './assist.ts';
import { ESTIMATE_OUTPUT_SCHEMA, ESTIMATE_SYSTEM, estimateUserPrompt } from './assistPrompts.ts';

// POST /assist/estimate: the model only sizes the job (tiny/small/medium/large) and says why; the typical
// price and time ranges and the warnings are written by code from fixed bands. Advice only.

/** Typical freelance bands per size (USDT-like units; minutes). Rough on purpose: they flag outliers. */
export const BANDS: Record<JobSize, { amount: [number, number]; minutes: [number, number] }> = {
  tiny: { amount: [10, 80], minutes: [30, 8 * 60] },
  small: { amount: [50, 400], minutes: [2 * 60, 3 * 24 * 60] },
  medium: { amount: [300, 3000], minutes: [2 * 24 * 60, 14 * 24 * 60] },
  large: { amount: [2000, 20000], minutes: [14 * 24 * 60, 84 * 24 * 60] },
};
const SIZES = Object.keys(BANDS) as JobSize[];

const LARGE = /\b(?:platform|marketplace|online shop|web ?shop|e-?commerce|whole app|full app|mobile app|ios|android|saas|social network|crm|erp)\b/i;
const MEDIUM = /\b(?:multi-?page|backend|database|integration|dashboard|admin panel|login|authentication|sign[- ]up|website|rest api|graphql)\b/i;
const SMALL = /\b(?:landing|one-page|single page|page|tool|cli|bot|component|feature|plugin|extension|logo|parser|scraper)\b/i;
const TINY = /\b(?:function|snippet|regex|script|fix|typo|small change|one-liner|helper)\b/i;

export function heuristicSize(rawText: string): JobSize {
  if (LARGE.test(rawText)) return 'large';
  if (MEDIUM.test(rawText)) return 'medium';
  if (SMALL.test(rawText)) return 'small';
  if (TINY.test(rawText)) return 'tiny';
  return 'small';
}

const REASONS: Record<JobSize, string> = {
  tiny: 'It reads like one small, self-contained piece of code or change.',
  small: 'It reads like one page, one tool or one feature.',
  medium: 'It reads like several connected parts, such as pages plus a backend.',
  large: 'It reads like a whole product with many features.',
};

export function duration(minutes: number): string {
  if (minutes < 120) return `${Math.round(minutes)} min`;
  if (minutes < 48 * 60) return `${Math.round(minutes / 60)} h`;
  if (minutes < 21 * 24 * 60) return `${Math.round(minutes / (24 * 60))} days`;
  return `${Math.round(minutes / (7 * 24 * 60))} weeks`;
}

/** Whole units of the offered amount (display string), as bigint: money is never a float. */
const wholeUnits = (display: string) => BigInt(display.split('.')[0] || '0');

export function bandsFor(size: JobSize, req: EstimateRequest): Pick<EstimateResult, 'amount' | 'minutes' | 'warnings'> {
  const b = BANDS[size];
  const [low, high] = b.amount;
  const [tLow, tHigh] = b.minutes;
  const offered = wholeUnits(req.amountDisplay);
  const t = req.assetTicker;
  const warnings: string[] = [];
  if (offered < BigInt(low)) warnings.push(`${req.amountDisplay} ${t} looks low for a ${size} job (typical ${low}–${high} ${t}).`);
  else if (offered > BigInt(high)) warnings.push(`${req.amountDisplay} ${t} looks high for a ${size} job (typical ${low}–${high} ${t}).`);
  if (req.deadlineMinutes < tLow) warnings.push(`${duration(req.deadlineMinutes)} looks short for a ${size} job (typical ${duration(tLow)}–${duration(tHigh)}).`);
  return { amount: { low: String(low), high: String(high) }, minutes: { low: tLow, high: tHigh }, warnings };
}

export async function estimateJob(req: EstimateRequest, deps: AssistDeps): Promise<EstimateResult> {
  const fallback = () => {
    const size = heuristicSize(req.rawText);
    return { size, reason: REASONS[size], ...bandsFor(size, req) };
  };
  return runAssist('estimate', deps, fallback, async (ask) => {
    const json = (await ask({ system: ESTIMATE_SYSTEM, user: estimateUserPrompt(req.title, req.rawText), schema: ESTIMATE_OUTPUT_SCHEMA, predict: 80 })) as { size?: unknown; reason?: unknown };
    const size = SIZES.find((s) => s === str(json?.size));
    if (!size) return undefined;
    let reason = sentence(json.reason, 200);
    if (!reason || inventedNumbers(reason, [req.rawText]).length || /\b(?:usdt|price|cost|hours?|days?|weeks?)\b/i.test(reason)) {
      deps.log(`estimate: guard: reason replaced (${JSON.stringify(reason)})`);
      reason = REASONS[size];
    }
    return { size, reason, ...bandsFor(size, req) };
  });
}
