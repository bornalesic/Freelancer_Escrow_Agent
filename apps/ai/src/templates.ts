import type { LogEventType } from '@escrow/shared';
import type { EventFacts } from './facts.ts';

// One deterministic sentence per LogEventType. Used on AI timeout/error and in mock mode.
// These double as the spec for what an AI explanation should say: facts only, no speculation.

const amt = (f: EventFacts) => f.amount ?? 'the payment';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const quote = (s: string) => `"${s.replace(/\.$/, '')}"`;

function listing(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

const TEMPLATES: Record<LogEventType, (f: EventFacts) => string> = {
  'escrow.created': (f) =>
    `A new job "${f.job}" was created for ${amt(f)}; the agreement is being turned into automatic checks.`,
  'terms.proposed': (f) => {
    const n = f.conditions?.length ?? 0;
    const extra = f.clarifications?.length
      ? ` ${plural(f.clarifications.length, 'point')} could not be checked automatically and should be discussed.`
      : '';
    return `The agreement was turned into ${plural(n, 'automatic check')}; both sides now need to review and accept them.${extra}`;
  },
  'terms.reparse_requested': () => 'The client asked for the agreement to be read again, so new terms will be proposed.',
  'terms.accepted': (f) => `The ${f.role ?? 'party'} accepted the proposed terms.`,
  'terms.agreed': (f) => `Both sides accepted exactly the same terms, so the deal for ${amt(f)} is now agreed.`,
  'funding.invoice_created': (f) =>
    `The escrow agent created an invoice for ${amt(f)} so the client can lock the payment.`,
  'funding.payment_seen': (f) =>
    `The escrow agent sees the client's payment of ${amt(f)} and is waiting for it to settle.`,
  'funding.settled': (f) =>
    `${amt(f)} is now locked in the escrow agent's wallet, so the freelancer can deliver the work.`,
  'delivery.received': (f) =>
    `The freelancer uploaded delivery #${f.delivery?.n ?? '?'}${f.delivery?.fileName ? ` (${f.delivery.fileName})` : ''}, and it will now be checked automatically.`,
  'verify.started': (f) => `The verifier started checking delivery #${f.delivery?.n ?? '?'} against the agreed conditions.`,
  'verify.condition_result': (f) => {
    const what = f.condition ? `The check ${quote(f.condition.description)}` : 'A check';
    if (!f.result) return `${what} finished.`;
    if (f.result.passed) return `${what} passed.`;
    if (f.result.failingTests?.length) {
      return `${what} failed: the test ${listing(f.result.failingTests.map(quote))} did not pass.`;
    }
    if (f.result.problem) return `${what} failed: ${f.result.problem}.`;
    return `${what} failed${f.result.exitCode !== undefined ? ` (exit code ${f.result.exitCode})` : ''}.`;
  },
  'verify.finished': (f) => {
    if (!f.checks) return `The verifier finished checking delivery #${f.delivery?.n ?? '?'}.`;
    const failed = f.checks.failed.length ? ` Failed: ${listing(f.checks.failed.map(quote))}.` : '';
    return `${f.checks.passed} of ${plural(f.checks.total, 'check')} passed.${failed}`;
  },
  'decision.made': (f) => {
    switch (f.decision?.action) {
      case 'release':
        return `Every check passed, so the agent decided to release ${amt(f)} to the freelancer.`;
      case 'retry':
        return `Not every check passed, so the ${amt(f)} stays locked and the freelancer may submit a fixed version before the deadline.`;
      case 'refund':
        return `The deadline passed without a delivery that meets the conditions, so the agent decided to refund ${amt(f)} to the client.`;
      case 'await_approval':
        return `Every automatic check passed, so the ${amt(f)} stays locked while the client reviews the delivery.`;
      case 'wait':
        return `The agent is waiting${f.decision.reason ? `: ${f.decision.reason.replace(/\.$/, '')}` : ''}.`;
      default:
        return `The agent made a decision${f.decision?.reason ? `: ${f.decision.reason.replace(/\.$/, '')}` : ''}.`;
    }
  },
  'review.report_ready': () => "QVAC's advisory review of the delivery is ready; the client makes the call.",
  'review.approved': () => 'The client approved the delivery.',
  'review.disputed': () => 'The client disputed the delivery.',
  'review.expired': () => 'The client did not answer within the review window, so the delivery counts as accepted.',
  'payout.sent': (f) => `The escrow agent sent ${amt(f)} to the freelancer and is waiting for the transfer to settle.`,
  'payout.settled': (f) => `The freelancer received ${amt(f)}, so this job is complete.`,
  'refund.sent': (f) => `The escrow agent sent ${amt(f)} back to the client and is waiting for the transfer to settle.`,
  'refund.settled': (f) => `The client got ${amt(f)} back, so this job is closed.`,
  'escrow.cancelled': (f) => `The ${f.role ?? 'job'}${f.role ? ' cancelled the job' : ' was cancelled'} before any money was locked.`,
  'error': (f) => `Something went wrong: ${(f.error ?? f.title).replace(/\.$/, '')}.`,
};

export function templateFor(facts: EventFacts): string {
  const fn = TEMPLATES[facts.step as LogEventType];
  return fn ? fn(facts) : facts.title;
}
