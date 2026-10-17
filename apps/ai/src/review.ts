import { randomBytes } from 'node:crypto';
import { AiReviewSchema, isAutomaticCondition, type AiReview, type ClientReviewCondition, type ReviewOpinion, type ReviewRequest } from '@escrow/shared';
import { colourContradiction, colourFactLines, colourFacts } from './colours.ts';
import type { LlmEngine } from './llm.ts';
import { extractJson } from './postprocess.ts';
import { REVIEW_SYSTEM, reviewOutputSchema, reviewUserPrompt } from './prompts.ts';

// POST /review: QVAC's advisory opinion on each client_review condition. Shown to people, never read by
// decide(). The delivery is untrusted input written by the freelancer, so:
//  - excerpts are fenced with a random marker and HTML comments (invisible on the page) are removed,
//  - text aimed at the reviewer (prompt injection) is detected and turns "looks met" into "unsure",
//  - a note may only mention files and colour values that really are in the delivery,
//  - "looks met" on a warm/cool criterion is withheld when every colour in the delivery is the opposite,
//  - on any failure every item is "unsure" with a template note.

export interface ReviewDeps {
  engine: LlmEngine | null;
  budgetMs: number;
  log: (msg: string) => void;
}

type ReviewFile = ReviewRequest['files'][number];

const MAX_TOTAL_EXCERPT = 10_000;  // chars; ~3k tokens, fits a 8k context slot with the prompt
const MAX_FILE_EXCERPT = 4_000;
const REVIEW_PRIORITY = 5;         // after parses, before explanations

export const TEMPLATE_NOTE = 'The AI review is not available right now; please check this yourself.';
export const INJECTION_NOTE = 'The delivery contains text addressed to the AI reviewer, so no AI opinion is given; please check this yourself.';
export const INJECTION_SUFFIX = ' Note: the delivery also contains text addressed to the AI reviewer.';
export const UNGROUNDED_NOTE = 'The AI opinion mentioned a file or value that is not in the delivery, so it was discarded; please check this yourself.';
const EMPTY_NOTE = 'The AI gave no reason, so its opinion was discarded; please check this yourself.';

/** Code-written note when the model's "looks met" contradicts the delivery's colours. */
export function colourNote(wanted: string, found: { hex: string; name: string }[]): string {
  const list = found.slice(0, 4).map((f) => `${f.name} ${f.hex}`).join(', ');
  const opposite = wanted === 'warm' ? 'cool' : 'warm';
  return `The AI said this looks met, but the delivery's colours are ${opposite} (${list}) and none are ${wanted}, so its opinion was discarded; please check this yourself.`;
}

const INJECTION = [
  /\b(note|message|instructions?)\s+(to|for)\s+(the\s+)?(ai|reviewer|assistant|model|llm|grader|evaluator)\b/i,
  /\bignore\s+(all\s+|any\s+|the\s+)?(previous|prior|above|earlier)\s+(instructions|rules|prompts?)\b/i,
  /\b(all|every)\s+(the\s+)?(criteria|criterion|conditions?|requirements?)\s+(are|is|have been|has been)\s+(met|satisfied|fulfilled)\b/i,
  /\byou\s+are\s+(an?\s+)?(ai|assistant|reviewer|language model)\b/i,
  /\b(system prompt|as an ai)\b/i,
  /\blooks_(met|unmet)\b/i,
  /\b(dear|attention)\s+(ai|reviewer|assistant|model)\b/i,
];
const FILE_MENTION = /(?<![\w.-])(?:[\w-]+\/)*[\w-]+\.(?:html?|css|js|mjs|ts|tsx|jsx|json|md|txt|png|jpe?g|svg|gif|webp|py|zip|pdf|ya?ml|csv)\b/gi;
const HEX_COLOUR = /#[0-9a-f]{3,8}\b/gi;

/** True if any excerpt contains text that tries to talk to the AI reviewer. */
export function detectInjection(files: ReviewFile[]): boolean {
  return files.some((f) => f.excerpt && INJECTION.some((re) => re.test(f.excerpt!)));
}

export function stripHtmlComments(text: string): string {
  return text.replace(/<!--[\s\S]*?(?:-->|$)/g, '');
}

/** File list + fenced excerpts for the prompt. The marker carries a random nonce the delivery can't guess. */
export function filesForPrompt(files: ReviewFile[], nonce: string): { fileList: string; fencedFiles: string } {
  let budget = MAX_TOTAL_EXCERPT;
  const fenced: string[] = [];
  const list = files.map((f) => {
    let shown = false;
    if (f.excerpt && budget > 200) {
      const text = stripHtmlComments(f.excerpt).replaceAll('=====', '====').slice(0, Math.min(MAX_FILE_EXCERPT, budget));
      budget -= text.length;
      fenced.push(`===== BEGIN ${f.path} ${nonce} =====\n${text}\n===== END ${nonce} =====`);
      shown = true;
    }
    return `- ${f.path} (${f.sizeBytes} bytes${shown ? '' : ', content not shown'})`;
  });
  return { fileList: list.join('\n'), fencedFiles: fenced.join('\n\n') || '(no text content)' };
}

function cleanNote(note: unknown): string {
  if (typeof note !== 'string') return '';
  const t = note.replace(/[*`]/g, '').replace(/\s+/g, ' ').trim();
  if (t.length <= 300) return t;
  const cut = t.slice(0, 300);
  const end = Math.max(cut.lastIndexOf('. '), cut.lastIndexOf('! '), cut.lastIndexOf('? '));
  return end > 40 ? cut.slice(0, end + 1) : `${cut.trimEnd()}…`;
}

/** A note may only mention files in the delivery and colour values that appear in it. */
export function isNoteGrounded(note: string, files: ReviewFile[]): boolean {
  const names = new Set(files.flatMap((f) => [f.path.toLowerCase(), f.path.split('/').at(-1)!.toLowerCase()]));
  for (const m of note.matchAll(FILE_MENTION)) if (!names.has(m[0].toLowerCase())) return false;
  const corpus = files.map((f) => f.excerpt ?? '').join('\n').toLowerCase();
  for (const m of note.matchAll(HEX_COLOUR)) if (!corpus.includes(m[0].toLowerCase())) return false;
  return true;
}

const OPINIONS = new Set<ReviewOpinion>(['looks_met', 'looks_unmet', 'unsure']);

export function templateReview(conditions: ClientReviewCondition[], note: string, ms: number): AiReview {
  return { items: conditions.map((c) => ({ conditionId: c.id, opinion: 'unsure', note })), source: 'template', ms };
}

/** Model → guards → AiReview. Never throws; on any failure every item is "unsure" with a template note. */
export async function reviewDelivery(req: ReviewRequest, deps: ReviewDeps): Promise<AiReview> {
  const t0 = performance.now();
  const ms = () => Math.round(performance.now() - t0);
  const conditions = req.escrow.conditions.filter((c): c is ClientReviewCondition => !isAutomaticCondition(c));
  if (!conditions.length) return { items: [], source: 'template', ms: ms() };

  const engine = deps.engine;
  if (!engine || !engine.status().loaded) return templateReview(conditions, TEMPLATE_NOTE, ms());

  const injected = detectInjection(req.files);
  if (injected) deps.log(`review ${req.escrow.id}#${req.deliveryN}: guard: delivery contains text aimed at the reviewer`);
  const { fileList, fencedFiles } = filesForPrompt(req.files, randomBytes(4).toString('hex'));
  const colours = colourFacts(req.files.map((f) => f.excerpt));

  try {
    const out = await engine.generate({
      messages: [
        { role: 'system', content: REVIEW_SYSTEM },
        { role: 'user', content: reviewUserPrompt({ rawText: req.escrow.rawText, conditions, fileList, fencedFiles, colours: colourFactLines(colours) }) },
      ],
      predict: 60 + 110 * conditions.length,
      jsonSchema: reviewOutputSchema(conditions),
      signal: AbortSignal.timeout(deps.budgetMs),
      priority: REVIEW_PRIORITY,
    });
    const parsed = extractJson(out.text) as Record<string, { note?: unknown; opinion?: unknown } | undefined>;
    const items = conditions.map((c) => {
      const raw = parsed?.[c.id];
      let opinion: ReviewOpinion = OPINIONS.has(raw?.opinion as ReviewOpinion) ? (raw!.opinion as ReviewOpinion) : 'unsure';
      let note = cleanNote(raw?.note);
      if (!note) return { conditionId: c.id, opinion: 'unsure' as const, note: EMPTY_NOTE };
      if (!isNoteGrounded(note, req.files)) {
        deps.log(`review ${req.escrow.id}#${req.deliveryN} ${c.id}: guard: ungrounded note ${JSON.stringify(note)}`);
        return { conditionId: c.id, opinion: 'unsure' as const, note: UNGROUNDED_NOTE };
      }
      if (injected && opinion === 'looks_met') {
        deps.log(`review ${req.escrow.id}#${req.deliveryN} ${c.id}: guard: "looks met" withheld (injection)`);
        opinion = 'unsure';
        note = INJECTION_NOTE;
      } else if (injected) {
        note += INJECTION_SUFFIX;
      }
      const clash = opinion === 'looks_met' ? colourContradiction(c.description, colours) : undefined;
      if (clash) {
        deps.log(`review ${req.escrow.id}#${req.deliveryN} ${c.id}: guard: "looks met" withheld, colours are not ${clash.wanted}: ${JSON.stringify(note)}`);
        opinion = 'unsure';
        note = colourNote(clash.wanted, clash.found);
      }
      return { conditionId: c.id, opinion, note };
    });
    deps.log(`review ${req.escrow.id}#${req.deliveryN}: ok (${out.ms} ms, ${out.generatedTokens ?? '?'} tokens): ${items.map((i) => `${i.conditionId}=${i.opinion}`).join(' ')}`);
    return AiReviewSchema.parse({ items, source: 'ai', model: engine.status().model, ms: ms() });
  } catch (e) {
    deps.log(`review ${req.escrow.id}#${req.deliveryN}: template (${(e as Error).message})`);
    return templateReview(conditions, TEMPLATE_NOTE, ms());
  }
}
