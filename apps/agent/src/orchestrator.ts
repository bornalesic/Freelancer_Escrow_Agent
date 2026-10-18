import fs from 'node:fs';
import path from 'node:path';
import {
  InvoiceResponseSchema,
  PARTY_ROUTES,
  PartyHealthResponseSchema,
  TERMINAL_STATES,
  escrowTotal,
  formatAmount,
  isAutomaticCondition,
  newEscrowId,
  serviceFee,
  termsHash,
  type Acceptance,
  type AcceptOfferRequest,
  type AiReview,
  type ApproveRequest,
  type CreateEscrowRequest,
  type Decision,
  type Escrow,
  type EscrowState,
  type MakeOfferRequest,
  type Offer,
  type OfferStatus,
  type PartyRole,
  type VerificationResult,
} from '@escrow/shared';
import type { AiClient } from './ai-client';
import { checkClientToken, newClientToken } from './client-token';
import type { Config } from './config';
import { decide } from './decide';
import type { Dev } from './dev';
import { log } from './log';
import type { EventSpec, Machine } from './machine';
import { MAX_PENDING_OFFERS, expiredOfferIds, offerExpiry, offerTerms } from './offers';
import type { Store } from './store';
import {
  HttpError,
  KeyedMutex,
  StepError,
  TimeoutError,
  conflict,
  errorMessage,
  notFound,
  nowIso,
  short,
  sleep,
  safeNow,
} from './util';
import { templateReview, normalizeReview } from './templates';
import { checkCondition, prepareWorkspace } from './verifier';
import { buildReviewFiles } from './verifier/excerpt';
import { deliveryRoot } from './verifier/files';
import { hashFile } from './verifier/hash';
import type { WalletHolder } from './wallet';

export interface OrchestratorDeps {
  config: Config;
  store: Store;
  machine: Machine;
  wallets: WalletHolder;
  ai: AiClient;
  dev: Dev;
}

export interface Upload {
  tmpPath: string;
  fileName: string;
  sizeBytes: number;
}

const CANCELLABLE: readonly EscrowState[] = ['DRAFT', 'PROPOSED', 'OPEN', 'AGREED', 'AWAITING_FUNDS'];
const BEFORE_FUNDING: readonly EscrowState[] = ['DRAFT', 'PROPOSED', 'OPEN', 'AGREED'];

const cap = (role: PartyRole) => (role === 'client' ? 'Client' : 'Freelancer');

/** Why a marketplace action needs an OPEN listing and this one isn't. */
function notOpen(state: EscrowState): string {
  if (state === 'DRAFT' || state === 'PROPOSED') return 'This job is not on the marketplace';
  if (state === 'CANCELLED') return 'This listing is closed';
  return 'Another freelancer already took this job';
}
const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`;

/**
 * Drives each escrow through its steps. HTTP actions change state under a per-escrow mutex; the
 * background steps are level-triggered from the current state (`resume()`), so after a restart or
 * an error the ticker simply calls `resume()` again and the escrow carries on from where it is.
 */
export class Orchestrator {
  private locks = new KeyedMutex();
  private busy = new Set<string>();
  private again = new Set<string>();
  /** `${escrowId}:${n}` of AI reviews in flight, so the ticker doesn't start a second one. */
  private reviewing = new Set<string>();

  constructor(private d: OrchestratorDeps) {}

  // ---- helpers -------------------------------------------------------------------------------

  private money(e: Escrow, amount = e.amount): string {
    return `${formatAmount(amount, e.precision)} ${e.assetTicker}`;
  }

  private mustGet(id: string): Escrow {
    const e = this.d.store.get(id);
    if (!e) throw notFound('Escrow');
    return e;
  }

  private lock<T>(id: string, fn: () => T | Promise<T>): Promise<T> {
    return this.locks.run(id, fn);
  }

  private get wallet() {
    return this.d.wallets.wallet;
  }

  /** True when the wallet can be used; throws (→ error event) if it failed to start. */
  private walletReady(): boolean {
    if (this.d.wallets.ready) return true;
    if (this.d.wallets.error) throw new StepError('The agent wallet is not available', 'wallet', this.d.wallets.error);
    return false;
  }

  private async walletCall<T>(title: string, fn: () => Promise<T>): Promise<T> {
    try {
      return await fn();
    } catch (err) {
      throw new StepError(title, 'wallet', errorMessage(err));
    }
  }

  /**
   * Marketplace escrows: the action needs the role's own token (the client's from POST /escrows, the
   * freelancer's from POST /take). The both-parties flow keeps trusting the role in the body (LAN demo).
   * Same hashing as the clientToken, so the same constant-time check.
   */
  private requireToken(id: string, role: PartyRole, token: string | undefined): void {
    const internal = this.d.store.internal(id);
    if (!internal.marketplace) return;
    const hash = role === 'client' ? internal.clientTokenHash : internal.freelancerTokenHash;
    if (!token || !checkClientToken(token, hash)) {
      throw new HttpError(403, role === 'client'
        ? 'Only the client who posted this job can do that'
        : 'Only the freelancer who took this job can do that');
    }
  }

  /**
   * Who may open a delivery's files. The both-parties flow keeps its open file browser (LAN demo).
   * Marketplace escrows: the freelancer always sees its own upload; the client and the agent's own
   * laptop (the projector) see image previews until the work is paid, and everything after release.
   * Anyone else: nothing. The client must not get the work before it pays for it.
   */
  fileAccess(id: string, token: string | undefined, fromAgentLaptop: boolean): 'all' | 'images' | 'none' {
    const e = this.mustGet(id);
    const internal = this.d.store.internal(id);
    if (!internal.marketplace) return 'all';
    if (token !== undefined && checkClientToken(token, internal.freelancerTokenHash)) return 'all';
    const isClient = token !== undefined && checkClientToken(token, internal.clientTokenHash);
    if (!isClient && !fromAgentLaptop) return 'none';
    return e.state === 'RELEASED' ? 'all' : 'images';
  }

  /** decide() with what the agent's wallet has seen of the funding payment. */
  private decideNow(e: Escrow, results: readonly VerificationResult[] = []): Decision {
    const internal = this.d.store.internal(e.id);
    const funding = internal.fundingFailed ? 'failed' : internal.fundingSeen ? 'seen' : 'none';
    return decide({ ...e, funding }, results, safeNow());
  }

  private decisionSpec(e: Escrow, decision: Decision): EventSpec {
    const titles: Record<Decision['action'], string> = {
      release: `Decision: release ${this.money(e)} to the freelancer`,
      refund: `Decision: refund ${this.money(e, escrowTotal(e))} to the client`,
      cancel: e.state === 'OPEN'
        ? 'Decision: close the listing, nobody took it before the deadline'
        : 'Decision: cancel, the job was not funded before the deadline',
      reopen: 'Decision: back on the marketplace, the job was not funded',
      retry:
        e.state === 'AWAITING_APPROVAL'
          ? 'Decision: no payment yet, the client disputed the work'
          : `Decision: no payment yet, ${decision.action === 'retry' ? plural(decision.failed.length, 'check') : ''} failed`,
      await_approval: "Decision: automatic checks passed, waiting for the client's review",
      wait: 'Decision: wait',
    };
    return {
      type: 'decision.made',
      actor: 'agent',
      title: titles[decision.action],
      data: { ...decision, delivery: e.deliveries.at(-1)?.n },
      explain: true,
    };
  }

  // ---- HTTP actions --------------------------------------------------------------------------

  /** Returns the escrow and the one-time clientToken (only its hash is stored). */
  async create(body: CreateEscrowRequest): Promise<{ escrow: Escrow; clientToken: string }> {
    const deadline = new Date(body.deadline);
    if (deadline.getTime() <= Date.now()) throw new HttpError(400, 'The deadline must be in the future');
    let id = newEscrowId();
    while (this.d.store.has(id)) id = newEscrowId();
    const now = nowIso();
    const { config } = this.d;
    const escrow: Escrow = {
      id,
      title: body.title,
      rawText: body.rawText,
      amount: BigInt(body.amount).toString(),
      fee: serviceFee(body.amount),
      assetId: config.assetId,
      assetTicker: config.assetTicker,
      precision: config.precision,
      deadline: deadline.toISOString(),
      state: 'DRAFT',
      conditions: [],
      acceptances: [],
      deliveries: [],
      createdAt: now,
      updatedAt: now,
    };
    const { token, hash } = newClientToken();
    this.d.store.patchInternal(id, { clientTokenHash: hash });
    this.d.machine.create(escrow, {
      type: 'escrow.created',
      actor: 'client',
      title: `Client created "${escrow.title}" for ${this.money(escrow)}`,
      data: { amount: escrow.amount, deadline: escrow.deadline },
    });
    this.kick(id);
    return { escrow, clientToken: token };
  }

  reparse(id: string, rawText?: string, clientToken?: string): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (e.state !== 'DRAFT' && e.state !== 'PROPOSED' && e.state !== 'OPEN') {
        throw conflict(`The agreement can only be re-read before both parties agree (state is ${e.state})`);
      }
      this.requireToken(id, 'client', clientToken);
      const { store, machine } = this.d;
      store.patchInternal(id, { parseSeq: store.internal(id).parseSeq + 1 });
      const patch = {
        rawText: rawText ?? e.rawText,
        conditions: [],
        acceptances: [],
        termsHash: undefined,
        summary: undefined,
        clarifications: undefined,
      };
      const spec: EventSpec = { type: 'terms.reparse_requested', actor: 'client', title: 'Client asked to re-read the agreement' };
      let next: Escrow;
      if (e.state === 'PROPOSED' || e.state === 'OPEN') {
        // From OPEN this unlists the job: the edited terms get a new termsHash and need approving again,
        // and offers made on the old terms are void.
        next = machine.transition(e, 'DRAFT', spec, patch);
        next = this.closeOffers(next, 'declined', 'the client changed the job');
      } else {
        next = machine.update(e, patch);
        machine.record(next, spec);
      }
      this.kick(id);
      return next;
    });
  }

  accept(id: string, body: { role: PartyRole; termsHash: string; signature?: string; address?: string }): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      const { role } = body;
      const mine = e.acceptances.find((a) => a.role === role);
      if (mine && mine.termsHash === body.termsHash && e.termsHash === body.termsHash) return e; // idempotent
      if (e.state !== 'PROPOSED') throw conflict(`Terms can only be accepted while they are proposed (state is ${e.state})`);
      if (!e.termsHash || e.conditions.length === 0) {
        throw conflict('There are no checks to agree on. Edit the agreement and re-read it.');
      }
      if (body.termsHash !== e.termsHash) {
        throw conflict('These terms are out of date. Reload and review the current terms.', { currentTermsHash: e.termsHash });
      }
      const acceptance: Acceptance = {
        role,
        termsHash: body.termsHash,
        at: nowIso(),
        ...(body.signature ? { signature: body.signature } : {}),
        ...(body.address ? { address: body.address } : {}),
      };
      const { machine } = this.d;
      let next = machine.update(e, { acceptances: [...e.acceptances.filter((a) => a.role !== role), acceptance] });
      machine.record(next, {
        type: 'terms.accepted',
        actor: role,
        title: `${cap(role)} accepted the terms${body.signature ? ' (signed)' : ''}`,
        data: { termsHash: body.termsHash, signed: Boolean(body.signature) },
      });
      const agreed = (['client', 'freelancer'] as const).every((r) =>
        next.acceptances.some((a) => a.role === r && a.termsHash === next.termsHash),
      );
      if (agreed) {
        next = machine.transition(next, 'AGREED', {
          type: 'terms.agreed',
          actor: 'agent',
          title: `Both parties agreed to the same terms (hash ${short(next.termsHash)})`,
          data: { termsHash: next.termsHash },
          explain: true,
        });
        this.kick(id);
      }
      return next;
    });
  }

  /**
   * The client approves the proposed requirements: that counts as the client accepting this exact
   * termsHash, and the job goes OPEN on the marketplace. A job with no automatic checks can be published
   * too: every delivery then waits for the client's review (decide() → await_approval).
   */
  publish(id: string, body: { termsHash: string; clientToken: string }): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (!checkClientToken(body.clientToken, this.d.store.internal(id).clientTokenHash)) {
        throw new HttpError(403, 'Only the client who created this job can publish it');
      }
      if (e.state === 'OPEN' && e.termsHash === body.termsHash) return e; // idempotent
      if (e.state !== 'PROPOSED') throw conflict(`Only proposed requirements can be published (state is ${e.state})`);
      if (!e.termsHash || body.termsHash !== e.termsHash) {
        throw conflict('These requirements are out of date. Review the current version.', { currentTermsHash: e.termsHash });
      }
      if (safeNow().getTime() >= Date.parse(e.deadline)) throw conflict('The deadline has already passed');
      this.d.store.patchInternal(id, { marketplace: true });
      const acceptance: Acceptance = { role: 'client', termsHash: e.termsHash, at: nowIso() };
      return this.d.machine.transition(
        e,
        'OPEN',
        {
          type: 'listing.published',
          actor: 'client',
          title: `Client published the job for ${this.money(e)} (+ ${this.money(e, e.fee ?? '0')} fee, terms ${short(e.termsHash)})`,
          data: { termsHash: e.termsHash, amount: e.amount, fee: e.fee, total: escrowTotal(e) },
          explain: true,
        },
        { acceptances: [acceptance] },
      );
    });
  }

  /**
   * A freelancer takes an OPEN listing at its terms. The first one wins; the client already accepted the
   * same termsHash, so the escrow is AGREED and the funding window starts.
   */
  take(id: string, body: { termsHash: string }): Promise<{ escrow: Escrow; freelancerToken: string }> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (e.state !== 'OPEN') throw conflict(notOpen(e.state));
      if (!e.termsHash || body.termsHash !== e.termsHash) {
        throw conflict('The client changed this job. Review the current version.', { currentTermsHash: e.termsHash });
      }
      if (safeNow().getTime() >= Date.parse(e.deadline)) throw conflict('The deadline has passed');
      const { token, hash } = newClientToken();
      this.d.store.patchInternal(id, { freelancerTokenHash: hash, fundingSeen: false, fundingFailed: false });
      const acceptance: Acceptance = { role: 'freelancer', termsHash: e.termsHash, at: nowIso() };
      const fundingDueAt = new Date(safeNow().getTime() + this.d.config.fundingWindowSec * 1000).toISOString();
      const next = this.d.machine.transition(
        e,
        'AGREED',
        {
          type: 'terms.agreed',
          actor: 'freelancer',
          title: `A freelancer took the job: both sides agreed to the same terms (hash ${short(e.termsHash)})`,
          data: { termsHash: e.termsHash, fundingDueAt },
          explain: true,
        },
        { acceptances: [...e.acceptances.filter((a) => a.role !== 'freelancer'), acceptance], fundingDueAt },
      );
      this.kick(id);
      return { escrow: this.closeOffers(next, 'declined', 'another freelancer took the job at the listed reward'), freelancerToken: token };
    });
  }

  /**
   * A freelancer offers to do an OPEN listing for another reward (any amount above zero). Making the offer is that freelancer accepting the
   * listing's terms at this amount (offerTerms); nothing changes for anyone else until the client accepts.
   */
  makeOffer(id: string, body: MakeOfferRequest): Promise<{ escrow: Escrow; offerId: string; offerToken: string }> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (e.state !== 'OPEN') throw conflict(notOpen(e.state));
      if (!e.termsHash || body.termsHash !== e.termsHash) {
        throw conflict('The client changed this job. Review the current version.', { currentTermsHash: e.termsHash });
      }
      const now = safeNow();
      if (now.getTime() >= Date.parse(e.deadline)) throw conflict('The deadline has passed');
      const amount = BigInt(body.amount).toString();
      const offers = e.offers ?? [];
      if (offers.filter((o) => o.status === 'pending').length >= MAX_PENDING_OFFERS) {
        throw conflict('This listing has too many open offers. Try again later.');
      }
      const terms = offerTerms(e, amount);
      const offerId = `o${offers.length + 1}`;
      const { token, hash } = newClientToken();
      const internal = this.d.store.internal(id);
      this.d.store.patchInternal(id, { offerTokenHashes: { ...internal.offerTokenHashes, [offerId]: hash } });
      const offer: Offer = {
        id: offerId,
        amount,
        fee: terms.fee,
        termsHash: terms.termsHash,
        ...(body.note ? { note: body.note } : {}),
        at: nowIso(),
        expiresAt: offerExpiry(now, this.d.config.offerWindowSec, e.deadline),
        status: 'pending',
      };
      const { machine } = this.d;
      const next = machine.update(e, { offers: [...offers, offer] });
      // The note is the freelancer's free text: shown to the client, never put in the log the AI reads.
      machine.record(next, {
        type: 'offer.made',
        actor: 'freelancer',
        title: `A freelancer offered to do it for ${this.money(e, amount)} (listed at ${this.money(e)})`,
        data: { offerId, amount, fee: terms.fee, termsHash: terms.termsHash, expiresAt: offer.expiresAt },
      });
      return { escrow: next, offerId, offerToken: token };
    });
  }

  /**
   * The client takes a counteroffer: the terms become the offer's (amount, fee, termsHash), which that
   * freelancer accepted by making it and the client accepts now, so the escrow is AGREED and the funding
   * window starts, as after a take. Every other pending offer is declined.
   */
  acceptOffer(id: string, offerId: string, body: AcceptOfferRequest): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      const internal = this.d.store.internal(id);
      if (!checkClientToken(body.clientToken, internal.clientTokenHash)) {
        throw new HttpError(403, 'Only the client who posted this job can accept an offer');
      }
      const offer = e.offers?.find((o) => o.id === offerId);
      if (!offer) throw notFound('Offer');
      if (offer.status === 'accepted' && e.termsHash === offer.termsHash) return e; // idempotent
      if (e.state !== 'OPEN') throw conflict(notOpen(e.state));
      if (offer.status !== 'pending') throw conflict(`This offer was ${offer.status}`);
      const now = safeNow();
      if (now.getTime() >= Date.parse(offer.expiresAt)) throw conflict('This offer has expired');
      if (now.getTime() >= Date.parse(e.deadline)) throw conflict('The deadline has passed');
      if (body.termsHash !== offer.termsHash || offerTerms(e, offer.amount).termsHash !== offer.termsHash) {
        throw conflict('This offer does not match the current job. Reload and review it.');
      }
      const tokenHash = internal.offerTokenHashes?.[offerId];
      if (!tokenHash) throw new StepError('The offer has no token', 'system');
      this.d.store.patchInternal(id, { freelancerTokenHash: tokenHash, fundingSeen: false, fundingFailed: false });
      const acceptances: Acceptance[] = [
        { role: 'client', termsHash: offer.termsHash, at: nowIso() },
        { role: 'freelancer', termsHash: offer.termsHash, at: offer.at }, // agreed when it made the offer
      ];
      const fundingDueAt = new Date(now.getTime() + this.d.config.fundingWindowSec * 1000).toISOString();
      const closedAt = nowIso();
      const next = this.d.machine.transition(
        e,
        'AGREED',
        {
          type: 'terms.agreed',
          actor: 'client',
          title: `Client accepted a counteroffer of ${this.money(e, offer.amount)}: both sides agreed to the new terms (hash ${short(offer.termsHash)})`,
          data: { termsHash: offer.termsHash, offerId, amount: offer.amount, fee: offer.fee, listedAmount: e.amount, fundingDueAt },
          explain: true,
        },
        {
          amount: offer.amount,
          fee: offer.fee,
          termsHash: offer.termsHash,
          acceptances,
          fundingDueAt,
          offers: (e.offers ?? []).map((o) => (o.id === offerId ? { ...o, status: 'accepted' as const, closedAt } : o)),
        },
      );
      this.kick(id);
      return this.closeOffers(next, 'declined', 'the client accepted another offer');
    });
  }

  /** The freelancer who made a pending offer takes it back (its offerToken). */
  withdrawOffer(id: string, offerId: string, offerToken: string): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      const offer = e.offers?.find((o) => o.id === offerId);
      if (!offer) throw notFound('Offer');
      if (!checkClientToken(offerToken, this.d.store.internal(id).offerTokenHashes?.[offerId])) {
        throw new HttpError(403, 'Only the freelancer who made this offer can withdraw it');
      }
      if (offer.status === 'withdrawn') return e; // idempotent
      if (offer.status !== 'pending') throw conflict(`This offer was already ${offer.status}`);
      return this.closeOffers(e, 'withdrawn', 'the freelancer took it back', [offerId]);
    });
  }

  /**
   * Close pending offers (all of them, or just `ids`) without a state change: one event per offer.
   * Caller holds the lock.
   */
  private closeOffers(e: Escrow, status: Exclude<OfferStatus, 'pending' | 'accepted'>, reason: string, ids?: readonly string[]): Escrow {
    const closing = (e.offers ?? []).filter((o) => o.status === 'pending' && (!ids || ids.includes(o.id)));
    if (closing.length === 0) return e;
    const closedAt = nowIso();
    const { machine } = this.d;
    const next = machine.update(e, { offers: (e.offers ?? []).map((o) => (closing.includes(o) ? { ...o, status, closedAt } : o)) });
    const type = { declined: 'offer.declined', expired: 'offer.expired', withdrawn: 'offer.withdrawn' } as const;
    for (const o of closing) {
      machine.record(next, {
        type: type[status],
        actor: status === 'withdrawn' ? 'freelancer' : 'agent',
        title: status === 'withdrawn'
          ? `A freelancer withdrew its offer of ${this.money(e, o.amount)}`
          : `Offer of ${this.money(e, o.amount)} ${status}: ${reason}`,
        data: { offerId: o.id, amount: o.amount },
      });
    }
    return next;
  }

  /**
   * Ask the wallet itself whether a payment to this escrow's funding invoice exists yet (pending or settled).
   * `fundingSeen` alone lags by up to one wallet poll, and the client's auto-pay sends the moment a job is
   * taken: a cancel in that gap would leave the money arriving at a CANCELLED escrow, which never refunds.
   * If the wallet can't be checked, assume the payment may be on its way.
   */
  private async fundingInFlight(e: Escrow): Promise<boolean> {
    const rid = this.d.store.internal(e.id).fundingRecipientId;
    if (!rid) return false;
    if (!this.d.wallets.ready) return true;
    try {
      await this.wallet.refresh();
      const list = await this.wallet.transfers(e.assetId);
      return list.some((t) => t.direction === 'incoming' && t.recipientId === rid && t.status !== 'failed');
    } catch (err) {
      log.warn(`${e.id}: could not check the wallet before cancelling (${errorMessage(err)})`);
      return true;
    }
  }

  cancel(id: string, role: PartyRole, token?: string): Promise<Escrow> {
    return this.lock(id, async () => {
      const e = this.mustGet(id);
      if (e.state === 'CANCELLED') return e;
      if (!CANCELLABLE.includes(e.state)) throw conflict(`Too late to cancel: the escrow is ${e.state}`);
      if (e.state === 'OPEN' && role === 'freelancer') throw conflict('Only the client can withdraw an open listing');
      this.requireToken(id, role, token);
      if (e.state === 'AWAITING_FUNDS' && (this.d.store.internal(id).fundingSeen || (await this.fundingInFlight(e)))) {
        throw conflict("The client's payment is already on its way, so the escrow can't be cancelled now");
      }
      const next = this.d.machine.transition(e, 'CANCELLED', {
        type: 'escrow.cancelled',
        actor: role,
        title: `${cap(role)} cancelled the escrow`,
      });
      return this.closeOffers(next, 'declined', 'the client withdrew the listing');
    });
  }

  setRefundInvoice(id: string, invoice: string, clientToken?: string): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (TERMINAL_STATES.includes(e.state)) throw conflict(`The escrow is already ${e.state}`);
      this.requireToken(id, 'client', clientToken); // whoever sets this decides where a refund goes
      const p = this.d.store.internal(id).payout;
      if (p?.kind === 'refund' && p.status !== 'failed') throw conflict('The refund has already been sent');
      const next = this.d.machine.update(e, { refundInvoice: invoice });
      if (next.state === 'REFUNDING') this.kick(id);
      return next;
    });
  }

  /** Client says it paid. Only a hint: the agent still checks its own wallet. */
  fundedHint(id: string, txid: string): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (BEFORE_FUNDING.includes(e.state) || e.state === 'CANCELLED') {
        throw conflict(`The escrow is not waiting for funds (state is ${e.state})`);
      }
      if (e.state !== 'AWAITING_FUNDS') return e; // already funded or later
      const rid = this.d.store.internal(id).fundingRecipientId;
      if (rid && this.d.wallets.stub?.simulateIncoming(rid, txid)) log.info(`${id}: stub wallet simulated incoming payment`);
      this.kick(id);
      return e;
    });
  }

  async addDelivery(id: string, upload: Upload, payoutInvoice: string, freelancerToken?: string): Promise<Escrow> {
    return this.lock(id, async () => {
      const e = this.mustGet(id);
      this.requireToken(id, 'freelancer', freelancerToken);
      if (e.state !== 'FUNDED') {
        const why: Partial<Record<EscrowState, string>> = {
          DELIVERED: 'The previous delivery is still being checked',
          VERIFYING: 'The previous delivery is still being checked',
          AWAITING_APPROVAL: 'The client is still reviewing the previous delivery',
          RELEASING: 'The work was already accepted',
          RELEASED: 'The work was already accepted and paid',
        };
        throw conflict(why[e.state] ?? `Deliveries are only accepted once the escrow is funded (state is ${e.state})`);
      }
      if (safeNow().getTime() >= Date.parse(e.deadline)) throw conflict('The deadline has passed, so deliveries are closed');

      const n = e.deliveries.length + 1;
      const dir = path.join(this.d.config.dataDir, 'deliverables', id, String(n));
      fs.mkdirSync(dir, { recursive: true });
      const dest = path.join(dir, upload.fileName);
      fs.renameSync(upload.tmpPath, dest);
      const sha256 = await hashFile(dest);
      const delivery = { n, fileName: upload.fileName, sha256, sizeBytes: upload.sizeBytes, at: nowIso() };

      const next = this.d.machine.transition(
        e,
        'DELIVERED',
        {
          type: 'delivery.received',
          actor: 'freelancer',
          title: `Freelancer delivered version ${n} (${upload.fileName})`,
          data: { n, fileName: upload.fileName, sha256, sizeBytes: upload.sizeBytes },
        },
        { deliveries: [...e.deliveries, delivery], payoutInvoice },
      );
      this.kick(id);
      return next;
    });
  }

  /** The client approves or disputes the latest delivery. Only with the clientToken from POST /escrows. */
  approve(id: string, body: ApproveRequest): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (!checkClientToken(body.clientToken, this.d.store.internal(id).clientTokenHash)) {
        throw new HttpError(403, 'Only the client who created this escrow can approve or dispute');
      }
      const delivery = e.deliveries.at(-1);
      if (e.state !== 'AWAITING_APPROVAL' || !delivery) {
        throw conflict(`There is nothing to approve (state is ${e.state})`);
      }
      if (body.deliveryN !== delivery.n) {
        throw conflict(`Only the latest delivery (${delivery.n}) can be approved or disputed`, { latest: delivery.n });
      }
      const { machine } = this.d;
      const approval = {
        decision: body.decision,
        at: nowIso(),
        ...(body.decision === 'dispute' && body.reason ? { reason: body.reason } : {}),
      };
      const next = machine.update(e, {
        deliveries: e.deliveries.map((x) => (x.n === delivery.n ? { ...x, approval } : x)),
      });
      machine.record(next, {
        type: body.decision === 'approve' ? 'review.approved' : 'review.disputed',
        actor: 'client',
        title: body.decision === 'approve' ? `Client approved delivery ${delivery.n}` : `Client disputed delivery ${delivery.n}`,
        data: { delivery: delivery.n, ...(approval.reason ? { reason: approval.reason } : {}) },
        explain: body.decision === 'dispute',
      });
      const result = this.applyDecision(next, decide(next, [], safeNow()));
      this.kick(id);
      return result;
    });
  }

  retryStep(id: string, force = false): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      const { store } = this.d;
      const p = store.internal(id).payout;
      if (force && p?.status === 'sending') {
        log.warn(`${id}: retry-step force: marking unknown ${p.kind} as failed so it is sent again`);
        store.patchInternal(id, { payout: { ...p, status: 'failed' } });
      }
      store.patchInternal(id, { lastError: undefined });
      this.kick(id);
      return e;
    });
  }

  // ---- background steps ----------------------------------------------------------------------

  kick(id: string): void {
    void this.resume(id);
  }

  /** Called by the ticker: resume every escrow that is not finished. */
  tick(): void {
    for (const e of this.d.store.list()) if (!TERMINAL_STATES.includes(e.state)) this.kick(e.id);
  }

  /** Run steps for one escrow until its state stops changing. One runner per escrow at a time. */
  async resume(id: string): Promise<void> {
    if (this.busy.has(id)) {
      this.again.add(id);
      return;
    }
    this.busy.add(id);
    try {
      for (let i = 0; i < 20; i++) {
        const before = this.d.store.get(id)?.state;
        if (!before || TERMINAL_STATES.includes(before)) break;
        try {
          await this.step(id, before);
        } catch (err) {
          await this.reportError(id, err);
          break;
        }
        if (this.d.store.get(id)?.state === before) break;
      }
    } finally {
      this.busy.delete(id);
      if (this.again.delete(id)) this.kick(id);
    }
  }

  private step(id: string, state: EscrowState): Promise<void> {
    switch (state) {
      case 'DRAFT': return this.parse(id);
      case 'OPEN': return this.checkListing(id);
      case 'AGREED': return this.openFunding(id);
      case 'AWAITING_FUNDS': return this.watchFunding(id);
      case 'FUNDED': return this.checkDeadline(id);
      case 'DELIVERED':
      case 'VERIFYING': return this.verify(id);
      case 'AWAITING_APPROVAL': return this.awaitApproval(id);
      case 'RELEASING':
      case 'REFUNDING': return this.settleOut(id);
      default: return Promise.resolve(); // PROPOSED waits for humans; terminal states do nothing
    }
  }

  /** Turn a failed step into ONE `error` event (repeats of the same error are not logged again). */
  private reportError(id: string, err: unknown): Promise<void> {
    return this.lock(id, () => {
      const e = this.d.store.get(id);
      if (!e) return;
      const se = err instanceof StepError ? err : new StepError('Unexpected problem in the escrow agent', 'system', errorMessage(err));
      log.error(`${id} [${e.state}] ${se.title}: ${se.message}`);
      const key = `${e.state}:${se.title}`;
      if (this.d.store.internal(id).lastError === key) return;
      this.d.store.patchInternal(id, { lastError: key });
      this.d.machine.record(e, {
        type: 'error',
        actor: se.actor,
        title: se.title,
        data: { state: e.state, detail: se.message },
        explain: true,
      });
    });
  }

  private async parse(id: string): Promise<void> {
    const e = this.mustGet(id);
    const seq = this.d.store.internal(id).parseSeq;
    const result = await this.d.ai.parse({
      title: e.title,
      rawText: e.rawText,
      amountDisplay: formatAmount(e.amount, e.precision),
      assetTicker: e.assetTicker,
      deadline: e.deadline,
    });
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'DRAFT' || this.d.store.internal(id).parseSeq !== seq) return; // stale
      const { conditions } = result;
      const hash = termsHash({ title: cur.title, amount: cur.amount, fee: cur.fee, assetId: cur.assetId, deadline: cur.deadline, conditions });
      const n = conditions.length;
      const auto = conditions.filter(isAutomaticCondition).length;
      const who = result.source === 'ai' ? 'AI' : 'Fallback parser';
      this.d.machine.transition(
        cur,
        'PROPOSED',
        {
          type: 'terms.proposed',
          actor: result.source === 'ai' ? 'ai' : 'system',
          title:
            n === 0
              ? `${who} found no automatic checks: the agreement needs editing`
              : `${who} proposed ${plural(auto, 'check')}${n > auto ? ` and ${plural(n - auto, 'item')} for the client to judge` : ''}`,
          data: {
            source: result.source,
            model: result.model,
            ms: result.ms,
            conditions: n,
            clarifications: result.clarifications.length,
            termsHash: hash,
          },
          explain: true,
        },
        {
          conditions,
          summary: result.summary,
          clarifications: result.clarifications,
          termsHash: hash,
          acceptances: [],
        },
      );
    });
  }

  /** OPEN: expire unanswered offers; close the listing once its deadline passes with nobody taking it. */
  private async checkListing(id: string): Promise<void> {
    const e = this.mustGet(id);
    if (expiredOfferIds(e.offers, safeNow()).length === 0 && this.decideNow(e).action !== 'cancel') return;
    await this.lock(id, () => {
      let cur = this.d.store.get(id);
      if (!cur || cur.state !== 'OPEN') return;
      const expired = expiredOfferIds(cur.offers, safeNow());
      if (expired.length > 0) cur = this.closeOffers(cur, 'expired', 'the client did not answer in time', expired);
      const decision = this.decideNow(cur);
      if (decision.action === 'cancel') this.applyDecision(cur, decision);
    });
  }

  private async openFunding(id: string): Promise<void> {
    if (!this.walletReady()) return;
    const e = this.mustGet(id);
    const total = escrowTotal(e);
    // A marketplace funding invoice dies with the funding window: a payment after that fails instead of
    // landing on a listing that has gone back on the marketplace.
    const left = e.fundingDueAt ? Math.ceil((Date.parse(e.fundingDueAt) - safeNow().getTime()) / 1000) : undefined;
    const inv = await this.walletCall('Could not create the funding invoice', () =>
      this.wallet.createInvoice({
        assetId: e.assetId,
        amount: total,
        ...(left === undefined ? {} : { expiresInSec: Math.max(60, left) }),
      }),
    );
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'AGREED') return;
      this.d.store.patchInternal(id, { fundingRecipientId: inv.recipientId, fundingSeen: false, fundingFailed: false });
      this.d.machine.transition(
        cur,
        'AWAITING_FUNDS',
        {
          type: 'funding.invoice_created',
          actor: 'agent',
          title: `Agent is ready to receive ${this.money(cur, total)}`,
          data: { invoice: inv.invoice, recipientId: inv.recipientId, expiresAt: inv.expiresAt },
        },
        { fundingInvoice: inv.invoice },
      );
    });
  }

  private async watchFunding(id: string): Promise<void> {
    for (;;) {
      const e = this.d.store.get(id);
      if (!e || e.state !== 'AWAITING_FUNDS' || !this.walletReady()) return;
      const rid = this.d.store.internal(id).fundingRecipientId;
      if (!rid) throw new StepError('The funding invoice is missing', 'system');

      await this.walletCall('Could not refresh the agent wallet', () => this.wallet.refresh());
      const list = await this.walletCall('Could not read the agent wallet', () => this.wallet.transfers(e.assetId));
      const t = list.find((x) => x.direction === 'incoming' && x.recipientId === rid);

      if (t?.status === 'failed') {
        if (!e.fundingDueAt) throw new StepError('The funding transfer failed', 'wallet', `rawStatus ${t.rawStatus}`);
        this.d.store.patchInternal(id, { fundingFailed: true }); // marketplace: decide() reopens the listing
      }
      // Record a payment on its way BEFORE any timeout decision: once seen, decide() waits for it. Deciding
      // first would reopen (or cancel) a job whose money is already arriving when the payment is first seen
      // after fundingDueAt, and the next taker's funding invoice would make the client pay a second time.
      if (t && t.status !== 'failed' && !this.d.store.internal(id).fundingSeen) {
        await this.lock(id, () => {
          const cur = this.d.store.get(id);
          if (!cur || cur.state !== 'AWAITING_FUNDS' || this.d.store.internal(id).fundingSeen) return;
          this.d.store.patchInternal(id, { fundingSeen: true });
          this.d.machine.record(cur, {
            type: 'funding.payment_seen',
            actor: 'wallet',
            title: `Payment of ${this.money(cur, escrowTotal(cur))} seen, waiting for confirmation`,
            data: { txid: t.txid, rawStatus: t.rawStatus },
          });
        });
      }
      // Marketplace timeouts (not funded in the window / before the deadline, or the payment failed).
      const exit = this.decideNow(e);
      if (exit.action === 'reopen' || exit.action === 'cancel') {
        await this.lock(id, () => {
          const cur = this.d.store.get(id);
          if (!cur || cur.state !== 'AWAITING_FUNDS') return;
          const decision = this.decideNow(cur);
          if (decision.action === 'reopen' || decision.action === 'cancel') this.applyDecision(cur, decision);
        });
        return;
      }
      if (t?.status === 'settled') {
        if (BigInt(t.amount) < BigInt(escrowTotal(e))) {
          throw new StepError(`Received ${this.money(e, t.amount)} but ${this.money(e, escrowTotal(e))} was expected`, 'wallet');
        }
        await this.lock(id, () => {
          const cur = this.d.store.get(id);
          if (!cur || cur.state !== 'AWAITING_FUNDS') return;
          this.d.store.patchInternal(id, { fundingTxid: t.txid });
          this.d.machine.transition(cur, 'FUNDED', {
            type: 'funding.settled',
            actor: 'wallet',
            title: `${this.money(cur, escrowTotal(cur))} locked in escrow`,
            data: { txid: t.txid, amount: t.amount },
            explain: true,
          });
        });
        return;
      }
      if (t?.status === 'pending') await this.d.dev.autoMine();
      await sleep(this.d.config.walletPollMs);
    }
  }

  private async checkDeadline(id: string): Promise<void> {
    if (decide(this.mustGet(id), [], safeNow()).action !== 'refund') return;
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'FUNDED') return;
      const decision = decide(cur, [], safeNow());
      if (decision.action === 'refund') this.d.machine.transition(cur, 'REFUNDING', this.decisionSpec(cur, decision));
    });
  }

  private async verify(id: string): Promise<void> {
    let e = this.mustGet(id);
    const delivery = e.deliveries.at(-1);
    if (!delivery) throw new StepError('There is no delivery to check', 'verifier');
    const automatic = e.conditions.filter(isAutomaticCondition);

    if (e.state === 'DELIVERED') {
      e = await this.lock(id, () => {
        const cur = this.mustGet(id);
        if (cur.state !== 'DELIVERED') return cur;
        return this.d.machine.transition(cur, 'VERIFYING', {
          type: 'verify.started',
          actor: 'verifier',
          title: `Checking delivery ${delivery.n} against ${plural(automatic.length, 'condition')}`,
          data: { delivery: delivery.n, conditions: automatic.length },
        });
      });
    }
    if (e.state !== 'VERIFYING') return;

    const { dataDir } = this.d.config;
    const upload = path.join(dataDir, 'deliverables', id, String(delivery.n), delivery.fileName);
    const ws = prepareWorkspace(upload, delivery.fileName, path.join(dataDir, 'work', id, String(delivery.n)));

    const results: VerificationResult[] = [];
    for (const c of automatic) {
      const r = await checkCondition(c, ws);
      results.push(r);
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'VERIFYING') return; // reset while running
      this.d.machine.record(cur, {
        type: 'verify.condition_result',
        actor: 'verifier',
        title: `${r.passed ? 'Passed' : 'Failed'}: ${c.description}`,
        data: { delivery: delivery.n, conditionId: c.id, kind: c.kind, description: c.description, passed: r.passed, evidence: r.evidence },
        explain: !r.passed,
      });
    }

    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'VERIFYING') return;
      const { machine } = this.d;
      const withResults = machine.update(cur, {
        deliveries: cur.deliveries.map((x) => (x.n === delivery.n ? { ...x, results } : x)),
      });
      const passed = results.filter((r) => r.passed).length;
      machine.record(withResults, {
        type: 'verify.finished',
        actor: 'verifier',
        title: `${passed} of ${plural(results.length, 'check')} passed`,
        data: { delivery: delivery.n, passed, total: results.length },
      });
      this.applyDecision(withResults, decide(withResults, results, safeNow()));
    });
  }

  /** Move the escrow as `decide()` said, with its `decision.made` event. Caller holds the lock. */
  private applyDecision(e: Escrow, decision: Decision): Escrow {
    const { machine, config } = this.d;
    const spec = this.decisionSpec(e, decision);
    switch (decision.action) {
      case 'wait':
        return e;
      case 'release':
        return machine.transition(e, 'RELEASING', spec);
      case 'refund':
        return machine.transition(e, 'REFUNDING', spec);
      case 'retry':
        return machine.transition(e, 'FUNDED', spec);
      case 'cancel':
        return this.closeOffers(machine.transition(e, 'CANCELLED', spec), 'declined', 'the listing closed at its deadline');
      case 'reopen': {
        // Back on the marketplace: the freelancer's acceptance, token and funding invoice are void. The
        // client's acceptance of the same termsHash still stands, so the next taker agrees at once.
        this.d.store.patchInternal(e.id, {
          freelancerTokenHash: undefined,
          fundingRecipientId: undefined,
          fundingSeen: false,
          fundingFailed: false,
        });
        return machine.transition(
          e,
          'OPEN',
          { ...spec, type: 'funding.reopened' },
          {
            acceptances: e.acceptances.filter((a) => a.role === 'client'),
            fundingInvoice: undefined,
            fundingDueAt: undefined,
          },
        );
      }
      case 'await_approval': {
        const n = e.deliveries.at(-1)?.n;
        const reviewDueAt = new Date(safeNow().getTime() + config.reviewWindowSec * 1000).toISOString();
        return machine.transition(
          e,
          'AWAITING_APPROVAL',
          { ...spec, data: { ...spec.data, reviewDueAt } },
          { deliveries: e.deliveries.map((x) => (x.n === n ? { ...x, reviewDueAt } : x)) },
        );
      }
    }
  }

  /** AWAITING_APPROVAL: make sure the AI review runs; release once the review window is over. */
  private async awaitApproval(id: string): Promise<void> {
    const e = this.mustGet(id);
    const delivery = e.deliveries.at(-1);
    if (!delivery) throw new StepError('There is no delivery to review', 'system');
    if (!delivery.review) this.startReview(id, delivery.n);
    if (decide(e, [], safeNow()).action === 'wait') return;
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'AWAITING_APPROVAL') return;
      const decision = decide(cur, [], safeNow());
      if (decision.action === 'wait') return;
      const d = cur.deliveries.at(-1)!;
      if (!d.approval) {
        this.d.machine.record(cur, {
          type: 'review.expired',
          actor: 'system',
          title: `The client did not answer in time, so delivery ${d.n} counts as accepted`,
          data: { delivery: d.n, reviewDueAt: d.reviewDueAt },
          explain: true,
        });
      }
      this.applyDecision(cur, decision);
    });
  }

  /** Ask the AI for its advisory review of the latest delivery, without blocking the flow. */
  private startReview(id: string, n: number): void {
    const key = `${id}:${n}`;
    if (this.reviewing.has(key)) return;
    this.reviewing.add(key);
    void this.runReview(id, n)
      .catch((err) => log.error(`${id}: review of delivery ${n} failed: ${errorMessage(err)}`))
      .finally(() => this.reviewing.delete(key));
  }

  private async runReview(id: string, n: number): Promise<void> {
    const started = Date.now();
    const e = this.mustGet(id);
    const delivery = e.deliveries.find((x) => x.n === n);
    if (!delivery) return;
    const { ai, config } = this.d;
    let review: AiReview;
    try {
      const files = buildReviewFiles(deliveryRoot(config.dataDir, id, n, delivery.fileName));
      review = normalizeReview(await ai.exclusive(() => ai.review({ escrow: e, deliveryN: n, files })), e);
    } catch (err) {
      log.warn(`${id}: ai /review of delivery ${n} failed, using template: ${errorMessage(err)}`);
      review = templateReview(e, Date.now() - started);
    }
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      const latest = cur?.deliveries.at(-1);
      if (!cur || cur.state !== 'AWAITING_APPROVAL' || latest?.n !== n || latest.review) return;
      const next = this.d.machine.update(cur, {
        deliveries: cur.deliveries.map((x) => (x.n === n ? { ...x, review } : x)),
      });
      const count = (o: string) => review.items.filter((i) => i.opinion === o).length;
      const counts = { looksMet: count('looks_met'), looksUnmet: count('looks_unmet'), unsure: count('unsure') };
      const parts = [
        counts.looksMet && `${counts.looksMet} looks met`,
        counts.looksUnmet && `${counts.looksUnmet} looks unmet`,
        counts.unsure && `${counts.unsure} unsure`,
      ].filter(Boolean);
      this.d.machine.record(next, {
        type: 'review.report_ready',
        actor: review.source === 'ai' ? 'ai' : 'system',
        title:
          review.source === 'ai'
            ? `AI opinion on delivery ${n}: ${parts.join(', ')}`
            : `AI review unavailable for delivery ${n}: the client checks the work alone`,
        data: { delivery: n, source: review.source, ...counts },
      });
    });
  }

  /**
   * A fresh refund invoice from the client's party server, else the one the client attached.
   * Marketplace escrows only ever use the attached one: with many clients, CLIENT_PARTY_URL may be
   * somebody else's wallet, and asking it would send this client's refund to them.
   */
  private async refundInvoice(e: Escrow): Promise<string | undefined> {
    const base = this.d.store.internal(e.id).marketplace ? undefined : this.d.config.clientPartyUrl;
    if (base) {
      try {
        const health = PartyHealthResponseSchema.parse(
          await (await fetch(base + PARTY_ROUTES.health, { signal: AbortSignal.timeout(5000) })).json(),
        );
        if (health.role !== 'client') throw new Error(`CLIENT_PARTY_URL is the ${health.role}'s wallet, not the client's`);
        const res = await fetch(base + PARTY_ROUTES.walletInvoice, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assetId: e.assetId, amount: escrowTotal(e) }),
          signal: AbortSignal.timeout(30_000),
        });
        if (!res.ok) throw new Error(`HTTP ${res.status}`);
        const inv = InvoiceResponseSchema.parse(await res.json());
        await this.lock(e.id, () => {
          const cur = this.d.store.get(e.id);
          if (cur) this.d.machine.update(cur, { refundInvoice: inv.invoice });
        });
        return inv.invoice;
      } catch (err) {
        log.warn(`${e.id}: no fresh refund invoice from client party (${errorMessage(err)}), using the attached one`);
      }
    }
    return this.d.store.get(e.id)?.refundInvoice;
  }

  /** Pay the freelancer (RELEASING) or the client (REFUNDING), then wait until it settles. */
  private async settleOut(id: string): Promise<void> {
    if (!this.walletReady()) return;
    const e = this.mustGet(id);
    const kind = e.state === 'RELEASING' ? 'release' : 'refund';
    const what = kind === 'release' ? 'payout' : 'refund';
    // Release pays the reward (the service keeps the fee); a refund returns reward + fee.
    const amount = kind === 'release' ? e.amount : escrowTotal(e);
    const { store } = this.d;

    let p = store.internal(id).payout;
    if (p && p.kind !== kind) p = undefined;
    if (p?.status === 'sending') {
      throw new StepError(
        `It is unclear whether the ${what} was sent`,
        'wallet',
        'Check the agent wallet transfers. If nothing was sent, POST /escrows/:id/retry-step with {"force":true}.',
      );
    }

    if (!p || p.status === 'failed') {
      const invoice = kind === 'release' ? e.payoutInvoice : await this.refundInvoice(e);
      if (!invoice) {
        throw new StepError(
          kind === 'release' ? 'The freelancer did not attach a payout invoice' : 'Waiting for a refund invoice from the client',
          'wallet',
        );
      }
      // Persist intent BEFORE paying: a crash mid-pay must never lead to an automatic second payment.
      store.patchInternal(id, { payout: { kind, status: 'sending', invoice } });
      let txid: string;
      try {
        ({ txid } = await this.wallet.pay({ invoice, assetId: e.assetId, amount }));
      } catch (err) {
        if (err instanceof TimeoutError) {
          throw new StepError(`The ${what} did not answer in time; it may still go through`, 'wallet', errorMessage(err));
        }
        store.patchInternal(id, { payout: { kind, status: 'failed', invoice } });
        throw new StepError(`Could not send the ${what}`, 'wallet', errorMessage(err));
      }
      p = { kind, status: 'sent', invoice, txid };
      store.patchInternal(id, { payout: p });
      const cur = store.get(id);
      if (cur) {
        this.d.machine.record(cur, {
          type: kind === 'release' ? 'payout.sent' : 'refund.sent',
          actor: 'wallet',
          title:
            kind === 'release'
              ? `Sent ${this.money(cur, amount)} to the freelancer (tx ${short(txid, 8)})`
              : `Sent ${this.money(cur, amount)} back to the client (tx ${short(txid, 8)})`,
          data: { txid, amount, ...(kind === 'release' && cur.fee ? { feeKept: cur.fee } : {}) },
        });
      }
    }

    const sent = p;
    const waitState: EscrowState = kind === 'release' ? 'RELEASING' : 'REFUNDING';
    for (;;) {
      const cur = store.get(id);
      if (!cur || cur.state !== waitState) return;
      await this.walletCall('Could not refresh the agent wallet', () => this.wallet.refresh());
      const list = await this.walletCall('Could not read the agent wallet', () => this.wallet.transfers(cur.assetId));
      const t = list.find((x) => x.direction === 'outgoing' && x.txid === sent.txid);
      if (t?.status === 'failed') {
        store.patchInternal(id, { payout: { ...sent, status: 'failed' } });
        throw new StepError(`The ${what} transfer failed; the agent will try again`, 'wallet', `rawStatus ${t.rawStatus}`);
      }
      if (t?.status === 'settled') {
        await this.lock(id, () => {
          const now = store.get(id);
          if (!now || now.state !== waitState) return;
          this.d.machine.transition(now, kind === 'release' ? 'RELEASED' : 'REFUNDED', {
            type: kind === 'release' ? 'payout.settled' : 'refund.settled',
            actor: 'wallet',
            title: kind === 'release' ? `Freelancer received ${this.money(now, amount)}` : `Client received ${this.money(now, amount)} back`,
            data: { txid: sent.txid, amount },
            explain: true,
          });
        });
        return;
      }
      await this.d.dev.autoMine();
      await sleep(this.d.config.walletPollMs);
    }
  }
}
