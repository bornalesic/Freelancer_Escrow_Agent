import { verifiability, type RewriteRequest, type RewriteResult, type RewriteSuggestion } from '@escrow/shared';
import { norm, runAssist, sentence, type AssistDeps } from './assist.ts';
import { REWRITE_SYSTEM, perId, rewriteUserPrompt, textSlot } from './assistPrompts.ts';
import { findTarget, literalExamples } from './examples.ts';
import { MONEY_OR_TIME, fallbackDraft } from './fallback.ts';

// POST /assist/rewrite: the verifiability score plus, for each client_review item, a measurable rewording.
// A rewrite is only offered if our own deterministic parser turns it into an automatic check, so "Use this"
// really moves the item from "the client judges" to "the verifier checks" after the re-parse.

type Becomes = RewriteSuggestion['becomes'];

/** The automatic check kind our parser makes from `rewrite` (in the context of the agreement), if any. */
export function checkableAs(rewrite: string, rawText: string, examples: boolean): Becomes | undefined {
  if (!rewrite || rewrite.length > 220 || MONEY_OR_TIME.test(rewrite) || /[0-9a-f]{64}/i.test(rewrite)) return undefined;
  const d = fallbackDraft({ title: '', rawText: rewrite, amountDisplay: '0', assetTicker: '', deadline: '' });
  const kind = d.conditions[0]?.kind;
  if (kind && kind !== 'client_review') return kind;
  if (examples) {
    const target = findTarget(`${rawText}\n${rewrite}`);
    if (target && literalExamples(rewrite, target).length) return 'examples';
  }
  return undefined;
}

/** The agreement's own words behind a client_review description (descriptions are built from quotes). */
export function quoteFor(description: string, rawText: string): string {
  const d = description.trim().replace(/[.!]+$/, '');
  const at = rawText.toLowerCase().indexOf(d.toLowerCase());
  return at >= 0 ? rawText.slice(at, at + d.length) : d; // not found: applyRewrite appends instead
}

// Rewrites code can offer without the model. Taste (colours, look, design) has none: a person judges it.
const RULES: { when: RegExp; rewrite: (quote: string) => string }[] = [
  { when: /\b(?:docs?|documentation|documented|readme|explain|instructions)\b/i, rewrite: () => 'Include a README.md file that explains how to install and use it.' },
  { when: /\b(?:fast|faster|quick|quickly|performance|speed|slow|efficient)\b/i, rewrite: () => 'The included tests must pass within 10 seconds.' },
  { when: /\b(?:clean code|readable|maintainable|well[- ]written|quality|tidy|lint|consistent style)\b/i, rewrite: () => '`npm run lint` must pass.' },
  { when: /\b(?:works?|working|correct(?:ly)?|bug[- ]free|reliable|robust|has to have|must have|should have|needs?)\b/i, rewrite: (q) => `The included tests must pass, including tests for: ${q.replace(/[.!]+$/, '')}.` },
];
const TASTE = /\b(?:colou?rs?|look|looks|design|beautiful|pretty|nice|modern|professional|elegant|sleek|attractive|style|feel|tone|logo|brand)\b/i;

export function ruleRewrite(quote: string): string | undefined {
  if (TASTE.test(quote) && !/\b(?:docs?|documentation|code)\b/i.test(quote)) return undefined;
  return RULES.find((r) => r.when.test(quote))?.rewrite(quote);
}

export async function rewriteTerms(req: RewriteRequest, deps: AssistDeps & { examples?: boolean }): Promise<RewriteResult> {
  const score = verifiability(req.conditions);
  const items = req.conditions.filter((c) => c.kind === 'client_review').map((c) => ({ id: c.id, text: c.description, quote: quoteFor(c.description, req.rawText) }));
  const suggest = (pick: (i: (typeof items)[number]) => string | undefined): RewriteSuggestion[] =>
    items.flatMap((i) => {
      const rewrite = pick(i);
      const becomes = rewrite ? checkableAs(rewrite, req.rawText, deps.examples ?? false) : undefined;
      return rewrite && becomes && norm(rewrite) !== norm(i.quote) ? [{ conditionId: i.id, quote: i.quote, rewrite, becomes }] : [];
    }).slice(0, 6);
  const byRules = () => suggest((i) => ruleRewrite(i.quote));
  if (!items.length) return { ...score, suggestions: [], source: 'fallback', ms: 0 };

  return runAssist('rewrite', deps, () => ({ ...score, suggestions: byRules() }), async (ask) => {
    const json = (await ask({
      system: REWRITE_SYSTEM,
      user: rewriteUserPrompt(req.rawText, items),
      schema: perId(items.map((i) => i.id), textSlot('rewrite')),
      predict: 40 + 70 * items.length,
    })) as Record<string, { rewrite?: unknown } | undefined>;
    const model = new Map(items.map((i) => [i.id, sentence(json?.[i.id]?.rewrite, 220)]));
    const rules = new Map(byRules().map((s) => [s.conditionId, s.rewrite]));
    const suggestions = suggest((i) => {
      const m = model.get(i.id);
      if (m && checkableAs(m, req.rawText, deps.examples ?? false)) return m;
      if (m) deps.log(`rewrite: guard: not checkable, ${JSON.stringify(m)}`);
      return rules.get(i.id);
    });
    return { ...score, suggestions };
  });
}
