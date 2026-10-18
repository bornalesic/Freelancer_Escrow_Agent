import type { LogEventType } from '@escrow/shared';
import type { EventFacts } from './facts.ts';

// One deterministic sentence per LogEventType. Used on AI timeout/error and in mock mode, and as the
// reference sentence the model rewrites (explain-v3). Facts only, no speculation.

const amt = (f: EventFacts) => f.amount ?? 'the payment';
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;
const quote = (s: string) => `"${s.replace(/\.$/, '')}"`;
const deliveryNo = (f: EventFacts) => `delivery #${f.delivery?.n ?? '?'}`;

function listing(items: string[]): string {
  if (items.length <= 1) return items.join('');
  return `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`;
}

function decision(f: EventFacts): string {
  const d = f.decision;
  switch (d?.action) {
    case 'release':
      if (d.after === 'approval') return `The client approved the delivery, so the agent decided to release ${amt(f)} to the freelancer.`;
      if (d.after === 'no_answer') return `The client did not answer within the review window, so the agent decided to release ${amt(f)} to the freelancer.`;
      return `Every check passed, so the agent decided to release ${amt(f)} to the freelancer.`;
    case 'retry':
      if (d.after === 'dispute') return `The client disputed the delivery, so the ${amt(f)} stays locked and the freelancer may submit a fixed version before the deadline.`;
      return `Not every check passed, so the ${amt(f)} stays locked and the freelancer may submit a fixed version before the deadline.`;
    case 'refund':
      if (d.after === 'dispute') return `The client disputed the delivery after the deadline, so the agent decided to refund ${amt(f)} to the client.`;
      return `The deadline passed without a delivery that meets the conditions, so the agent decided to refund ${amt(f)} to the client.`;
    case 'await_approval':
      return `Every automatic check passed, so the ${amt(f)} stays locked while the client reviews ${plural(d.pending ?? 1, 'item')}.`;
    case 'cancel':
      return 'The job closed before anyone funded it, so no money moved.';
    case 'reopen':
      return 'The job was not funded in time, so it is back on the marketplace for another freelancer; no money moved.';
    case 'wait':
      return `The agent is waiting${d.reason ? `: ${d.reason.replace(/\.$/, '')}` : ''}.`;
    default:
      return `The agent made a decision${d?.reason ? `: ${d.reason.replace(/\.$/, '')}` : ''}.`;
  }
}

const TEMPLATES: Record<LogEventType, (f: EventFacts) => string> = {
  'escrow.created': (f) =>
    `A new job "${f.job}" was created for ${amt(f)}; the agreement is being turned into automatic checks.`,
  'terms.proposed': (f) => {
    const n = f.conditions?.length ?? 0;
    const r = f.clientReview?.length ?? 0;
    const review = r ? ` and ${plural(r, 'item')} the client will judge` : '';
    const extra = f.clarifications?.length
      ? ` ${f.clarifications.length === 1 ? '1 point still needs' : `${f.clarifications.length} points still need`} to be agreed.`
      : '';
    return `The agreement was turned into ${plural(n, 'automatic check')}${review}; both sides now need to review and accept them.${extra}`;
  },
  'terms.reparse_requested': () => 'The client asked for the agreement to be read again, so new terms will be proposed.',
  'terms.accepted': (f) => `The ${f.role ?? 'party'} accepted the proposed terms.`,
  'terms.agreed': (f) => `Both sides accepted exactly the same terms, so the deal for ${amt(f)} is now agreed.`,
  'listing.published': (f) =>
    `The client approved the requirements, so the job for ${amt(f)} is now open for freelancers to take.`,
  'offer.made': (f) => `A freelancer offered to do the job for ${amt(f)}; the client can accept it before it expires.`,
  'offer.withdrawn': (f) => `The freelancer withdrew the offer of ${amt(f)}; no money moved.`,
  'offer.declined': (f) => `The offer of ${amt(f)} was declined because the job went another way; no money moved.`,
  'offer.expired': (f) => `The offer of ${amt(f)} expired because the client did not answer in time; no money moved.`,
  'funding.reopened': () =>
    "The client's payment did not arrive in time, so the job is back on the marketplace; no money moved.",
  'funding.invoice_created': (f) =>
    `The escrow agent created an invoice for ${amt(f)} so the client can lock the payment.`,
  'funding.payment_seen': (f) =>
    `The escrow agent sees the client's payment of ${amt(f)} and is waiting for it to settle.`,
  'funding.settled': (f) =>
    `${amt(f)} is now locked in the escrow agent's wallet, so the freelancer can deliver the work.`,
  'delivery.received': (f) =>
    `The freelancer uploaded ${deliveryNo(f)}${f.delivery?.fileName ? ` (${f.delivery.fileName})` : ''}, and it will now be checked automatically.`,
  'verify.started': (f) => `The verifier started checking ${deliveryNo(f)} against the automatic checks.`,
  'verify.condition_result': (f) => {
    const what = f.condition ? `The check ${quote(f.condition.description)}` : 'A check';
    if (!f.result) return `${what} finished.`;
    if (f.result.passed) return `${what} passed.`;
    if (f.result.failingTests?.length) {
      const values = f.result.expected !== undefined && f.result.actual !== undefined
        ? ` (it expected "${f.result.expected}" but got "${f.result.actual}")` : '';
      return `${what} failed: the test ${listing(f.result.failingTests.map(quote))} did not pass${values}.`;
    }
    if (f.result.problem) return `${what} failed: ${f.result.problem}.`;
    return `${what} failed${f.result.exitCode !== undefined ? ` (exit code ${f.result.exitCode})` : ''}.`;
  },
  'verify.finished': (f) => {
    if (!f.checks) return `The verifier finished checking ${deliveryNo(f)}.`;
    const failed = f.checks.failed.length ? ` Failed: ${listing(f.checks.failed.map(quote))}.` : '';
    return `${f.checks.passed} of ${plural(f.checks.total, 'check')} passed.${failed}`;
  },
  'decision.made': decision,
  'review.report_ready': (f) => {
    const r = f.review;
    if (!r) return `QVAC's advisory review of ${deliveryNo(f)} is ready; the client makes the call.`;
    const parts = [
      r.looksMet ? `${r.looksMet} looks met` : '',
      r.looksUnmet ? `${r.looksUnmet} looks unmet` : '',
      r.unsure ? `${r.unsure} unsure` : '',
    ].filter(Boolean);
    return `QVAC's advisory review of ${deliveryNo(f)} is ready (${listing(parts)}); the client makes the call.`;
  },
  'review.approved': (f) => `The client approved ${deliveryNo(f)}.`,
  'review.disputed': (f) =>
    `The client disputed ${deliveryNo(f)}${f.dispute?.reason ? `: ${quote(f.dispute.reason)}` : ''}.`,
  'review.expired': (f) =>
    `The client did not answer within the review window, so ${deliveryNo(f)} counts as accepted.`,
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
