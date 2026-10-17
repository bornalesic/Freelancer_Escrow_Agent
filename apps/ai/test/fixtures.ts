import { readFileSync } from 'node:fs';
import path from 'node:path';
import type { Escrow, LogEvent } from '@escrow/shared';
import { REPO_ROOT } from '../src/config.ts';
import type { AgreementCase } from '../src/evalCheck.ts';

export const agreements = JSON.parse(
  readFileSync(path.join(REPO_ROOT, 'fixtures/agreements.json'), 'utf8'),
) as AgreementCase[];

export const slugify = agreements.find((c) => c.id === 'slugify-demo')!;

export const NODE_TEST_FAILURE = `TAP version 13
# Subtest: lowercases text
ok 1 - lowercases text
# Subtest: replaces spaces with dashes
ok 2 - replaces spaces with dashes
# Subtest: strips punctuation: "Hello, World!" → "hello-world"
not ok 3 - strips punctuation: "Hello, World!" → "hello-world"
  ---
  duration_ms: 1.2
  ...
ok 4 - keeps numbers
1..4
# tests 4
# pass 3
# fail 1`;

export function escrow(over: Partial<Escrow> = {}): Escrow {
  return {
    id: 'esc_7f3a',
    title: 'Slugify function',
    rawText: slugify.rawText,
    amount: '50000000',
    assetId: 'rgb:asset-id',
    assetTicker: 'tUSDT',
    precision: 6,
    deadline: '2026-10-18T12:00:00Z',
    state: 'VERIFYING',
    summary: 'Build slugify.',
    clarifications: [],
    conditions: [
      { id: 'c1', kind: 'tests_pass', description: 'All the included tests must pass.', command: 'npm test', timeoutSec: 60 },
      { id: 'c2', kind: 'file_present', description: 'A README file must be included.', pathPattern: 'README*' },
    ],
    acceptances: [],
    deliveries: [{ n: 1, fileName: 'slugify-v1.zip', sha256: 'a'.repeat(64), sizeBytes: 1234, at: '2026-10-17T12:00:00Z' }],
    createdAt: '2026-10-17T11:00:00Z',
    updatedAt: '2026-10-17T12:00:00Z',
    ...over,
  };
}

export function event(type: LogEvent['type'], data?: Record<string, unknown>, over: Partial<LogEvent> = {}): LogEvent {
  return {
    id: 'esc_7f3a:0007',
    escrowId: 'esc_7f3a',
    at: '2026-10-17T12:00:01Z',
    actor: 'verifier',
    type,
    title: `Title for ${type}`,
    data,
    explain: true,
    ...over,
  };
}
