import { exampleTestName } from '@escrow/shared';
import type { AnyCondition } from './fallback.ts';

/** The checkable detail of a condition in words (command, file, examples), for prompts and term search. */
export function conditionDetail(c: AnyCondition): string {
  switch (c.kind) {
    case 'tests_pass': return `command "${c.command}" must pass`;
    case 'file_present': return `file ${c.pathPattern} must be included`;
    case 'file_hash': return `${c.fileName ?? 'the upload'} must have SHA-256 ${c.sha256}`;
    case 'examples': return `examples: ${c.cases.map((x) => exampleTestName(c.target, x)).join('; ')}`;
    case 'client_review': return '';
  }
}

/** Short label of what kind of work a condition is, for keyword matching in /assist/split. */
export function conditionWork(c: AnyCondition): string {
  switch (c.kind) {
    case 'tests_pass':
    case 'examples': return 'code programming developer tests testing javascript python';
    case 'file_present': return /readme|doc|license|changelog/i.test(c.pathPattern) ? 'docs documentation writing readme' : 'files code';
    case 'file_hash': return 'files assets';
    case 'client_review': return 'design review ui ux css look colours';
  }
}
