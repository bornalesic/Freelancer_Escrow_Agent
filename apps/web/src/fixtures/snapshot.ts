// Local stand-in for the agent's WebSocket `snapshot` (open any view with `?fixture=1`).
// Test data only: the slugify demo after the first delivery failed, waiting for v2.
import type { Escrow, LogEvent } from '@escrow/shared';

const ID = 'esc_7f3a';
const HASH = 'a3f9c2d17be04f6a9c58e1d2b7f3a0c4e6d9b2a1f8c7e5d3b0a9f6e4c2d1b0a9';
const t = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 17, 10, min, sec)).toISOString();

export const fixtureEscrow: Escrow = {
  id: ID,
  title: 'slugify function',
  rawText:
    "Build a JavaScript function `slugify` that lowercases text, replaces spaces with dashes and strips anything that isn't a letter, number or dash. The included tests must pass. Also include a README. Pay 50 USDT. Deadline: 30 minutes.",
  amount: '50000000',
  assetId: 'rgb:fixture-asset-id',
  assetTicker: 'tUSDT',
  precision: 6,
  deadline: t(30),
  state: 'FUNDED',
  summary:
    'The freelancer delivers a JavaScript slugify function with its tests and a README. The client pays 50 USDT when all tests pass, within 30 minutes.',
  clarifications: [],
  conditions: [
    { id: 'c1', kind: 'tests_pass', description: 'The included tests pass', command: 'npm test', timeoutSec: 60 },
    { id: 'c2', kind: 'file_present', description: 'A README is included', pathPattern: 'README.md' },
  ],
  termsHash: HASH,
  acceptances: [
    { role: 'client', termsHash: HASH, at: t(1) },
    { role: 'freelancer', termsHash: HASH, at: t(1, 30) },
  ],
  fundingInvoice: 'rgb:fixture-funding-invoice',
  refundInvoice: 'rgb:fixture-refund-invoice',
  payoutInvoice: 'rgb:fixture-payout-invoice-1',
  deliveries: [
    {
      n: 1,
      fileName: 'slugify-v1.zip',
      sha256: '1b2c3d4e5f60718293a4b5c6d7e8f90112233445566778899aabbccddeeff00',
      sizeBytes: 2143,
      at: t(4),
      results: [
        {
          conditionId: 'c1',
          passed: false,
          evidence: {
            exitCode: 1,
            stdoutTail:
              '✔ lowercases text\n✔ replaces spaces with dashes\n✖ strips punctuation: "Hello, World!" → "hello-world"\n  expected "hello-world" but got "hello,-world!"\n✔ keeps numbers\n# tests 4\n# pass 3\n# fail 1',
            durationMs: 812,
          },
        },
        { conditionId: 'c2', passed: true, evidence: { matched: ['README.md'], durationMs: 3 } },
      ],
    },
  ],
  createdAt: t(0),
  updatedAt: t(4, 5),
};

let seq = 0;
const ev = (e: Omit<LogEvent, 'id' | 'escrowId'>): LogEvent => ({
  id: `${ID}:${String(++seq).padStart(4, '0')}`,
  escrowId: ID,
  ...e,
});

export const fixtureEvents: LogEvent[] = [
  ev({ at: t(0), actor: 'client', type: 'escrow.created', title: 'Client created the agreement', explain: false }),
  ev({
    at: t(0, 20), actor: 'ai', type: 'terms.proposed', title: 'Proposed 2 checks', explain: true,
    explanation: 'The agreement became two checks a machine can verify: the tests must pass, and a README must be included.',
    explanationSource: 'ai',
  }),
  ev({ at: t(1), actor: 'client', type: 'terms.accepted', title: 'Client accepted the terms', explain: false }),
  ev({ at: t(1, 30), actor: 'freelancer', type: 'terms.accepted', title: 'Freelancer accepted the terms', explain: false }),
  ev({ at: t(1, 31), actor: 'agent', type: 'terms.agreed', title: 'Both parties agreed to the same terms (hash a3f9…)', explain: false }),
  ev({ at: t(1, 32), actor: 'wallet', type: 'funding.invoice_created', title: 'Agent created a funding invoice for 50 tUSDT', explain: false }),
  ev({ at: t(2), actor: 'wallet', type: 'funding.payment_seen', title: 'Payment of 50 tUSDT seen', explain: false }),
  ev({
    at: t(2, 10), actor: 'wallet', type: 'funding.settled', title: '50 tUSDT locked in escrow', explain: true,
    explanation: "The money now sits in the agent's own wallet on Bitcoin via RGB. It can only go to the freelancer or back to the client.",
    explanationSource: 'ai',
  }),
  ev({ at: t(4), actor: 'freelancer', type: 'delivery.received', title: 'Delivery 1 received: slugify-v1.zip', explain: false }),
  ev({ at: t(4, 1), actor: 'verifier', type: 'verify.started', title: 'Checking delivery 1', explain: false }),
  ev({ at: t(4, 2), actor: 'verifier', type: 'verify.condition_result', title: 'Tests pass: failed (1 of 4 tests failed)', explain: false }),
  ev({ at: t(4, 2), actor: 'verifier', type: 'verify.condition_result', title: 'README included: passed', explain: false }),
  ev({ at: t(4, 3), actor: 'verifier', type: 'verify.finished', title: '1 of 2 checks passed', explain: false }),
  ev({
    at: t(4, 5), actor: 'agent', type: 'decision.made', title: 'Decision: no payment yet, retry allowed', explain: true,
    explanation:
      'The test "strips punctuation" failed: "Hello, World!" became "hello,-world!" instead of "hello-world". The freelancer can upload a fixed version before the deadline.',
    explanationSource: 'template',
  }),
];
