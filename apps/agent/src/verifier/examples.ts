import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { examplesTestCommand, renderExamplesTest, type ExamplesCondition } from '@escrow/shared';
import { runCommand, type CommandResult } from './tests';

/**
 * Did every agreed example really run and pass? Exit code 0 is not enough: the delivery's code is imported
 * into the test process, and a module that calls `process.exit(0)` on import makes `node --test` report the
 * file itself as one passed test without running a single example. So we read the runner's final summary
 * (printed by the parent process after the test process is gone, so the delivery can't print after it) and
 * also refuse the file-level "✔ <test file>" line that only appears when the file ran no tests.
 */
export function examplesPassed(r: Pick<CommandResult, 'exitCode' | 'timedOut' | 'output' | 'error'>, testFile: string, cases: number): string | undefined {
  if (r.timedOut || r.error || r.exitCode !== 0) return undefined; // a plain failure: the output says why
  const last = (key: string) => {
    const all = [...r.output.matchAll(new RegExp(`^ℹ ${key} (\\d+)$`, 'gm'))];
    return all.length ? Number(all[all.length - 1]![1]) : undefined;
  };
  const tests = last('tests'), pass = last('pass'), fail = last('fail');
  const fileOnly = r.output.split('\n').some((l) => l.startsWith(`✔ ${testFile}`));
  if (fileOnly || tests !== cases || pass !== cases || fail !== 0) {
    return `The examples did not run: expected ${cases} passing example${cases === 1 ? '' : 's'}, the test runner reported ${pass ?? 0} of ${tests ?? 0}`;
  }
  return 'ok';
}

/**
 * Run an `examples` condition: render the agreed cases into a test file in a fresh folder outside the delivery,
 * written right before the run (so nothing the delivery did earlier can have replaced it), and run it with the
 * delivery root as cwd. Same evidence as `tests_pass`.
 */
export async function runExamples(c: ExamplesCondition, root: string) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'escrow-acceptance-'));
  try {
    const file = path.join(dir, `${c.id}.test.mjs`);
    fs.writeFileSync(file, renderExamplesTest(c), { mode: 0o444 });
    const r = await runCommand(examplesTestCommand(file), root, c.timeoutSec);
    const verdict = examplesPassed(r, file, c.cases.length);
    const error = r.error ?? (verdict && verdict !== 'ok' ? verdict : undefined);
    return {
      conditionId: c.id,
      passed: verdict === 'ok',
      evidence: {
        ...(r.exitCode !== undefined ? { exitCode: r.exitCode } : {}),
        stdoutTail: r.output.split(dir + path.sep).join(''), // "c3.test.mjs", not our temp path
        durationMs: r.durationMs,
        ...(error ? { error } : {}),
      },
    };
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
}
