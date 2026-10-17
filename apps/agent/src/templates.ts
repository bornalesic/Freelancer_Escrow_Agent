import { formatAmount, isAutomaticCondition, type AiReview, type Escrow, type LogEvent } from '@escrow/shared';

/**
 * One deterministic sentence per event, used when the AI explanation times out or fails.
 * Restates only facts from the event and escrow.
 */
export function explanationTemplate(event: LogEvent, escrow: Escrow): string {
  const money = `${formatAmount(escrow.amount, escrow.precision)} ${escrow.assetTicker}`;
  const d = event.data ?? {};
  const reason = typeof d.reason === 'string' ? `${d.reason} ` : '';
  switch (event.type) {
    case 'terms.proposed': {
      const auto = escrow.conditions.filter(isAutomaticCondition).length;
      const review = escrow.conditions.length - auto;
      return `The agreement was turned into ${auto} automatic checks${review ? ` and ${review} item(s) the client judges` : ''}. Both sides must accept these exact terms before any money moves.`;
    }
    case 'terms.agreed':
      return `Client and freelancer accepted the same terms. Next, the client locks ${money} with the escrow agent.`;
    case 'funding.settled':
      return `${money} is now held by the escrow agent's own wallet on Bitcoin. It can only go to the freelancer if the checks pass, or back to the client.`;
    case 'verify.condition_result':
      return `The check "${String(d.description ?? d.conditionId ?? '')}" did not pass, so no money is released for this delivery.`;
    case 'decision.made':
      if (d.action === 'release') return `${reason}The agent pays ${money} to the freelancer.`;
      if (d.action === 'refund') return `${reason}The agent returns ${money} to the client.`;
      if (d.action === 'await_approval') {
        return `Every automatic check passed. The client now reviews the work; if they don't answer in time, the freelancer is paid.`;
      }
      return `${reason}The money stays locked until a delivery is accepted or the deadline passes.`;
    case 'review.disputed':
      return `The client disputed the work, so no money is released for this delivery. The freelancer sees the reason.`;
    case 'review.expired':
      return `The client did not approve or dispute in time, so the work counts as accepted.`;
    case 'payout.settled':
      return `The freelancer received ${money}. The escrow is complete.`;
    case 'refund.settled':
      return `The client received ${money} back. The escrow is closed.`;
    case 'error':
      return `Something went wrong: ${event.title}. The agent will retry this step automatically.`;
    default:
      return event.title;
  }
}

/** The review stored when the AI is down or fails: every client_review item `unsure`. */
export function templateReview(escrow: Pick<Escrow, 'conditions'>, ms: number): AiReview {
  return {
    items: escrow.conditions
      .filter((c) => !isAutomaticCondition(c))
      .map((c) => ({
        conditionId: c.id,
        opinion: 'unsure' as const,
        note: 'The AI review is not available. Please look at the delivered files yourself.',
      })),
    source: 'template',
    ms,
  };
}

/** Keep exactly one item per client_review condition, in term order; fill gaps with `unsure`. */
export function normalizeReview(review: AiReview, escrow: Pick<Escrow, 'conditions'>): AiReview {
  const byId = new Map(review.items.map((i) => [i.conditionId, i]));
  return {
    ...review,
    items: escrow.conditions
      .filter((c) => !isAutomaticCondition(c))
      .map((c) => byId.get(c.id) ?? { conditionId: c.id, opinion: 'unsure' as const, note: 'The AI gave no opinion on this item.' }),
  };
}
