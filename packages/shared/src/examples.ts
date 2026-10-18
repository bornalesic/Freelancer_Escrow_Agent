import { z } from 'zod';

// AI-written acceptance checks ("examples"): QVAC proposes example inputs with the expected output, both
// parties agree to them (they are conditions, so they are inside termsHash), and the verifier runs them.
// The model only writes data; the test file is rendered by code (renderExamplesTest), so the same file
// runs in the verifier and can be downloaded by the freelancer for a local dry run.
//
// Standalone on purpose: WS3 adds ExamplesConditionSchema to ConditionSchema when the verifier runs it.

const JS_IDENTIFIER = /^[A-Za-z_$][\w$]*$/;

export const ExampleCaseSchema = z.object({
  input: z.string().max(500),    // js_function: the only argument; command: written to stdin
  expected: z.string().max(500), // js_function: the return value as text; command: stdout (trailing whitespace ignored)
});
export type ExampleCase = z.infer<typeof ExampleCaseSchema>;

export const ExamplesTargetSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('js_function'),
    export: z.string().regex(JS_IDENTIFIER), // the function's name, e.g. "slugify"
    file: z.string().min(1).optional(),      // relative path; absent = package.json "main", index.js, <export>.js, src/…
  }),
  z.object({
    type: z.literal('command'),
    command: z.string().min(1), // run in the delivery root, e.g. "python main.py"
  }),
]);
export type ExamplesTarget = z.infer<typeof ExamplesTargetSchema>;

export const ExamplesConditionSchema = z.object({
  id: z.string().min(1),
  description: z.string().min(1),
  kind: z.literal('examples'),
  target: ExamplesTargetSchema,
  cases: z.array(ExampleCaseSchema).min(1).max(10),
  timeoutSec: z.number().int().positive().max(600),
});
export type ExamplesCondition = z.infer<typeof ExamplesConditionSchema>;

const short = (s: string, max = 60) => (s.length > max ? `${s.slice(0, max - 1)}…` : s);

/** Test name shown in the verifier output and quoted by /explain: `slugify("Hello, World!") → "hello-world"`. */
export function exampleTestName(target: ExamplesTarget, ex: ExampleCase): string {
  const input = JSON.stringify(short(ex.input));
  const expected = JSON.stringify(short(ex.expected));
  return target.type === 'js_function' ? `${target.export}(${input}) → ${expected}` : `input ${input} → ${expected}`;
}

/** Command that runs a rendered test file; run it with the delivery root as cwd. */
export function examplesTestCommand(testFilePath: string): string {
  return `node --test --test-reporter=spec ${JSON.stringify(testFilePath)}`;
}

/**
 * A self-contained `node:test` file (ESM, zero dependencies) that checks every case. Write it OUTSIDE the
 * unpacked delivery (so the delivery cannot replace it) and run `examplesTestCommand(path)` with the
 * delivery root as cwd. js_function: the result is compared as text (`String`, or JSON for objects),
 * promises are awaited. command: stdout is compared with trailing whitespace removed.
 */
export function renderExamplesTest(c: Pick<ExamplesCondition, 'id' | 'target' | 'cases'>): string {
  const cases = c.cases.map((ex) => ({ name: exampleTestName(c.target, ex), input: ex.input, expected: ex.expected }));
  return [
    `// Acceptance examples for condition ${JSON.stringify(c.id).slice(1, -1)}, rendered by the escrow agent from the agreed terms.`,
    '// Run from the delivery folder: node --test <this file>',
    "import { test } from 'node:test';",
    "import assert from 'node:assert/strict';",
    "import { spawnSync } from 'node:child_process';",
    "import { existsSync, readFileSync } from 'node:fs';",
    "import path from 'node:path';",
    "import { pathToFileURL } from 'node:url';",
    '',
    '// No stack frames: the verifier keeps only the last 40 lines, and they should name the failing examples.',
    'Error.stackTraceLimit = 0;',
    'const ROOT = process.cwd();',
    `const TARGET = ${JSON.stringify(c.target)};`,
    `const CASES = ${JSON.stringify(cases, null, 2)};`,
    'const CASE_TIMEOUT_MS = 10000;',
    '',
    'function inside(p) {',
    '  const abs = path.resolve(ROOT, p);',
    '  return abs.startsWith(ROOT + path.sep) ? abs : undefined;',
    '}',
    '',
    'function entryFile() {',
    '  if (TARGET.file) return inside(TARGET.file);',
    '  const candidates = [];',
    '  try {',
    "    const pkg = JSON.parse(readFileSync(path.join(ROOT, 'package.json'), 'utf8'));",
    "    if (typeof pkg.main === 'string') candidates.push(pkg.main);",
    '  } catch {}',
    "  const name = TARGET.export;",
    "  candidates.push('index.js', 'index.mjs', name + '.js', name + '.mjs', 'src/index.js', 'src/' + name + '.js');",
    '  for (const c of candidates) {',
    '    const abs = inside(c);',
    '    if (abs && existsSync(abs)) return abs;',
    '  }',
    '  return undefined;',
    '}',
    '',
    'let fn;',
    'async function load() {',
    '  if (fn) return fn;',
    '  const file = entryFile();',
    "  if (!file || !existsSync(file)) throw new Error('Could not find the file that exports ' + TARGET.export + (TARGET.file ? ' (' + TARGET.file + ')' : ' (tried package.json main, index.js, ' + TARGET.export + '.js)'));",
    '  const mod = await import(pathToFileURL(file).href);',
    "  const f = mod[TARGET.export] ?? mod.default?.[TARGET.export] ?? (typeof mod.default === 'function' ? mod.default : undefined);",
    "  if (typeof f !== 'function') throw new Error(path.relative(ROOT, file) + ' does not export a function named ' + TARGET.export);",
    '  fn = f;',
    '  return fn;',
    '}',
    '',
    "const asText = (v) => (typeof v === 'string' ? v : v === undefined ? 'undefined' : typeof v === 'object' ? JSON.stringify(v) : String(v));",
    '',
    'for (const c of CASES) {',
    '  test(c.name, { timeout: CASE_TIMEOUT_MS }, async () => {',
    "    if (TARGET.type === 'js_function') {",
    '      const f = await load();',
    '      assert.equal(asText(await f(c.input)), c.expected);',
    '    } else {',
    "      const r = spawnSync(TARGET.command, { cwd: ROOT, input: c.input, shell: true, encoding: 'utf8', timeout: CASE_TIMEOUT_MS });",
    '      if (r.error) throw r.error;',
    '      assert.equal(r.stdout.trimEnd(), c.expected.trimEnd());',
    '    }',
    '  });',
    '}',
    '',
  ].join('\n');
}
