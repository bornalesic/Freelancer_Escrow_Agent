import fs from 'node:fs';
import path from 'node:path';
import {
  InvoiceResponseSchema,
  PARTY_ROUTES,
  PartyHealthResponseSchema,
  TERMINAL_STATES,
  formatAmount,
  isAutomaticCondition,
  newEscrowId,
  termsHash,
  type Acceptance,
  type AiReview,
  type ApproveRequest,
  type CreateEscrowRequest,
  type Decision,
  type Escrow,
  type EscrowState,
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

const CANCELLABLE: readonly EscrowState[] = ['DRAFT', 'PROPOSED', 'AGREED', 'AWAITING_FUNDS'];
const BEFORE_FUNDING: readonly EscrowState[] = ['DRAFT', 'PROPOSED', 'AGREED'];

const cap = (role: PartyRole) => (role === 'client' ? 'Client' : 'Freelancer');
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

  private decisionSpec(e: Escrow, decision: Decision): EventSpec {
    const titles: Record<Decision['action'], string> = {
      release: `Decision: release ${this.money(e)} to the freelancer`,
      refund: `Decision: refund ${this.money(e)} to the client`,
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

  reparse(id: string, rawText?: string): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (e.state !== 'DRAFT' && e.state !== 'PROPOSED') {
        throw conflict(`The agreement can only be re-read before both parties agree (state is ${e.state})`);
      }
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
      if (e.state === 'PROPOSED') {
        next = machine.transition(e, 'DRAFT', spec, patch);
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

  cancel(id: string, role: PartyRole): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (e.state === 'CANCELLED') return e;
      if (!CANCELLABLE.includes(e.state)) throw conflict(`Too late to cancel: the escrow is ${e.state}`);
      if (e.state === 'AWAITING_FUNDS' && this.d.store.internal(id).fundingSeen) {
        throw conflict("The client's payment is already on its way, so the escrow can't be cancelled now");
      }
      return this.d.machine.transition(e, 'CANCELLED', {
        type: 'escrow.cancelled',
        actor: role,
        title: `${cap(role)} cancelled the escrow`,
      });
    });
  }

  setRefundInvoice(id: string, invoice: string): Promise<Escrow> {
    return this.lock(id, () => {
      const e = this.mustGet(id);
      if (TERMINAL_STATES.includes(e.state)) throw conflict(`The escrow is already ${e.state}`);
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

  async addDelivery(id: string, upload: Upload, payoutInvoice: string): Promise<Escrow> {
    return this.lock(id, async () => {
      const e = this.mustGet(id);
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
      if (Date.now() >= Date.parse(e.deadline)) throw conflict('The deadline has passed, so deliveries are closed');

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
      const result = this.applyDecision(next, decide(next, [], new Date()));
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
      const hash = termsHash({ title: cur.title, amount: cur.amount, assetId: cur.assetId, deadline: cur.deadline, conditions });
      const n = conditions.length;
      const who = result.source === 'ai' ? 'AI' : 'Fallback parser';
      this.d.machine.transition(
        cur,
        'PROPOSED',
        {
          type: 'terms.proposed',
          actor: result.source === 'ai' ? 'ai' : 'system',
          title: n === 0 ? `${who} found no automatic checks: the agreement needs editing` : `${who} proposed ${plural(n, 'check')}`,
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

  private async openFunding(id: string): Promise<void> {
    if (!this.walletReady()) return;
    const e = this.mustGet(id);
    const inv = await this.walletCall('Could not create the funding invoice', () =>
      this.wallet.createInvoice({ assetId: e.assetId, amount: e.amount }),
    );
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'AGREED') return;
      this.d.store.patchInternal(id, { fundingRecipientId: inv.recipientId, fundingSeen: false });
      this.d.machine.transition(
        cur,
        'AWAITING_FUNDS',
        {
          type: 'funding.invoice_created',
          actor: 'agent',
          title: `Agent is ready to receive ${this.money(cur)}`,
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

      if (t?.status === 'failed') throw new StepError('The funding transfer failed', 'wallet', `rawStatus ${t.rawStatus}`);
      if (t && !this.d.store.internal(id).fundingSeen) {
        await this.lock(id, () => {
          const cur = this.d.store.get(id);
          if (!cur || cur.state !== 'AWAITING_FUNDS' || this.d.store.internal(id).fundingSeen) return;
          this.d.store.patchInternal(id, { fundingSeen: true });
          this.d.machine.record(cur, {
            type: 'funding.payment_seen',
            actor: 'wallet',
            title: `Payment of ${this.money(cur)} seen, waiting for confirmation`,
            data: { txid: t.txid, rawStatus: t.rawStatus },
          });
        });
      }
      if (t?.status === 'settled') {
        if (BigInt(t.amount) < BigInt(e.amount)) {
          throw new StepError(`Received ${this.money(e, t.amount)} but ${this.money(e)} was expected`, 'wallet');
        }
        await this.lock(id, () => {
          const cur = this.d.store.get(id);
          if (!cur || cur.state !== 'AWAITING_FUNDS') return;
          this.d.store.patchInternal(id, { fundingTxid: t.txid });
          this.d.machine.transition(cur, 'FUNDED', {
            type: 'funding.settled',
            actor: 'wallet',
            title: `${this.money(cur)} locked in escrow`,
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
    if (decide(this.mustGet(id), [], new Date()).action !== 'refund') return;
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'FUNDED') return;
      const decision = decide(cur, [], new Date());
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
      this.applyDecision(withResults, decide(withResults, results, new Date()));
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
      case 'await_approval': {
        const n = e.deliveries.at(-1)?.n;
        const reviewDueAt = new Date(Date.now() + config.reviewWindowSec * 1000).toISOString();
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
    if (decide(e, [], new Date()).action === 'wait') return;
    await this.lock(id, () => {
      const cur = this.d.store.get(id);
      if (!cur || cur.state !== 'AWAITING_APPROVAL') return;
      const decision = decide(cur, [], new Date());
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

  /** A fresh refund invoice from the client's party server, else the one the client attached. */
  private async refundInvoice(e: Escrow): Promise<string | undefined> {
    const base = this.d.config.clientPartyUrl;
    if (base) {
      try {
        const health = PartyHealthResponseSchema.parse(
          await (await fetch(base + PARTY_ROUTES.health, { signal: AbortSignal.timeout(5000) })).json(),
        );
        if (health.role !== 'client') throw new Error(`CLIENT_PARTY_URL is the ${health.role}'s wallet, not the client's`);
        const res = await fetch(base + PARTY_ROUTES.walletInvoice, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ assetId: e.assetId, amount: e.amount }),
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
        ({ txid } = await this.wallet.pay({ invoice, assetId: e.assetId, amount: e.amount }));
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
              ? `Sent ${this.money(cur)} to the freelancer (tx ${short(txid, 8)})`
              : `Sent ${this.money(cur)} back to the client (tx ${short(txid, 8)})`,
          data: { txid, amount: cur.amount },
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
            title: kind === 'release' ? `Freelancer received ${this.money(now)}` : `Client received ${this.money(now)} back`,
            data: { txid: sent.txid, amount: now.amount },
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
