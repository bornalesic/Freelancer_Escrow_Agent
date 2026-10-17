import { isAutomaticCondition, type Decision, type Escrow, type VerificationResult } from '@escrow/shared';

/**
 * The ONLY place where money decisions are made. Pure: no I/O, no clock, no AI.
 *
 * - VERIFYING, every automatic check passed, no client_review → release (even if verification ends
 *                                                              after the deadline: the delivery was on time)
 * - VERIFYING, every automatic check passed, has client_review → await_approval
 * - VERIFYING, something failed, before the deadline          → retry (back to FUNDED)
 * - VERIFYING, something failed, deadline passed              → refund
 * - FUNDED and the deadline passed                            → refund (no passing delivery, or it would be released)
 * - AWAITING_APPROVAL, latest delivery:
 *     approved → release; disputed before the deadline → retry; disputed after → refund;
 *     no answer and the review window is over → release; otherwise → wait.
 *   The deadline alone never refunds here: that work passed every automatic check in time.
 * - anything else                                             → wait
 *
 * A condition without a result counts as failed. An escrow with no conditions can never be released.
 * Never reads `delivery.review`: the AI's opinion is for people only.
 */
export function decide(
  escrow: Pick<Escrow, 'state' | 'deadline' | 'conditions'> & { deliveries?: Escrow['deliveries'] },
  results: readonly VerificationResult[],
  now: Date,
): Decision {
  const deadlinePassed = now.getTime() >= Date.parse(escrow.deadline);
  const reviewIds = escrow.conditions.filter((c) => !isAutomaticCondition(c)).map((c) => c.id);

  if (escrow.state === 'FUNDED') {
    return deadlinePassed
      ? { action: 'refund', reason: 'The deadline passed without a delivery that passed every check.' }
      : { action: 'wait', reason: 'Waiting for the freelancer to deliver.' };
  }

  if (escrow.state === 'AWAITING_APPROVAL') {
    const delivery = escrow.deliveries?.at(-1);
    const approval = delivery?.approval;
    if (approval?.decision === 'approve') return { action: 'release', reason: 'The client approved the work.' };
    if (approval?.decision === 'dispute') {
      return deadlinePassed
        ? { action: 'refund', reason: 'The client disputed the work and the deadline has passed.' }
        : {
            action: 'retry',
            reason: 'The client disputed the work. The freelancer can deliver again before the deadline.',
            failed: reviewIds,
          };
    }
    if (delivery?.reviewDueAt && now.getTime() >= Date.parse(delivery.reviewDueAt)) {
      return { action: 'release', reason: 'The client did not answer before the review window closed.' };
    }
    return { action: 'wait', reason: "Waiting for the client's review." };
  }

  if (escrow.state !== 'VERIFYING') {
    return { action: 'wait', reason: `Nothing to decide while the escrow is ${escrow.state}.` };
  }

  const passed = new Set(results.filter((r) => r.passed).map((r) => r.conditionId));
  const automatic = escrow.conditions.filter(isAutomaticCondition).map((c) => c.id);
  const failed = automatic.filter((id) => !passed.has(id));
  const total = automatic.length;

  if (escrow.conditions.length > 0 && failed.length === 0) {
    if (reviewIds.length > 0) {
      return {
        action: 'await_approval',
        reason: total === 0
          ? 'There are no automatic checks. The client reviews the work.'
          : `All ${total} automatic checks passed. The client reviews the rest.`,
        pending: reviewIds,
      };
    }
    return { action: 'release', reason: `All ${total} checks passed.` };
  }
  if (!deadlinePassed) {
    return {
      action: 'retry',
      reason: escrow.conditions.length === 0
        ? 'There are no checks to pass, so the money cannot be released.'
        : `${failed.length} of ${total} checks failed. The freelancer can deliver again before the deadline.`,
      failed,
    };
  }
  return {
    action: 'refund',
    reason: `${failed.length} of ${total} checks failed and the deadline has passed.`,
  };
}
