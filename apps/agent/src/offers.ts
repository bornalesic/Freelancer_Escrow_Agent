import { serviceFee, termsHash, type Escrow, type Offer } from '@escrow/shared';

// Counteroffers: pure rules, no I/O, no clock of their own. They never move money; an accepted offer only
// changes the terms both sides agree to before funding.

/** At most this many pending offers per listing (each one is an event in the log). */
export const MAX_PENDING_OFFERS = 20;

/**
 * The listing's terms at another reward: same title, asset, deadline and conditions, fee recalculated.
 * This is what a freelancer accepts by making the offer, and what the client accepts by taking it.
 */
export function offerTerms(
  e: Pick<Escrow, 'title' | 'assetId' | 'deadline' | 'conditions'>,
  amount: string,
): { fee: string; termsHash: string } {
  const fee = serviceFee(amount);
  return { fee, termsHash: termsHash({ title: e.title, amount, fee, assetId: e.assetId, deadline: e.deadline, conditions: e.conditions }) };
}

/** A new offer waits `windowSec` for the client, but never past the job's deadline. */
export function offerExpiry(now: Date, windowSec: number, deadline: string): string {
  return new Date(Math.min(now.getTime() + windowSec * 1000, Date.parse(deadline))).toISOString();
}

/** Pending offers the client did not answer in time. */
export function expiredOfferIds(offers: readonly Offer[] | undefined, now: Date): string[] {
  return (offers ?? []).filter((o) => o.status === 'pending' && now.getTime() >= Date.parse(o.expiresAt)).map((o) => o.id);
}
