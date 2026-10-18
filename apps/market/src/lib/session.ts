// What this browser remembers: the one-time tokens that make a job "mine". The clientToken comes from
// POST /escrows, the freelancerToken from POST /escrows/:id/take, an offerToken from POST /escrows/:id/offers
// (it becomes the freelancerToken if the client accepts the offer). They are only ever sent to the agent
// (in a body or the x-escrow-token header), never put in a URL. The role is not stored here: it is in
// the URL (/client/…, /freelancer/…), so two tabs on one laptop can play both sides.
import type { Escrow, PartyRole } from '@escrow/shared';

const mem = new Map<string, string>();
const key = (role: PartyRole, escrowId: string) => `market.token.${role}.${escrowId}`;
const takenKey = (escrowId: string) => `market.taken.${escrowId}`;
const offersKey = (escrowId: string) => `market.offers.${escrowId}`;
const LAST_ROLE = 'market.lastRole';

function put(k: string, value: string): void {
  mem.set(k, value);
  try {
    localStorage.setItem(k, value);
  } catch {
    // private window or blocked storage: memory only, works until reload
  }
}

function get(k: string): string | undefined {
  const inMem = mem.get(k);
  if (inMem) return inMem;
  try {
    return localStorage.getItem(k) ?? undefined;
  } catch {
    return undefined;
  }
}

export const saveToken = (role: PartyRole, escrowId: string, token: string) => put(key(role, escrowId), token);
export const getToken = (role: PartyRole, escrowId: string) => get(key(role, escrowId));

/**
 * A freelancer took a job: keep the token and when the take was accepted. If the job is not funded in
 * time it reopens and someone else may take it; then the freelancer acceptance on the job is a different
 * one and this browser's token is stale.
 */
export function saveTake(escrowId: string, token: string, acceptedAt: string): void {
  saveToken('freelancer', escrowId, token);
  put(takenKey(escrowId), acceptedAt);
}

/** A counteroffer this browser made. `at` is also the freelancer acceptance's `at` if the client takes it. */
export interface MyOffer {
  offerId: string;
  token: string;
  at: string;
}

export function myOffers(escrowId: string): MyOffer[] {
  try {
    const list = JSON.parse(get(offersKey(escrowId)) ?? '[]') as unknown;
    return Array.isArray(list) ? (list as MyOffer[]) : [];
  } catch {
    return [];
  }
}

export function saveOffer(escrowId: string, offer: MyOffer): void {
  put(offersKey(escrowId), JSON.stringify([...myOffers(escrowId).filter((o) => o.offerId !== offer.offerId), offer]));
}

/** The token this browser holds for the job's current freelancer: from a take, or from an accepted offer. */
export function freelancerToken(e: Pick<Escrow, 'id' | 'acceptances'>): string | undefined {
  const at = e.acceptances.find((a) => a.role === 'freelancer')?.at;
  if (at === undefined) return undefined;
  if (at === get(takenKey(e.id))) return getToken('freelancer', e.id);
  return myOffers(e.id).find((o) => o.at === at)?.token;
}

/** This browser created the job (client), or took it / had its offer accepted and still holds it (freelancer). */
export function isMyJob(role: PartyRole, e: Pick<Escrow, 'id' | 'acceptances'>): boolean {
  return role === 'client' ? getToken('client', e.id) !== undefined : freelancerToken(e) !== undefined;
}

/** This browser took the job once, or offered on it, but is not its freelancer now. */
export const wasInvolved = (e: Pick<Escrow, 'id' | 'acceptances'>) =>
  !isMyJob('freelancer', e) && (getToken('freelancer', e.id) !== undefined || myOffers(e.id).length > 0);

export function rememberRole(role: PartyRole): void {
  try {
    localStorage.setItem(LAST_ROLE, role);
  } catch {
    // not important
  }
}

export function lastRole(): PartyRole | undefined {
  try {
    const r = localStorage.getItem(LAST_ROLE);
    return r === 'client' || r === 'freelancer' ? r : undefined;
  } catch {
    return undefined;
  }
}
