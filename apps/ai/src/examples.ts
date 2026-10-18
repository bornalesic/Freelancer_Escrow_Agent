import {
  ConditionSchema, exampleTestName,
  type ExampleCase, type ExamplesCondition, type ExamplesTarget, type ParseRequest,
} from '@escrow/shared';
import type { LlmEngine } from './llm.ts';
import { extractJson } from './json.ts';
import {
  EXAMPLES_OUTPUT_SCHEMA, EXAMPLES_PROMPT_INPUTS, EXAMPLES_SYSTEM, EXAMPLE_INPUTS_SYSTEM, EXAMPLE_OUTPUTS_SYSTEM,
  exampleInputsUserPrompt, exampleOutputsUserPrompt, examplesInputsSchema, examplesOutputsSchema, examplesUserPrompt,
} from './assistPrompts.ts';

// AI-written acceptance checks. The model only writes example inputs + expected outputs (data); the test
// file is rendered by code (`renderExamplesTest` in @escrow/shared) and both parties accept the exact cases.
// Grounding: the function name / command must be written in the agreement, examples written literally in
// the agreement always win, and cases copied from the prompt's own example are dropped.

export type ExamplesDraft = Omit<ExamplesCondition, 'id'>;

const MAX_MODEL_CASES = 4;
const MAX_CASES = 8;
const TIMEOUT_SEC = 30;
const EXAMPLES_MAX_TOKENS = 600;
const EXAMPLES_PRIORITY = 10; // part of /parse

/** True once `examples` is part of ConditionSchema, i.e. the agent's verifier can run it (WS3 lands it). */
export function examplesInContract(): boolean {
  return ConditionSchema.safeParse({
    id: 'c1', kind: 'examples', description: 'x', target: { type: 'js_function', export: 'f' },
    cases: [{ input: 'a', expected: 'b' }], timeoutSec: 30,
  }).success;
}

// ---- What is being checked -------------------------------------------------------------------------

const IDENT = '[A-Za-z_$][\\w$]*';
const FUNCTION_NAME = [
  new RegExp(`\\bfunction\\s+(?:called\\s+|named\\s+)?\`(${IDENT})(?:\\([^\`]*\\))?\``, 'i'), // function `slugify`
  new RegExp(`\`(${IDENT})(?:\\([^\`]*\\))?\`\\s+function\\b`, 'i'),                          // `slugify` function
  new RegExp(`\\bfunction\\s+(?:called|named)\\s+(${IDENT})\\b`, 'i'),                         // function called slugify
  new RegExp(`\\bfunction\\s+(${IDENT})\\s*\\(`, 'i'),                                         // function slugify(text)
  new RegExp(`\`(${IDENT})\\([^\`]*\\)\``),                                                    // `slugify(text)`
];
const NOT_A_NAME = new Set(['that', 'which', 'to', 'for', 'in', 'the', 'a', 'an', 'and', 'with', 'called', 'named', 'returns', 'function']);
const JS = /\b(?:java\s?script|node(?:\.?js)?|npm|js)\b|\.[mc]?js\b/i;
const OTHER_LANGUAGE = /\b(?:python|typescript|ruby|rust|golang|kotlin|swift|php|c\+\+|c#|java(?!\s?script))\b/i;
const JS_FILE = /(?<![\w./-])(?:[\w-]+\/)*[\w-]+\.[mc]?js(?![\w-])/g;
const COMMAND = /`((?:node|python3?|ruby|deno run|bun|php|go run|\.\/)[^`]*)`/i;
const TEST_COMMAND = /\b(?:test|--test|pytest|jest|vitest|mocha)\b/i;
const CLI = /\b(?:cli|command[- ]line|stdin|standard input|prints?|outputs?)\b/i;
// The agreement must say what the output is (some behaviour verb), or give literal examples.
const BEHAVIOUR = /\b(?:returns?|converts?|turns?|transforms?|outputs?|prints?|computes?|calculates?|counts?|lowercases?|uppercases?|capitali[sz]es?|replaces?|strips?|removes?|formats?|parses?|sorts?|reverses?|validates?|adds?|sums?|encodes?|decodes?|generates?|rounds?|trims?|joins?|splits?|keeps?|makes?|drops?|collapses?)\b/i;

/** The function (JS only: the verifier imports it with Node) or command the examples run against. */
export function findTarget(rawText: string): ExamplesTarget | undefined {
  for (const re of FUNCTION_NAME) {
    const name = re.exec(rawText)?.[1];
    if (!name || NOT_A_NAME.has(name.toLowerCase())) continue;
    if (!JS.test(rawText) || OTHER_LANGUAGE.test(rawText)) break;
    const files = [...new Set([...rawText.matchAll(JS_FILE)].map((m) => m[0]))].filter((f) => !/\.(?:test|spec)\./i.test(f));
    return { type: 'js_function', export: name, ...(files.length === 1 ? { file: files[0] } : {}) };
  }
  const command = COMMAND.exec(rawText)?.[1]?.trim();
  if (command && !TEST_COMMAND.test(command) && CLI.test(rawText)) return { type: 'command', command };
  return undefined;
}

export const targetLabel = (t: ExamplesTarget) => (t.type === 'js_function' ? t.export : t.command);

const BEHAVIOUR_VERB = new RegExp(`^(?:${BEHAVIOUR.source.replace(/^\\b\(\?:|\)\\b$/g, '')})\\b`, 'i');

/**
 * The output rules of the sentence that names the target, split at "," / "and" before a behaviour verb:
 * "lowercases text, replaces spaces with dashes and strips anything that isn't a letter, number or dash"
 * → 3 rules (the comma inside the last one is not followed by a verb, so it stays).
 */
export function outputRules(rawText: string, target: ExamplesTarget): string[] {
  const label = targetLabel(target);
  const sentence = rawText.split(/(?<=[.!?])\s+|\n+/).find((s) => s.includes(label));
  const tail = sentence && /\b(?:that|which|to)\s+(.+)$/i.exec(sentence.slice(sentence.indexOf(label) + label.length))?.[1];
  if (!tail) return [];
  const rules: string[] = [];
  let current = '';
  for (const part of tail.replace(/[.!?]+$/, '').split(/(,\s*(?:and\s+)?|\s+and\s+)/)) {
    if (/^(?:,\s*(?:and\s+)?|\s+and\s+)$/.test(part)) { current += part; continue; }
    if (current && BEHAVIOUR_VERB.test(part)) { rules.push(current.replace(/(?:,\s*(?:and\s+)?|\s+and\s+)$/, '').trim()); current = part; }
    else current += part;
  }
  if (current.trim()) rules.push(current.trim());
  return rules.filter((r) => BEHAVIOUR_VERB.test(r)).slice(0, 5);
}

// ---- Examples written in the agreement -------------------------------------------------------------

const QUOTED = /"([^"\n]{0,200})"|“([^”\n]{0,200})”|‘([^’\n]{0,200})’|`([^`\n]{0,200})`|(?<!\w)'([^'\n]{0,200})'(?!\w)/g;
const ARROW = /^\)?\s*(?:→|->|=>|⇒|becomes|should become|must become|turns into|should turn into|gives|should give|must give|returns|should return|must return|outputs|should output|must output|prints|should print|must print|is|={1,3})\s*:?\s*$/i;

function unquote(s: string): string {
  const m = /^(["'`])(.*)\1$/.exec(s.trim());
  return m ? m[2]! : s;
}

/** `"Hello World" → "hello-world"`, `slugify('A B') returns 'a-b'`, `` `slugify("X")` → `"x"` ``. */
export function literalExamples(rawText: string, target?: ExamplesTarget): ExampleCase[] {
  const spans = [...rawText.matchAll(QUOTED)].map((m) => ({
    start: m.index!, end: m.index! + m[0].length, text: m.slice(1).find((g) => g !== undefined) ?? '',
  }));
  const call = target?.type === 'js_function' ? new RegExp(`^${target.export.replace(/\$/g, '\\$')}\\((.*)\\)$`) : undefined;
  const out: ExampleCase[] = [];
  for (let i = 0; i + 1 < spans.length; i++) {
    const a = spans[i]!;
    const b = spans[i + 1]!;
    if (!ARROW.test(rawText.slice(a.end, b.start))) continue;
    let input = a.text;
    const inner = call?.exec(input.trim());
    if (inner) input = unquote(inner[1]!);
    const expected = unquote(b.text);
    if (!input || out.some((c) => c.input === input)) continue;
    out.push({ input, expected });
    i++; // b was used as an output
  }
  return out.slice(0, MAX_CASES);
}

// ---- Model cases + guards --------------------------------------------------------------------------

const PRINTABLE = /^[\x20-\x7E]*$/;

const stepResult = (step: string) => unquote(step.slice(step.lastIndexOf(':') + 1).trim());

/**
 * Drops cases the agreement does not settle or that came from the prompt; literal examples win. With
 * `ruleCount`, a case must apply every rule (one step each) and at least one step must change the text.
 */
export function cleanCases(raw: unknown, literal: ExampleCase[], rawText: string, notes: string[], ruleCount?: number): ExampleCase[] {
  const items = Array.isArray((raw as { cases?: unknown })?.cases) ? (raw as { cases: unknown[] }).cases : [];
  const text = rawText.toLowerCase();
  const out: ExampleCase[] = [];
  for (const item of items) {
    const o = (item ?? {}) as { input?: unknown; expected?: unknown; steps?: unknown };
    const input = typeof o.input === 'string' ? o.input : '';
    const expected = typeof o.expected === 'string' ? unquote(o.expected) : '';
    const steps = Array.isArray(o.steps) ? o.steps.filter((x): x is string => typeof x === 'string') : undefined;
    const results = steps?.map(stepResult);
    const last = results?.at(-1);
    const why =
      !input || !expected ? 'empty input or output'
      : ruleCount && steps?.length !== ruleCount ? `${steps?.length ?? 0} steps for ${ruleCount} rules`
      : steps && last !== expected ? `its last step says ${JSON.stringify(last)}`
      : ruleCount && results!.every((r, i) => r === (i ? results![i - 1] : input)) ? 'no rule changes this input'
      : input.length > 200 || expected.length > 200 ? 'too long'
      : !PRINTABLE.test(input) || !PRINTABLE.test(expected) ? 'characters the agreement does not cover'
      : input !== input.trim() || /\s{2}/.test(input) ? 'extra spaces the agreement does not cover'
      : EXAMPLES_PROMPT_INPUTS.includes(input.toLowerCase()) && !text.includes(input.toLowerCase()) ? 'copied from the prompt example'
      : literal.some((l) => l.input === input) || out.some((c) => c.input === input) ? 'duplicate input'
      : '';
    if (why) {
      notes.push(`examples: dropped ${JSON.stringify(input)} → ${JSON.stringify(expected)} (${why})`);
      continue;
    }
    out.push({ input, expected });
  }
  return out.slice(0, MAX_MODEL_CASES);
}

export function examplesDraft(target: ExamplesTarget, cases: ExampleCase[]): ExamplesDraft | undefined {
  const all = cases.slice(0, MAX_CASES);
  if (!all.length) return undefined;
  const n = `${all.length} example input${all.length === 1 ? '' : 's'}`;
  const description = target.type === 'js_function'
    ? `${target.export} returns the agreed output for ${n}.`
    : `The command "${target.command}" prints the agreed output for ${n}.`;
  return { kind: 'examples', description, target, cases: all, timeoutSec: TIMEOUT_SEC };
}

/** Examples the fallback parser can use: only the ones written literally in the agreement. */
export function literalExamplesDraft(rawText: string): ExamplesDraft | undefined {
  const target = findTarget(rawText);
  return target ? examplesDraft(target, literalExamples(rawText, target)) : undefined;
}

/**
 * Literal examples + up to 5 model cases. Never throws: on any model problem only the literal examples are
 * used. Returns undefined when there is no grounded target or nothing to check.
 */
export async function proposeExamples(
  req: ParseRequest,
  engine: LlmEngine | null,
  signal: AbortSignal,
  log: (msg: string) => void,
): Promise<ExamplesDraft | undefined> {
  const target = findTarget(req.rawText);
  if (!target) return undefined;
  const literal = literalExamples(req.rawText, target);
  if (!engine?.status().loaded || (!literal.length && !BEHAVIOUR.test(req.rawText))) return examplesDraft(target, literal);
  const rules = outputRules(req.rawText, target);
  const ask = async (system: string, user: string, schema: Record<string, unknown>, predict: number) => {
    const out = await engine.generate({
      messages: [{ role: 'system', content: system }, { role: 'user', content: user }],
      predict, jsonSchema: schema, signal, priority: EXAMPLES_PRIORITY,
    });
    return extractJson(out.text) as Record<string, unknown>;
  };
  try {
    const t0 = performance.now();
    const notes: string[] = [];
    let raw: unknown;
    if (rules.length >= 2) {
      // examples-v3: (1) one input per rule, (2) all rules applied to each input, step by step.
      const picked = await ask(EXAMPLE_INPUTS_SYSTEM, exampleInputsUserPrompt(target, rules), examplesInputsSchema(rules.length), 60 * rules.length);
      const inputs = [...new Set(rules.map((_, i) => (picked?.[`r${i + 1}`] as { input?: unknown } | undefined)?.input))]
        .filter((x): x is string => typeof x === 'string' && x.length > 0);
      const outs = inputs.length
        ? await ask(EXAMPLE_OUTPUTS_SYSTEM, exampleOutputsUserPrompt(rules, inputs), examplesOutputsSchema(inputs.length, rules.length), 40 + 40 * rules.length * inputs.length)
        : {};
      raw = { cases: inputs.map((input, i) => ({ input, ...(outs?.[`i${i + 1}`] as object | undefined) })) };
    } else {
      raw = await ask(EXAMPLES_SYSTEM, examplesUserPrompt(req, target, literal), EXAMPLES_OUTPUT_SCHEMA, EXAMPLES_MAX_TOKENS);
    }
    const cases = cleanCases(raw, literal, req.rawText, notes, rules.length >= 2 ? rules.length : undefined);
    for (const n of notes) log(`parse: guard: ${n}`);
    log(`parse: examples for ${targetLabel(target)}: ${literal.length} literal + ${cases.length} from the model (${Math.round(performance.now() - t0)} ms): ${cases.map((c) => exampleTestName(target, c)).join('; ')}`);
    return examplesDraft(target, [...literal, ...cases]);
  } catch (e) {
    log(`parse: examples model call failed (${(e as Error).message}); using ${literal.length} literal example(s)`);
    return examplesDraft(target, literal);
  }
}

/** A client-review quote about the same function/command is checked by the examples now. */
export function coveredByExamples(quote: string, d: ExamplesDraft | undefined): boolean {
  if (!d) return false;
  const label = targetLabel(d.target).toLowerCase();
  return d.target.type === 'js_function'
    ? new RegExp(`(?<![\\w$])${label.replace(/\$/g, '\\$')}(?![\\w$])`, 'i').test(quote)
    : quote.toLowerCase().includes(label);
}
