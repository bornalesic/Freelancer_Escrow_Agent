// The marketplace flow on the engine: publish → OPEN → take → funding → deliver (fail, then pass) → release
// with the 2% fee kept; the timeouts that move no money (funding window, failed funding, listing deadline);
// review-only jobs; tokens; image-only previews; counteroffers. Stub wallet and an unreachable AI
// (fallback parser, template explanations), so it runs anywhere.

import type { AddressInfo } from 'node:net';
import { afterAll, describe, expect, it } from 'vitest';
import { termsHash, type EscrowDetailResponse, type EscrowState, type Offer } from '@escrow/shared';
import { buildApp, type AgentApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { expiredOfferIds, offerExpiry, offerTerms } from '../src/offers';
import { StubWallet } from '../src/wallet/stub';
import { slugifyProject, tmpDir, zipBuffer } from './helpers';

const SLUGIFY = 'Build slugify. The included tests must pass. Also include a README.';
const REWARD = '50000000'; // 50 tUSDT
const FEE = '1000000';     //  1 tUSDT = 2%
const TOTAL = '51000000';
const deadlineIn = (ms: number) => new Date(Date.now() + ms).toISOString();

const apps: AgentApp[] = [];
afterAll(async () => {
  await Promise.all(apps.map((a) => a.app.close()));
});

async function start(over: Partial<Config> = {}) {
  const config: Config = {
    ...loadConfig({}),
    dataDir: tmpDir(),
    aiUrl: 'http://127.0.0.1:9', // nothing listens: fallback parser and template explanations
    clientPartyUrl: undefined,
    autoMine: false,
    walletPollMs: 50,
    mockSettleMs: 100,
    tickMs: 100,
    ...over,
  };
  const agent = await buildApp({ config, wallet: new StubWallet('regtest', config.mockSettleMs) });
  await agent.app.listen({ host: '127.0.0.1', port: 0 });
  apps.push(agent);
  const base = `http://127.0.0.1:${(agent.app.server.address() as AddressInfo).port}`;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** As if from another laptop on the LAN (not the agent's own). */
  const fromLan = async (url: string, token?: string) => {
    const res = await agent.app.inject({
      method: 'GET',
      url,
      remoteAddress: '192.168.1.50',
      ...(token ? { headers: { 'x-escrow-token': token } } : {}),
    });
    return { status: res.statusCode, body: res.body };
  };
  const detail = async (id: string) => (await call('GET', `/escrows/${id}`)).body as EscrowDetailResponse;
  const waitFor = async (id: string, state: EscrowState) => {
    const end = Date.now() + 25_000;
    for (;;) {
      const d = await detail(id);
      if (d.escrow.state === state) return d;
      if (Date.now() > end) throw new Error(`timed out waiting for ${state}; state=${d.escrow.state}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const deliver = async (id: string, files: Record<string, string>, freelancerToken?: string) => {
    const fd = new FormData();
    fd.set('payoutInvoice', `mock:freelancer:x:${REWARD}`);
    if (freelancerToken) fd.set('freelancerToken', freelancerToken);
    fd.set('file', new Blob([zipBuffer(files)]), 'work.zip');
    const res = await fetch(`${base}/escrows/${id}/deliveries`, { method: 'POST', body: fd });
    return { status: res.status, body: (await res.json()) as any };
  };

  /** create → requirements → publish. Returns what the client keeps in its session. */
  const listed = async (rawText = SLUGIFY, deadlineMs = 30 * 60_000) => {
    const created = await call('POST', '/escrows', { title: 'Slugify', rawText, amount: REWARD, deadline: deadlineIn(deadlineMs) });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const proposed = await waitFor(id, 'PROPOSED');
    const termsHash = proposed.escrow.termsHash!;
    const published = await call('POST', `/escrows/${id}/publish`, { termsHash, clientToken: created.body.clientToken });
    expect(published.status).toBe(200);
    return { id, clientToken: created.body.clientToken as string, termsHash };
  };
  /** ... → a freelancer takes it → the escrow waits for funds. */
  const taken = async () => {
    const job = await listed();
    const took = await call('POST', `/escrows/${job.id}/take`, { termsHash: job.termsHash });
    expect(took.status).toBe(200);
    await waitFor(job.id, 'AWAITING_FUNDS');
    return { ...job, freelancerToken: took.body.freelancerToken as string };
  };
  /** ... → the client's party server attaches the refund invoice and pays (simulated by the stub). */
  const funded = async () => {
    const job = await taken();
    expect((await call('POST', `/escrows/${job.id}/refund-invoice`, { invoice: `mock:client-refund:x:${TOTAL}`, clientToken: job.clientToken })).status).toBe(200);
    await call('POST', `/escrows/${job.id}/funded`, { txid: 'tx' });
    await waitFor(job.id, 'FUNDED');
    return job;
  };

  return { agent, call, fromLan, detail, waitFor, deliver, listed, taken, funded };
}

describe('marketplace flow', () => {
  it('publish → take → fund reward + fee → v1 fails → v2 passes → released; the service keeps the fee', async () => {
    const t = await start();
    const created = await t.call('POST', '/escrows', { title: 'Slugify', rawText: SLUGIFY, amount: REWARD, deadline: deadlineIn(30 * 60_000) });
    expect(created.body.fee).toBe(FEE);
    const id = created.body.id as string;
    const clientToken = created.body.clientToken as string;
    const { escrow } = await t.waitFor(id, 'PROPOSED');
    const termsHash = escrow.termsHash!;

    // Publishing = the client accepting this exact version.
    expect((await t.call('POST', `/escrows/${id}/publish`, { termsHash, clientToken: 'f'.repeat(64) })).status).toBe(403);
    expect((await t.call('POST', `/escrows/${id}/publish`, { termsHash: 'b'.repeat(64), clientToken })).status).toBe(409);
    const open = await t.call('POST', `/escrows/${id}/publish`, { termsHash, clientToken });
    expect(open.body).toMatchObject({ state: 'OPEN', acceptances: [{ role: 'client', termsHash }] });

    // First freelancer wins; the token is returned once.
    expect((await t.call('POST', `/escrows/${id}/take`, { termsHash: 'b'.repeat(64) })).status).toBe(409);
    const took = await t.call('POST', `/escrows/${id}/take`, { termsHash });
    expect(took.status).toBe(200);
    expect(took.body.freelancerToken).toMatch(/^[0-9a-f]{64}$/);
    expect((await t.call('POST', `/escrows/${id}/take`, { termsHash })).body.error).toMatch(/already took/);

    const waiting = await t.waitFor(id, 'AWAITING_FUNDS');
    expect(waiting.escrow.fundingInvoice).toMatch(new RegExp(`:${TOTAL}$`)); // reward + fee
    expect(Date.parse(waiting.escrow.fundingDueAt!)).toBeGreaterThan(Date.now());
    expect(waiting.escrow.acceptances.map((a) => a.role).sort()).toEqual(['client', 'freelancer']);
    expect(JSON.stringify(waiting)).not.toContain(clientToken);
    expect(JSON.stringify(waiting)).not.toContain(took.body.freelancerToken);

    // Only the client sets where a refund goes.
    expect((await t.call('POST', `/escrows/${id}/refund-invoice`, { invoice: 'mock:thief:x:1' })).status).toBe(403);
    expect((await t.call('POST', `/escrows/${id}/refund-invoice`, { invoice: `mock:client-refund:x:${TOTAL}`, clientToken })).status).toBe(200);
    await t.call('POST', `/escrows/${id}/funded`, { txid: 'tx' });
    await t.waitFor(id, 'FUNDED');

    // Only the freelancer who took the job delivers. The fail → resubmit → pass loop still works.
    expect((await t.deliver(id, slugifyProject(2))).status).toBe(403);
    expect((await t.deliver(id, slugifyProject(2), 'e'.repeat(64))).status).toBe(403);
    expect((await t.deliver(id, slugifyProject(1), took.body.freelancerToken)).status).toBe(200);
    await t.waitFor(id, 'FUNDED');
    expect((await t.deliver(id, slugifyProject(2), took.body.freelancerToken)).status).toBe(200);
    const done = await t.waitFor(id, 'RELEASED');

    // Release pays the reward; the 2% fee stays with the service.
    const sent = done.events.find((e) => e.type === 'payout.sent')!;
    expect(sent.data).toMatchObject({ amount: REWARD, feeKept: FEE });
    expect((await t.call('GET', '/wallet')).body.assets[0].settled).toBe(FEE);
  });

  it('an unfunded job goes back on the marketplace after the funding window, and the next freelancer can take it', async () => {
    const t = await start({ fundingWindowSec: 1 });
    const job = await t.taken();
    const reopened = await t.waitFor(job.id, 'OPEN');
    expect(reopened.events.at(-1)).toMatchObject({ type: 'funding.reopened', actor: 'agent' });
    expect(reopened.escrow.acceptances.map((a) => a.role)).toEqual(['client']); // the client's acceptance stands
    expect(reopened.escrow.fundingInvoice).toBeUndefined();
    expect(reopened.escrow.fundingDueAt).toBeUndefined();

    // The first freelancer's token is void now.
    expect((await t.call('POST', `/escrows/${job.id}/cancel`, { role: 'freelancer', token: job.freelancerToken })).status).toBe(409);
    const again = await t.call('POST', `/escrows/${job.id}/take`, { termsHash: job.termsHash });
    expect(again.status).toBe(200);
    expect(again.body.freelancerToken).not.toBe(job.freelancerToken);
    await t.waitFor(job.id, 'AWAITING_FUNDS');
  });

  it('a payment first seen after the funding window is not abandoned: the job is funded, not reopened', async () => {
    // Slow wallet polling: the payment arrives after fundingDueAt but before the agent's next look.
    const t = await start({ fundingWindowSec: 1, walletPollMs: 1500, mockSettleMs: 2000 });
    const job = await t.taken();
    const recipientId = t.agent.store.internal(job.id).fundingRecipientId!;
    await new Promise((r) => setTimeout(r, 1200));
    expect(t.agent.wallets.stub!.simulateIncoming(recipientId, 'late-tx')).toBe(true);
    const funded = await t.waitFor(job.id, 'FUNDED');
    expect(funded.events.map((e) => e.type)).not.toContain('funding.reopened');
    expect(funded.events.map((e) => e.type)).toContain('funding.payment_seen');
  });

  it('a job cannot be cancelled while its payment is on the way, even before the agent noticed it', async () => {
    const t = await start({ walletPollMs: 5000, mockSettleMs: 5000 });
    const job = await t.taken();
    const recipientId = t.agent.store.internal(job.id).fundingRecipientId!;
    expect(t.agent.wallets.stub!.simulateIncoming(recipientId, 'in-flight-tx')).toBe(true);
    const cancel = await t.call('POST', `/escrows/${job.id}/cancel`, { role: 'freelancer', token: job.freelancerToken });
    expect(cancel.status).toBe(409);
    await t.waitFor(job.id, 'FUNDED');
  });

  it('operator routes only work on the agent laptop: forced re-payment and clearing all jobs', async () => {
    const t = await start();
    const job = await t.listed();
    const lan = (url: string, payload: unknown) =>
      t.agent.app.inject({ method: 'POST', url, remoteAddress: '192.168.1.50', payload: payload as object });
    expect((await lan(`/escrows/${job.id}/retry-step`, { force: true })).statusCode).toBe(403);
    expect((await lan(`/escrows/${job.id}/retry-step`, {})).statusCode).toBe(200); // a plain nudge is harmless
    expect((await lan('/dev/reset', {})).statusCode).toBe(403);
    expect((await t.call('GET', `/escrows/${job.id}`)).status).toBe(200); // nothing was deleted
    expect((await t.call('POST', `/escrows/${job.id}/retry-step`, { force: true })).status).toBe(200); // loopback
  });

  it('a failed funding payment reopens the listing at once', async () => {
    const t = await start();
    const job = await t.taken();
    const recipientId = t.agent.store.internal(job.id).fundingRecipientId!;
    expect(t.agent.wallets.stub!.simulateFailedIncoming(recipientId)).toBe(true);
    const reopened = await t.waitFor(job.id, 'OPEN');
    expect(reopened.events.at(-1)!.type).toBe('funding.reopened');
  });

  it('an OPEN listing nobody takes is cancelled at its deadline', async () => {
    const t = await start();
    const job = await t.listed(SLUGIFY, 4_000);
    const closed = await t.waitFor(job.id, 'CANCELLED');
    expect(closed.events.at(-1)).toMatchObject({ type: 'decision.made', data: { action: 'cancel' } });
  });

  it('a job nothing can check automatically can still be published (the client reviews every delivery)', async () => {
    const t = await start();
    const created = await t.call('POST', '/escrows', {
      title: 'Logo', rawText: 'Design a logo. It should look clean and modern.', amount: REWARD, deadline: deadlineIn(30 * 60_000),
    });
    const { escrow } = await t.waitFor(created.body.id, 'PROPOSED');
    expect(escrow.conditions.every((c) => c.kind === 'client_review')).toBe(true);
    const res = await t.call('POST', `/escrows/${escrow.id}/publish`, { termsHash: escrow.termsHash, clientToken: created.body.clientToken });
    expect(res.status).toBe(200);
    expect(res.body.state).toBe('OPEN');
  });

  it('editing an OPEN listing unlists it and voids the old terms', async () => {
    const t = await start();
    const job = await t.listed();
    expect((await t.call('POST', `/escrows/${job.id}/reparse`, { rawText: `${SLUGIFY} Add docs.` })).status).toBe(403);
    expect((await t.call('POST', `/escrows/${job.id}/reparse`, { rawText: `${SLUGIFY} Add docs.`, clientToken: job.clientToken })).body.state).toBe('DRAFT');
    const proposed = await t.waitFor(job.id, 'PROPOSED');
    expect(proposed.escrow.acceptances).toEqual([]);
    expect((await t.call('POST', `/escrows/${job.id}/take`, { termsHash: job.termsHash })).status).toBe(409); // not listed now
  });

  it('cancelling needs the right token, and a freelancer cannot withdraw a listing', async () => {
    const t = await start();
    const job = await t.listed();
    expect((await t.call('POST', `/escrows/${job.id}/cancel`, { role: 'freelancer' })).status).toBe(409);
    expect((await t.call('POST', `/escrows/${job.id}/cancel`, { role: 'client' })).status).toBe(403);
    expect((await t.call('POST', `/escrows/${job.id}/cancel`, { role: 'client', token: job.clientToken })).body.state).toBe('CANCELLED');
  });

  it('before release the client and the projector see image previews only; the freelancer sees its own work', async () => {
    const t = await start();
    const job = await t.funded();
    // v1 fails its tests, so the escrow is back in FUNDED, unreleased, with a delivery on file.
    const files = { ...slugifyProject(1), 'logo.png': '\u0089PNG fake image bytes' };
    expect((await t.deliver(job.id, files, job.freelancerToken)).status).toBe(200);
    await t.waitFor(job.id, 'FUNDED');
    const list = `/escrows/${job.id}/deliveries/1/files`;

    expect((await t.fromLan(list)).status).toBe(403); // a stranger on the LAN
    const asClient = JSON.parse((await t.fromLan(list, job.clientToken)).body) as { path: string; previewable: boolean }[];
    expect(asClient.filter((f) => f.previewable).map((f) => f.path)).toEqual(['logo.png']);
    expect((await t.fromLan(`${list}/logo.png`, job.clientToken)).status).toBe(200);
    expect((await t.fromLan(`${list}/slugify.js`, job.clientToken)).status).toBe(403); // not before paying

    // The agent's own laptop (the projector) is loopback: previews only, too.
    const port = (t.agent.app.server.address() as AddressInfo).port;
    const viaLoopback = async (file: string) => (await fetch(`http://127.0.0.1:${port}${list}/${file}`)).status;
    expect(await viaLoopback('logo.png')).toBe(200);
    expect(await viaLoopback('slugify.js')).toBe(403);

    // The freelancer uploaded it, so it may open everything.
    expect((await t.fromLan(`${list}/slugify.js`, job.freelancerToken)).status).toBe(200);
  });
});

describe('counteroffers', () => {
  const OFFER = '40000000';   // 40 tUSDT instead of 50
  const OFFER_FEE = '800000'; // 2% of 40

  it('a bid above the listed reward can be accepted: funding asks for that reward + its fee', async () => {
    const t = await start();
    const job = await t.listed();
    const bid = await t.call('POST', `/escrows/${job.id}/offers`, { termsHash: job.termsHash, amount: '60000000' });
    expect(bid.status).toBe(200);
    const made = bid.body.escrow.offers[0];
    expect(made).toMatchObject({ amount: '60000000', fee: '1200000' });
    const accepted = await t.call('POST', `/escrows/${job.id}/offers/${made.id}/accept`, { termsHash: made.termsHash, clientToken: job.clientToken });
    expect(accepted.body).toMatchObject({ state: 'AGREED', amount: '60000000', fee: '1200000' });
    expect((await t.waitFor(job.id, 'AWAITING_FUNDS')).escrow.fundingInvoice).toMatch(/:61200000$/);
  });

  it('freelancers offer any price; the client accepts → agreed at the new reward and fee, others declined, the offer token works', async () => {
    const t = await start();
    const job = await t.listed();
    const offer = (body: object) => t.call('POST', `/escrows/${job.id}/offers`, body);

    expect((await offer({ termsHash: 'b'.repeat(64), amount: OFFER })).status).toBe(409); // not the version on the listing
    expect((await offer({ termsHash: job.termsHash, amount: '0' })).status).toBe(400);
    const o1 = await offer({ termsHash: job.termsHash, amount: OFFER, note: 'I can do it today' });
    expect(o1.status).toBe(200);
    expect(o1.body).toMatchObject({ offerId: 'o1', offerToken: expect.stringMatching(/^[0-9a-f]{64}$/) });
    const made = o1.body.escrow.offers[0];
    expect(made).toMatchObject({ id: 'o1', amount: OFFER, fee: OFFER_FEE, note: 'I can do it today', status: 'pending' });
    expect(made.termsHash).not.toBe(job.termsHash); // same job, another reward: other terms
    expect(JSON.stringify(o1.body.escrow)).not.toContain(o1.body.offerToken);
    const o2 = await offer({ termsHash: job.termsHash, amount: '60000000' }); // above the listed 50: allowed
    expect(o2.status).toBe(200);
    expect(o2.body.offerId).toBe('o2');

    // Only the client accepts, and only the exact terms it was shown.
    const accept = (offerId: string, body: object) => t.call('POST', `/escrows/${job.id}/offers/${offerId}/accept`, body);
    expect((await accept('o1', { termsHash: made.termsHash, clientToken: 'f'.repeat(64) })).status).toBe(403);
    expect((await accept('o1', { termsHash: job.termsHash, clientToken: job.clientToken })).status).toBe(409);
    expect((await accept('o9', { termsHash: made.termsHash, clientToken: job.clientToken })).status).toBe(404);
    const accepted = await accept('o1', { termsHash: made.termsHash, clientToken: job.clientToken });
    expect(accepted.status).toBe(200);
    expect(accepted.body).toMatchObject({ state: 'AGREED', amount: OFFER, fee: OFFER_FEE, termsHash: made.termsHash });
    expect(accepted.body.acceptances).toEqual([
      expect.objectContaining({ role: 'client', termsHash: made.termsHash }),
      { role: 'freelancer', termsHash: made.termsHash, at: made.at },
    ]);
    expect(accepted.body.offers.map((o: { status: string }) => o.status)).toEqual(['accepted', 'declined']);
    expect((await accept('o1', { termsHash: made.termsHash, clientToken: job.clientToken })).status).toBe(200); // idempotent
    expect((await t.call('POST', `/escrows/${job.id}/take`, { termsHash: made.termsHash })).body.error).toMatch(/already took/);
    expect((await offer({ termsHash: made.termsHash, amount: '1' })).status).toBe(409); // no longer OPEN

    // Funding asks for the new reward + fee; the accepted offer's token is the freelancer's token.
    const waiting = await t.waitFor(job.id, 'AWAITING_FUNDS');
    expect(waiting.escrow.fundingInvoice).toMatch(/:40800000$/);
    expect(waiting.events.filter((e) => e.type === 'offer.made')).toHaveLength(2);
    expect(waiting.events.find((e) => e.type === 'terms.agreed')).toMatchObject({ actor: 'client', data: { offerId: 'o1', amount: OFFER, listedAmount: REWARD } });
    expect(waiting.events.find((e) => e.type === 'offer.declined')).toMatchObject({ data: { offerId: 'o2' } });
    expect(JSON.stringify(waiting.events)).not.toContain('I can do it today'); // the note stays out of the log

    expect((await t.call('POST', `/escrows/${job.id}/refund-invoice`, { invoice: 'mock:client-refund:x:40800000', clientToken: job.clientToken })).status).toBe(200);
    await t.call('POST', `/escrows/${job.id}/funded`, { txid: 'tx' });
    await t.waitFor(job.id, 'FUNDED');
    expect((await t.deliver(job.id, slugifyProject(2), o2.body.offerToken)).status).toBe(403);
    expect((await t.deliver(job.id, slugifyProject(2), o1.body.offerToken)).status).toBe(200);
    const done = await t.waitFor(job.id, 'RELEASED');
    expect(done.events.find((e) => e.type === 'payout.sent')!.data).toMatchObject({ amount: OFFER, feeKept: OFFER_FEE });
  });

  it('an unanswered offer expires; the listing itself is untouched', async () => {
    const t = await start({ offerWindowSec: 1 });
    const job = await t.listed();
    const made = await t.call('POST', `/escrows/${job.id}/offers`, { termsHash: job.termsHash, amount: '30000000' });
    const end = Date.now() + 10_000;
    let d = await t.detail(job.id);
    while (d.escrow.offers![0]!.status === 'pending' && Date.now() < end) {
      await new Promise((r) => setTimeout(r, 100));
      d = await t.detail(job.id);
    }
    expect(d.escrow.offers![0]!.status).toBe('expired');
    expect(d.events.at(-1)).toMatchObject({ type: 'offer.expired', data: { offerId: 'o1' } });
    expect(d.escrow.state).toBe('OPEN');
    const late = await t.call('POST', `/escrows/${job.id}/offers/o1/accept`, { termsHash: made.body.escrow.offers[0].termsHash, clientToken: job.clientToken });
    expect(late.status).toBe(409);
  });

  it('only its freelancer withdraws an offer; taking or editing the listing declines the pending ones', async () => {
    const t = await start();
    const job = await t.listed();
    const made = await t.call('POST', `/escrows/${job.id}/offers`, { termsHash: job.termsHash, amount: '30000000' });
    const withdraw = (token: string) => t.call('POST', `/escrows/${job.id}/offers/${made.body.offerId}/withdraw`, { offerToken: token });
    expect((await withdraw('e'.repeat(64))).status).toBe(403);
    expect((await withdraw(made.body.offerToken)).body.offers[0].status).toBe('withdrawn');
    expect((await withdraw(made.body.offerToken)).status).toBe(200); // idempotent

    // Taken at the listed reward → the remaining offers are declined.
    const pending = await t.call('POST', `/escrows/${job.id}/offers`, { termsHash: job.termsHash, amount: '35000000' });
    expect((await t.call('POST', `/escrows/${job.id}/take`, { termsHash: job.termsHash })).status).toBe(200);
    expect((await t.detail(job.id)).escrow.offers!.find((x) => x.id === pending.body.offerId)!.status).toBe('declined');

    // The client edits the listing → offers on the old terms are declined.
    const job2 = await t.listed();
    await t.call('POST', `/escrows/${job2.id}/offers`, { termsHash: job2.termsHash, amount: '35000000' });
    expect((await t.call('POST', `/escrows/${job2.id}/reparse`, { rawText: `${SLUGIFY} Use ESM.`, clientToken: job2.clientToken })).status).toBe(200);
    const edited = await t.detail(job2.id);
    expect(edited.escrow.offers![0]!.status).toBe('declined');
    expect(edited.events.some((e) => e.type === 'offer.declined')).toBe(true);
  });

  it('a job that reopens after an accepted offer stays at the agreed terms', async () => {
    const t = await start({ fundingWindowSec: 1 });
    const job = await t.listed();
    const made = await t.call('POST', `/escrows/${job.id}/offers`, { termsHash: job.termsHash, amount: OFFER });
    const offerHash = made.body.escrow.offers[0].termsHash as string;
    expect((await t.call('POST', `/escrows/${job.id}/offers/o1/accept`, { termsHash: offerHash, clientToken: job.clientToken })).status).toBe(200);
    const reopened = await t.waitFor(job.id, 'OPEN');
    expect(reopened.escrow).toMatchObject({ amount: OFFER, fee: OFFER_FEE, termsHash: offerHash });
    expect(reopened.escrow.acceptances).toEqual([expect.objectContaining({ role: 'client', termsHash: offerHash })]);
    // The old offer token is void; the next taker agrees to the same terms at once.
    expect((await t.call('POST', `/escrows/${job.id}/cancel`, { role: 'freelancer', token: made.body.offerToken })).status).toBe(409);
    expect((await t.call('POST', `/escrows/${job.id}/take`, { termsHash: offerHash })).status).toBe(200);
  });
});

describe('offer rules (pure)', () => {
  const now = new Date('2026-10-18T10:00:00.000Z');
  const base = { title: 'Slugify', assetId: 'rgb:a', deadline: '2026-10-18T10:10:00.000Z', conditions: [] };
  const offer = (over: Partial<Offer>): Offer => ({
    id: 'o1', amount: '1', fee: '1', termsHash: 'a'.repeat(64), at: now.toISOString(), expiresAt: '2026-10-18T10:05:00.000Z', status: 'pending', ...over,
  });

  it('expires after the offer window, but never after the deadline', () => {
    expect(offerExpiry(now, 60, base.deadline)).toBe('2026-10-18T10:01:00.000Z');
    expect(offerExpiry(now, 3600, base.deadline)).toBe(base.deadline);
  });

  it('finds only pending offers past their expiry', () => {
    const later = new Date('2026-10-18T10:05:00.000Z');
    expect(expiredOfferIds([offer({ id: 'o1' }), offer({ id: 'o2', status: 'withdrawn' }), offer({ id: 'o3', expiresAt: '2026-10-18T10:06:00.000Z' })], later)).toEqual(['o1']);
    expect(expiredOfferIds(undefined, later)).toEqual([]);
  });

  it('the offer terms are the listing terms with the new reward and its fee', () => {
    const listed = offerTerms(base, REWARD);
    expect(listed).toEqual({ fee: FEE, termsHash: termsHash({ ...base, amount: REWARD, fee: FEE }) });
    expect(offerTerms(base, '40000000')).toEqual({ fee: '800000', termsHash: termsHash({ ...base, amount: '40000000', fee: '800000' }) });
    expect(offerTerms(base, '40000000').termsHash).not.toBe(listed.termsHash);
  });
});
