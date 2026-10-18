import type { JobFit, MatchRequest, MatchResult, SplitRequest, SplitResult } from '@escrow/shared';
import { contentWords, inventedNumbers, runAssist, sentence, str, type AssistDeps } from './assist.ts';
import { MATCH_SYSTEM, SPLIT_SYSTEM, matchUserPrompt, perId, splitUserPrompt } from './assistPrompts.ts';
import { conditionDetail, conditionWork } from './conditionText.ts';

// POST /assist/match ranks jobs for a freelancer's skills; POST /assist/split gives each condition of one job
// to a team member. The grammar forces one answer per job/condition (and, for split, a member from the list);
// code does the ranking and grouping. Fallback: keyword overlap with a few synonyms.

const SYNONYMS: Record<string, string[]> = {
  javascript: ['js', 'node', 'node.js', 'nodejs', 'npm', 'javascript', 'frontend', 'react', 'web'],
  typescript: ['ts', 'typescript', 'javascript'],
  python: ['python', 'py', 'pytest', 'django', 'flask'],
  css: ['css', 'html', 'frontend', 'design', 'web', 'landing', 'page', 'colours', 'colors', 'look'],
  html: ['html', 'css', 'web', 'website', 'page', 'landing', 'frontend'],
  design: ['design', 'ui', 'ux', 'figma', 'logo', 'colours', 'colors', 'look', 'css', 'brand'],
  writing: ['writing', 'docs', 'documentation', 'readme', 'copy', 'copywriting', 'content'],
  testing: ['testing', 'tests', 'test', 'qa', 'pytest', 'jest'],
};

/** Content words plus synonyms (a "React" skill matches a "JavaScript" job). */
export function expand(text: string): Set<string> {
  const words = contentWords(text);
  for (const w of [...words]) {
    for (const [key, list] of Object.entries(SYNONYMS)) {
      if (w === key || list.includes(w)) [key, ...list].forEach((x) => words.add(x));
    }
  }
  return words;
}

const overlap = (a: Set<string>, b: Set<string>) => [...a].filter((w) => b.has(w));
const FITS: JobFit[] = ['good', 'partial', 'poor'];
const jobText = (j: MatchRequest['jobs'][number]) =>
  `${j.title}: ${j.rawText.slice(0, 400)} Checks: ${j.conditions.map((c) => c.description).join(' ')}`;

export async function matchJobs(req: MatchRequest, deps: AssistDeps): Promise<MatchResult> {
  const skills = expand(req.skills);
  const scored = req.jobs.map((j) => {
    const job = expand(jobText(j));
    // The freelancer's own words whose meaning shows up in the job ("react" for a JavaScript job).
    const hits = [...contentWords(req.skills)].filter((w) => overlap(expand(w), job).length > 0);
    return { id: j.id, hits, score: overlap(skills, job).length };
  });
  const fallbackFit = (s: (typeof scored)[number]): JobFit => (s.hits.length >= 2 ? 'good' : s.hits.length === 1 ? 'partial' : 'poor');
  const fallbackReason = (s: (typeof scored)[number]) =>
    s.hits.length ? `Matches your skills: ${s.hits.slice(0, 4).join(', ')}.` : 'None of your listed skills show up in this job.';
  const rank = (items: { id: string; fit: JobFit; reason: string }[]) =>
    items.sort((a, b) => FITS.indexOf(a.fit) - FITS.indexOf(b.fit)
      || scored.find((s) => s.id === b.id)!.score - scored.find((s) => s.id === a.id)!.score);

  return runAssist('match', deps, () => ({ ranked: rank(scored.map((s) => ({ id: s.id, fit: fallbackFit(s), reason: fallbackReason(s) }))) }), async (ask) => {
    const json = (await ask({
      system: MATCH_SYSTEM,
      user: matchUserPrompt(req.skills, req.jobs.map((j) => ({ id: j.id, text: jobText(j) }))),
      schema: perId(req.jobs.map((j) => j.id), { type: 'object', properties: { fit: { enum: FITS }, reason: { type: 'string' } }, required: ['fit', 'reason'], additionalProperties: false }),
      predict: 30 + 60 * req.jobs.length,
    })) as Record<string, { fit?: unknown; reason?: unknown } | undefined>;
    return {
      ranked: rank(scored.map((s) => {
        const fit = FITS.find((f) => f === str(json?.[s.id]?.fit)) ?? fallbackFit(s);
        const job = req.jobs.find((j) => j.id === s.id)!;
        let reason = sentence(json?.[s.id]?.reason, 200);
        if (!reason || inventedNumbers(reason, [req.skills, jobText(job)]).length) reason = fallbackReason(s);
        return { id: s.id, fit, reason };
      })),
    };
  });
}

export async function splitWork(req: SplitRequest, deps: AssistDeps): Promise<SplitResult> {
  const names = [...new Set(req.members.map((m) => m.name))];
  const skillsOf = new Map(req.members.map((m) => [m.name, m.skills]));
  const group = (pick: Map<string, { member: string; why: string }>): SplitResult['assignments'] =>
    names.map((member) => {
      const mine = req.conditions.filter((c) => pick.get(c.id)?.member === member);
      const whys = [...new Set(mine.map((c) => pick.get(c.id)!.why).filter(Boolean))];
      return { member, conditionIds: mine.map((c) => c.id), note: mine.length ? whys.slice(0, 2).join(' ') : 'Nothing assigned; can review the others\' work.' };
    });

  const byKeywords = () => {
    const load = new Map(names.map((n) => [n, 0]));
    const pick = new Map<string, { member: string; why: string }>();
    for (const c of req.conditions) {
      const work = expand(`${c.description} ${conditionDetail(c)} ${conditionWork(c)}`);
      const ranked = names
        .map((n) => ({ n, score: overlap(expand(skillsOf.get(n)!), work).length }))
        .sort((a, b) => b.score - a.score || load.get(a.n)! - load.get(b.n)!);
      const best = ranked[0]!.n;
      load.set(best, load.get(best)! + 1);
      const hit = [...contentWords(skillsOf.get(best)!)].find((w) => overlap(expand(w), work).length > 0);
      pick.set(c.id, { member: best, why: hit ? `${best} lists ${hit}.` : `${best} had the least to do.` });
    }
    return pick;
  };

  return runAssist('split', deps, () => ({ assignments: group(byKeywords()) }), async (ask) => {
    const json = (await ask({
      system: SPLIT_SYSTEM,
      user: splitUserPrompt({
        title: req.title, rawText: req.rawText,
        members: req.members.map((m) => `${m.name}: ${m.skills}`),
        checks: req.conditions.map((c) => `- ${c.id} (${c.kind === 'client_review' ? 'the client judges' : 'automatic'}): ${c.description}${conditionDetail(c) ? `; ${conditionDetail(c)}` : ''}`),
      }),
      schema: perId(req.conditions.map((c) => c.id), { type: 'object', properties: { member: { enum: names }, why: { type: 'string' } }, required: ['member', 'why'], additionalProperties: false }),
      predict: 30 + 60 * req.conditions.length,
    })) as Record<string, { member?: unknown; why?: unknown } | undefined>;
    const fallback = byKeywords();
    const pick = new Map(req.conditions.map((c) => {
      const member = names.find((n) => n === str(json?.[c.id]?.member));
      let why = sentence(json?.[c.id]?.why, 160);
      if (member && why && inventedNumbers(why, [req.rawText, skillsOf.get(member)!]).length) why = '';
      return [c.id, member ? { member, why: why || fallback.get(c.id)!.why } : fallback.get(c.id)!];
    }));
    return { assignments: group(pick) };
  });
}
