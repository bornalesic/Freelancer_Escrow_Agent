// Local stand-ins for the agent's WebSocket `snapshot` (open any view with `?fixture=1`).
// Test data only: the slugify demo after the first delivery failed, waiting for v2; the bakery
// landing page (client review) after the client disputed v1, with v2 awaiting approval
// (`?fixture=1&escrow=esc_b4k3`); and proposed titleCase terms for the AI assist screens
// (`?fixture=1&escrow=esc_t1c4`).
import { termsHash, type Condition, type Escrow, type LogEvent } from '@escrow/shared';
import type { EscrowView } from '../lib/escrowStore';

const ID = 'esc_7f3a';
const HASH = ''; // filled in by withHash()
/** The real termsHash of the fixture's terms (and in both acceptances), so the UI's hash check passes. */
function withHash(e: Escrow): Escrow {
  const h = termsHash(e);
  return { ...e, termsHash: h, acceptances: e.acceptances.map((a) => ({ ...a, termsHash: h })) };
}

const t = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 17, 10, min, sec)).toISOString();

export const fixtureEscrow: Escrow = withHash({
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
});

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
  ev({ at: t(1, 31), actor: 'agent', type: 'terms.agreed', title: `Both parties agreed to the same terms (hash ${fixtureEscrow.termsHash?.slice(0, 4)}…)`, explain: false }),
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

// ---- client review: bakery landing page ---------------------------------------------------------

const RID = 'esc_b4k3';
const RHASH = ''; // filled in by withHash()
const r = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 17, 9, min, sec)).toISOString();
// Relative to page load, so the review countdown is visible when you open the fixture.
const soon = (sec: number) => new Date(Date.now() + sec * 1_000).toISOString();

export const reviewFixtureEscrow: Escrow = withHash({
  id: RID,
  title: 'Bakery landing page',
  rawText:
    'Build a one-page landing site for my bakery as index.html. Also include a README. The page should look clean and use warm colours. Pay 30 USDT. Deadline: 30 minutes.',
  amount: '30000000',
  assetId: 'rgb:fixture-asset-id',
  assetTicker: 'tUSDT',
  precision: 6,
  deadline: soon(20 * 60),
  state: 'AWAITING_APPROVAL',
  summary:
    'The freelancer delivers a one-page bakery site as index.html with a README. The client judges whether it looks clean and uses warm colours, then 30 USDT is paid.',
  clarifications: [],
  conditions: [
    { id: 'c1', kind: 'file_present', description: 'The page is index.html', pathPattern: 'index.html' },
    { id: 'c2', kind: 'file_present', description: 'A README is included', pathPattern: 'README.md' },
    { id: 'c3', kind: 'client_review', description: 'The page looks clean and uses warm colours' },
  ],
  termsHash: RHASH,
  acceptances: [
    { role: 'client', termsHash: RHASH, at: r(1) },
    { role: 'freelancer', termsHash: RHASH, at: r(1, 20) },
  ],
  fundingInvoice: 'rgb:fixture-funding-invoice-2',
  refundInvoice: 'rgb:fixture-refund-invoice-2',
  payoutInvoice: 'rgb:fixture-payout-invoice-3',
  deliveries: [
    {
      n: 1,
      fileName: 'landing-v1.zip',
      sha256: '175c034cb93a2f9436ad01d1d1f27329b8d58aa7bfd8eaaa24df42023140d79a',
      sizeBytes: 1772,
      at: r(4),
      results: [
        { conditionId: 'c1', passed: true, evidence: { matched: ['index.html'], durationMs: 2 } },
        { conditionId: 'c2', passed: true, evidence: { matched: ['README.md'], durationMs: 1 } },
      ],
      reviewDueAt: r(6, 5),
      review: {
        items: [
          {
            conditionId: 'c3',
            opinion: 'looks_unmet',
            note: 'The layout is clean, but the header is dark navy blue (#1e3a5f) and the accent is bright blue, which are cool colours, not warm ones.',
          },
        ],
        source: 'ai',
        model: 'qwen3-1.7b',
        ms: 4210,
      },
      approval: { decision: 'dispute', at: r(5, 10), reason: 'The header should use warm colours, like orange or cream.' },
    },
    {
      n: 2,
      fileName: 'landing-v2.zip',
      sha256: '1bcc306b7b913988d4160b0a622a43c343c3ca603f22f053de48402e4739b378',
      sizeBytes: 1780,
      at: r(8),
      results: [
        { conditionId: 'c1', passed: true, evidence: { matched: ['index.html'], durationMs: 2 } },
        { conditionId: 'c2', passed: true, evidence: { matched: ['README.md'], durationMs: 1 } },
      ],
      reviewDueAt: soon(105),
      review: {
        items: [
          {
            conditionId: 'c3',
            opinion: 'looks_met',
            note: 'The page now uses burnt orange (#c2410c), honey yellow and cream, which are warm colours, and the layout stays simple and tidy.',
          },
        ],
        source: 'ai',
        model: 'qwen3-1.7b',
        ms: 3980,
      },
    },
  ],
  createdAt: r(0),
  updatedAt: r(8, 9),
});

let rseq = 0;
const rev = (e: Omit<LogEvent, 'id' | 'escrowId'>): LogEvent => ({
  id: `${RID}:${String(++rseq).padStart(4, '0')}`,
  escrowId: RID,
  ...e,
});

export const reviewFixtureEvents: LogEvent[] = [
  rev({ at: r(0), actor: 'client', type: 'escrow.created', title: 'Client created the agreement', explain: false }),
  rev({
    at: r(0, 20), actor: 'ai', type: 'terms.proposed', title: 'Proposed 2 checks and 1 client review', explain: true,
    explanation: 'Two things a machine can check: index.html and a README must be there. Whether the page looks clean and warm is for the client to judge.',
    explanationSource: 'ai',
  }),
  rev({ at: r(1, 21), actor: 'agent', type: 'terms.agreed', title: `Both parties agreed to the same terms (hash ${reviewFixtureEscrow.termsHash?.slice(0, 4)}…)`, explain: false }),
  rev({ at: r(2, 10), actor: 'wallet', type: 'funding.settled', title: '30 tUSDT locked in escrow', explain: false }),
  rev({ at: r(4), actor: 'freelancer', type: 'delivery.received', title: 'Delivery 1 received: landing-v1.zip', explain: false }),
  rev({ at: r(4, 2), actor: 'verifier', type: 'verify.finished', title: '2 of 2 checks passed', explain: false }),
  rev({
    at: r(4, 3), actor: 'agent', type: 'decision.made', title: 'Decision: waiting for the client to review', explain: false,
    data: { action: 'await_approval' },
  }),
  rev({ at: r(4, 8), actor: 'ai', type: 'review.report_ready', title: 'AI review ready: 0 of 1 looks met', explain: false }),
  rev({
    at: r(5, 10), actor: 'client', type: 'review.disputed', title: 'Client disputed delivery 1', explain: true,
    explanation: 'The client said the header should use warm colours. The money stays locked and the freelancer can send a fixed version.',
    explanationSource: 'ai',
  }),
  rev({
    at: r(5, 11), actor: 'agent', type: 'decision.made', title: 'Decision: no payment yet, retry allowed', explain: false,
    data: { action: 'retry' },
  }),
  rev({ at: r(8), actor: 'freelancer', type: 'delivery.received', title: 'Delivery 2 received: landing-v2.zip', explain: false }),
  rev({ at: r(8, 2), actor: 'verifier', type: 'verify.finished', title: '2 of 2 checks passed', explain: false }),
  rev({
    at: r(8, 3), actor: 'agent', type: 'decision.made', title: 'Decision: waiting for the client to review', explain: true,
    data: { action: 'await_approval' },
    explanation: 'Every automatic check passed. Now the client looks at the page and decides. If they do not answer within two minutes, the freelancer is paid.',
    explanationSource: 'template',
  }),
  rev({
    at: r(8, 9), actor: 'ai', type: 'review.report_ready', title: 'AI review ready: 1 of 1 looks met', explain: true,
    explanation: 'QVAC thinks the new colours are warm. This is only advice: the client makes the call.',
    explanationSource: 'ai',
  }),
];

// ---- AI assist: proposed terms with an `examples` check and two client-review items -------------
// (`?fixture=1&escrow=esc_t1c4`): verifiability score, "Make it checkable", Q&A, team split, examples.

const AID = 'esc_t1c4';
const a = (min: number, sec = 0) => new Date(Date.UTC(2026, 9, 17, 8, min, sec)).toISOString();

/** An `examples` condition (not in ConditionSchema until WS3 flips it, hence the cast). */
const examplesCondition = {
  id: 'c1',
  kind: 'examples',
  description: 'titleCase returns the agreed output for 2 example inputs.',
  target: { type: 'js_function', export: 'titleCase' },
  cases: [
    { input: 'hello world', expected: 'Hello World' },
    { input: 'the quick fox', expected: 'The Quick Fox' },
  ],
  timeoutSec: 30,
} as unknown as Condition;

export const assistFixtureEscrow: Escrow = withHash({
  id: AID,
  title: 'titleCase helper',
  rawText:
    'Build a JavaScript function `titleCase` that capitalises the first letter of each word. For example, "hello world" becomes "Hello World" and "the quick fox" becomes "The Quick Fox". Make the docs nice and keep the code clean. Pay 40 USDT. Deadline: 2 hours.',
  amount: '40000000',
  assetId: 'rgb:fixture-asset-id',
  assetTicker: 'tUSDT',
  precision: 6,
  deadline: soon(2 * 3600),
  state: 'PROPOSED',
  summary:
    'The freelancer builds a JavaScript titleCase function. The 40 tUSDT are released once titleCase gives the agreed output for every example and the client approves what they review.',
  clarifications: [],
  conditions: [
    examplesCondition,
    { id: 'c2', kind: 'client_review', description: 'Make the docs nice.' },
    { id: 'c3', kind: 'client_review', description: 'Keep the code clean.' },
  ],
  termsHash: '',
  acceptances: [],
  deliveries: [],
  createdAt: a(0),
  updatedAt: a(0, 20),
});

export const assistFixtureEvents: LogEvent[] = [
  { id: `${AID}:0001`, escrowId: AID, at: a(0), actor: 'client', type: 'escrow.created', title: 'Client created the agreement', explain: false },
  {
    id: `${AID}:0002`, escrowId: AID, at: a(0, 20), actor: 'ai', type: 'terms.proposed', title: 'AI proposed 1 check and 2 items for the client to judge', explain: true,
    explanation: 'The two examples became an automatic check. Whether the docs are nice and the code is clean is for the client to judge.',
    explanationSource: 'ai',
  },
];

/** Every escrow shown in fixture mode. */
export const fixtureViews: EscrowView[] = [
  { escrow: fixtureEscrow, events: fixtureEvents },
  { escrow: reviewFixtureEscrow, events: reviewFixtureEvents },
  { escrow: assistFixtureEscrow, events: assistFixtureEvents },
];
