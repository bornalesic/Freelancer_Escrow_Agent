import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { Escrow, EscrowDetailResponse, LogEventType, WsMessage } from '@escrow/shared';
import { buildApp, type AgentApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { StubWallet } from '../src/wallet/stub';
import { safeNow } from '../src/util';
import { slugifyProject, tmpDir, zipBuffer } from './helpers';

// ---- a fake apps/ai: /parse (with one hallucinated hash) and streaming /explain ---------------

function startFakeAi(): Promise<{ url: string; close: () => void; reviews: string[] }> {
  const reviews: string[] = []; // raw /review bodies, to check what the agent sends
  const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
      if (req.url === '/health') {
        res.setHeader('content-type', 'application/json');
        return res.end(JSON.stringify({ ok: true, loaded: true, model: 'fake' }));
      }
      if (req.url === '/parse' && body.includes('warm colours')) {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            conditions: [
              { id: 'x', kind: 'file_present', description: 'index.html is included.', pathPattern: 'index.html' },
              { id: 'y', kind: 'client_review', description: 'The page looks clean and uses warm colours.' },
            ],
            summary: 'Landing page for 30 tUSDT.',
            clarifications: [],
            source: 'ai',
            model: 'fake',
            ms: 3,
          }),
        );
      }
      if (req.url === '/review') {
        reviews.push(body);
        const v2 = body.includes('#ff8c42');
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            items: [
              { conditionId: 'c2', opinion: v2 ? 'looks_met' : 'looks_unmet', note: 'The header colour is in styles.css.' },
              { conditionId: 'zz', opinion: 'looks_met', note: 'Unknown id, must be dropped.' },
            ],
            source: 'ai',
            model: 'fake',
            ms: 5,
          }),
        );
      }
      if (req.url === '/parse') {
        res.setHeader('content-type', 'application/json');
        return res.end(
          JSON.stringify({
            conditions: [
              { id: 'x', kind: 'tests_pass', description: 'The included tests pass.', command: 'npm test', timeoutSec: 30 },
              { id: 'x', kind: 'file_present', description: 'A README is included.', pathPattern: 'README*' },
              { id: 'y', kind: 'file_hash', description: 'Invented hash', sha256: 'a'.repeat(64) },
            ],
            summary: 'Slugify for 50 tUSDT.',
            clarifications: [],
            source: 'ai',
            model: 'fake',
            ms: 3,
          }),
        );
      }
      if (req.url === '/explain') {
        res.setHeader('content-type', 'text/event-stream');
        res.write('data: {"text":"Plain "}\n\n');
        res.write('data: {"text":"words."}\n\n');
        return res.end('data: {"done":true,"text":"Plain words."}\n\n');
      }
      res.statusCode = 404;
      res.end();
    });
  });
  return new Promise((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), reviews }),
    ),
  );
}

// ---- helpers -----------------------------------------------------------------------------------

function testConfig(aiUrl: string, dataDir = tmpDir()): Config {
  return {
    ...loadConfig({}),
    dataDir,
    aiUrl,
    clientPartyUrl: undefined,
    autoMine: false,
    walletPollMs: 50,
    mockSettleMs: 100,
    tickMs: 200,
    aiExplainTimeoutMs: 3000,
  };
}

async function start(config: Config) {
  const agent = await buildApp({ config, wallet: new StubWallet('regtest', config.mockSettleMs) });
  await agent.app.listen({ host: '127.0.0.1', port: 0 });
  const base = `http://127.0.0.1:${(agent.app.server.address() as AddressInfo).port}`;

  const call = async (method: string, url: string, body?: unknown) => {
    const res = await fetch(base + url, {
      method,
      ...(body !== undefined ? { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } : {}),
    });
    return { status: res.status, body: (await res.json()) as any };
  };
  const detail = async (id: string) => (await call('GET', `/escrows/${id}`)).body as EscrowDetailResponse;
  const waitFor = async (id: string, pred: (d: EscrowDetailResponse) => boolean, what: string) => {
    const end = Date.now() + 25_000;
    for (;;) {
      const d = await detail(id);
      if (pred(d)) return d;
      if (Date.now() > end) throw new Error(`timed out waiting for ${what}; state=${d.escrow.state}`);
      await new Promise((r) => setTimeout(r, 50));
    }
  };
  const deliver = async (id: string, version: 1 | 2) => {
    const fd = new FormData();
    fd.set('payoutInvoice', `mock:freelancer-${version}:x:50000000`);
    fd.set('file', new Blob([zipBuffer(slugifyProject(version))]), `slugify-v${version}.zip`);
    const res = await fetch(`${base}/escrows/${id}/deliveries`, { method: 'POST', body: fd });
    return { status: res.status, body: (await res.json()) as any };
  };
  const deliverFiles = async (id: string, files: Record<string, string>, name: string) => {
    const fd = new FormData();
    fd.set('payoutInvoice', `mock:freelancer-${name}:x:1`);
    fd.set('file', new Blob([zipBuffer(files)]), `${name}.zip`);
    const res = await fetch(`${base}/escrows/${id}/deliveries`, { method: 'POST', body: fd });
    return { status: res.status, body: (await res.json()) as any };
  };
  /** create → propose → accept ×2 → fund. Returns the escrow id and the clientToken. */
  const fundedEscrow = async (rawText: string, deadlineMs = 30 * 60_000) => {
    const created = await call('POST', '/escrows', { title: 'Landing', rawText, amount: '30000000', deadline: deadlineIn(deadlineMs) });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    const proposed = await waitFor(id, (x) => x.escrow.state === 'PROPOSED', 'PROPOSED');
    for (const role of ['client', 'freelancer']) {
      await call('POST', `/escrows/${id}/accept`, { role, termsHash: proposed.escrow.termsHash });
    }
    await waitFor(id, (x) => x.escrow.state === 'AWAITING_FUNDS', 'AWAITING_FUNDS');
    await call('POST', `/escrows/${id}/refund-invoice`, { invoice: 'mock:client-refund:x:30000000' });
    await call('POST', `/escrows/${id}/funded`, { txid: 'tx' });
    await waitFor(id, (x) => x.escrow.state === 'FUNDED', 'FUNDED');
    return { id, clientToken: created.body.clientToken as string };
  };
  return { agent, base, call, detail, waitFor, deliver, deliverFiles, fundedEscrow };
}

const deadlineIn = (ms: number) => new Date(Date.now() + ms).toISOString();

const landing = (headerColour: string): Record<string, string> => ({
  'index.html': '<!doctype html><link rel="stylesheet" href="styles.css"><h1>Bakery</h1>',
  'styles.css': `:root { --header: ${headerColour}; }\nh1 { background: var(--header); }\n`,
  'README.md': '# Bakery landing page\n',
  'logo.bin': '\u0000\u0001binary',
});

const STATE_EVENTS: LogEventType[] = [
  'escrow.created', 'terms.proposed', 'terms.agreed', 'funding.invoice_created', 'funding.settled',
  'delivery.received', 'verify.started', 'decision.made', 'payout.settled', 'refund.settled',
];

// ---- tests -------------------------------------------------------------------------------------

describe('escrow flow (stub wallet)', () => {
  let ai: Awaited<ReturnType<typeof startFakeAi>>;
  let agents: AgentApp[] = [];

  beforeAll(async () => {
    ai = await startFakeAi();
  });
  afterAll(async () => {
    ai.close();
    await Promise.all(agents.map((a) => a.app.close()));
  });

  it('create → propose → accept ×2 → fund → v1 fails → v2 passes → released', async () => {
    const config = testConfig(ai.url);
    const t = await start(config);
    agents.push(t.agent);

    const created = await t.call('POST', '/escrows', {
      title: 'Slugify',
      rawText: 'Build slugify. The included tests must pass. Also include a README.',
      amount: '50000000',
      deadline: deadlineIn(30 * 60_000),
    });
    expect(created.status).toBe(201);
    const id = (created.body as Escrow).id;

    // Live feed for this escrow.
    const messages: WsMessage[] = [];
    const ws = new WebSocket(`${t.base.replace('http', 'ws')}/ws?escrowId=${id}`);
    ws.onmessage = (m) => messages.push(JSON.parse(String(m.data)));
    await new Promise((r) => (ws.onopen = r));

    let d = await t.waitFor(id, (x) => x.escrow.state === 'PROPOSED', 'PROPOSED');
    expect(d.escrow.conditions.map((c) => [c.id, c.kind])).toEqual([['c1', 'tests_pass'], ['c2', 'file_present']]);
    expect(d.escrow.clarifications?.join(' ')).toMatch(/fingerprint/); // invented hash dropped
    const hash = d.escrow.termsHash!;

    expect((await t.call('POST', `/escrows/${id}/accept`, { role: 'client', termsHash: 'b'.repeat(64) })).status).toBe(409);
    expect((await t.call('POST', `/escrows/${id}/accept`, { role: 'client' })).status).toBe(400);
    expect((await t.call('POST', `/escrows/${id}/accept`, { role: 'client', termsHash: hash })).body.state).toBe('PROPOSED');
    expect((await t.call('POST', `/escrows/${id}/accept`, { role: 'client', termsHash: hash })).status).toBe(200); // idempotent
    expect((await t.call('POST', `/escrows/${id}/accept`, { role: 'freelancer', termsHash: hash })).body.state).toBe('AGREED');

    d = await t.waitFor(id, (x) => x.escrow.state === 'AWAITING_FUNDS', 'AWAITING_FUNDS');
    expect(d.escrow.fundingInvoice).toMatch(/^mock:/);
    expect((await t.deliver(id, 1)).status).toBe(409); // not funded yet
    await t.call('POST', `/escrows/${id}/refund-invoice`, { invoice: 'mock:client-refund:x:50000000' });

    await t.call('POST', `/escrows/${id}/funded`, { txid: 'client-tx' });
    await t.waitFor(id, (x) => x.escrow.state === 'FUNDED', 'FUNDED');
    expect((await t.call('POST', `/escrows/${id}/cancel`, { role: 'client' })).status).toBe(409);

    // v1: one test fails → back to FUNDED
    expect((await t.deliver(id, 1)).status).toBe(200);
    d = await t.waitFor(id, (x) => x.escrow.state === 'FUNDED' && Boolean(x.escrow.deliveries[0]?.results), 'v1 verified');
    const r1 = d.escrow.deliveries[0]!.results!;
    expect(r1.find((r) => r.conditionId === 'c1')!.passed).toBe(false);
    expect(r1.find((r) => r.conditionId === 'c1')!.evidence.stdoutTail).toContain('strips punctuation');
    expect(r1.find((r) => r.conditionId === 'c2')!.passed).toBe(true);
    expect(d.events.filter((e) => e.type === 'decision.made').at(-1)!.data).toMatchObject({ action: 'retry', failed: ['c1'] });

    // v2: everything passes → released
    expect((await t.deliver(id, 2)).status).toBe(200);
    d = await t.waitFor(id, (x) => x.escrow.state === 'RELEASED', 'RELEASED');
    expect(d.escrow.payoutInvoice).toBe('mock:freelancer-2:x:50000000');

    const types = d.events.map((e) => e.type);
    expect(types).toEqual([
      'escrow.created', 'terms.proposed', 'terms.accepted', 'terms.accepted', 'terms.agreed',
      'funding.invoice_created', 'funding.payment_seen', 'funding.settled',
      'delivery.received', 'verify.started', 'verify.condition_result', 'verify.condition_result',
      'verify.finished', 'decision.made',
      'delivery.received', 'verify.started', 'verify.condition_result', 'verify.condition_result',
      'verify.finished', 'decision.made', 'payout.sent', 'payout.settled',
    ]);
    // WS4 colours the log from these two data fields.
    expect(d.events.filter((e) => e.type === 'decision.made').map((e) => e.data?.action)).toEqual(['retry', 'release']);
    expect(d.events.filter((e) => e.type === 'verify.condition_result').map((e) => e.data?.passed)).toEqual([
      false, true, true, true,
    ]);
    // Exactly one state-change event per transition: creation + 11 transitions in this run.
    expect(types.filter((x) => STATE_EVENTS.includes(x))).toHaveLength(12);
    expect(d.events.map((e) => e.id)).toEqual(d.events.map((_, i) => `${id}:${String(i + 1).padStart(4, '0')}`));

    // Explanations streamed from the (fake) AI and stored on the events.
    await t.waitFor(id, (x) => x.events.filter((e) => e.explain).every((e) => e.explanation), 'explanations');
    const final = await t.detail(id);
    expect(final.events.find((e) => e.type === 'payout.settled')!.explanationSource).toBe('ai');
    expect(final.events.filter((e) => e.explain).map((e) => e.type)).toEqual([
      'terms.proposed', 'terms.agreed', 'funding.settled', 'verify.condition_result', 'decision.made',
      'decision.made', 'payout.settled',
    ]);
    expect((await t.call('GET', '/health')).body).toMatchObject({ aiUp: true, aiModel: 'fake' });
    expect(messages[0]!.kind).toBe('snapshot');
    expect(messages.some((m) => m.kind === 'explanation_delta' && m.text === 'Plain ')).toBe(true);
    expect(messages.some((m) => m.kind === 'explanation_done' && m.source === 'ai')).toBe(true);
    ws.close();

    // Agent wallet: +50 in, −50 out.
    const wallet = await t.call('GET', '/wallet');
    expect(wallet.body.assets[0].settled).toBe('0');

    // Restart on the same data dir: state and log survive.
    await t.agent.app.close();
    const again = await start(testConfig(ai.url, config.dataDir));
    agents.push(again.agent);
    const reloaded = await again.detail(id);
    expect(reloaded.escrow.state).toBe('RELEASED');
    expect(reloaded.events).toHaveLength(final.events.length);
  });

  it('refunds the client when the deadline passes (AI down → fallback parser + templates)', async () => {
    const t = await start(testConfig('http://127.0.0.1:9'));
    agents.push(t.agent);

    const health = await t.call('GET', '/health');
    expect(health.body).toMatchObject({ ok: true, walletMode: 'mock', aiUp: false });

    const { body } = await t.call('POST', '/escrows', {
      title: 'Quick job',
      rawText: 'The included tests must pass. Also include a README.',
      amount: '1000000',
      deadline: deadlineIn(2500),
    });
    const id = (body as Escrow).id;
    let d = await t.waitFor(id, (x) => x.escrow.state === 'PROPOSED', 'PROPOSED');
    expect(d.events[1]!.data).toMatchObject({ source: 'fallback' });
    expect(d.escrow.conditions.map((c) => c.kind)).toEqual(['tests_pass', 'file_present']);

    for (const role of ['client', 'freelancer']) {
      await t.call('POST', `/escrows/${id}/accept`, { role, termsHash: d.escrow.termsHash });
    }
    await t.waitFor(id, (x) => x.escrow.state === 'AWAITING_FUNDS', 'AWAITING_FUNDS');
    await t.call('POST', `/escrows/${id}/refund-invoice`, { invoice: 'mock:client-refund:x:1000000' });
    await t.call('POST', `/escrows/${id}/funded`, { txid: 'tx' });
    await t.waitFor(id, (x) => x.escrow.state === 'FUNDED', 'FUNDED');

    d = await t.waitFor(id, (x) => x.escrow.state === 'REFUNDED', 'REFUNDED');
    const decision = d.events.find((e) => e.type === 'decision.made')!;
    expect(decision.data).toMatchObject({ action: 'refund' });
    expect(Date.parse(decision.at)).toBeGreaterThanOrEqual(Date.parse(d.escrow.deadline)); // never early
    expect(d.events.some((e) => e.type === 'refund.sent')).toBe(true);
    expect((await t.deliver(id, 2)).status).toBe(409);

    d = await t.waitFor(id, (x) => x.events.filter((e) => e.explain).every((e) => e.explanation), 'templates');
    expect(d.events.find((e) => e.type === 'refund.settled')!.explanationSource).toBe('template');
  });

  it('sends CORS headers for JSON preflights and browser uploads', async () => {
    const t = await start(testConfig('http://127.0.0.1:9'));
    agents.push(t.agent);
    const origin = 'http://192.168.1.30:5173';
    const pre = await fetch(`${t.base}/escrows/esc_x/accept`, {
      method: 'OPTIONS',
      headers: { origin, 'access-control-request-method': 'POST', 'access-control-request-headers': 'content-type' },
    });
    expect(pre.status).toBe(204);
    expect(pre.headers.get('access-control-allow-origin')).toBe(origin);
    expect(pre.headers.get('access-control-allow-methods')).toContain('POST');

    const fd = new FormData();
    fd.set('payoutInvoice', 'mock:x');
    fd.set('file', new Blob(['x']), 'x.txt');
    const up = await fetch(`${t.base}/escrows/esc_x/deliveries`, { method: 'POST', body: fd, headers: { origin } });
    expect(up.status).toBe(404); // unknown escrow, but the browser can still read the error
    expect(up.headers.get('access-control-allow-origin')).toBe(origin);
    expect((await t.call('GET', '/health')).body.aiModel).toBeUndefined();
  });

  it('validates bodies and rejects bad requests', async () => {
    const t = await start(testConfig('http://127.0.0.1:9'));
    agents.push(t.agent);
    const bad = await t.call('POST', '/escrows', { title: '', rawText: 'x', amount: '1.5', deadline: 'tomorrow' });
    expect(bad.status).toBe(400);
    expect(bad.body.error).toBe('Invalid request');
    expect(Array.isArray(bad.body.details)).toBe(true);
    const past = await t.call('POST', '/escrows', { title: 'x', rawText: 'x', amount: '1', deadline: deadlineIn(-1000) });
    expect(past.status).toBe(400);
    expect((await t.call('GET', '/escrows/esc_nope')).status).toBe(404);

    // Re-parse clears acceptances; old termsHash is then rejected.
    const { body } = await t.call('POST', '/escrows', { title: 'x', rawText: 'Tests must pass.', amount: '1', deadline: deadlineIn(60_000) });
    const first = await t.waitFor(body.id, (x) => x.escrow.state === 'PROPOSED', 'PROPOSED');
    await t.call('POST', `/escrows/${body.id}/accept`, { role: 'client', termsHash: first.escrow.termsHash });
    await t.call('POST', `/escrows/${body.id}/reparse`, { rawText: 'Tests must pass. Include a README.' });
    const second = await t.waitFor(body.id, (x) => x.escrow.state === 'PROPOSED', 'PROPOSED again');
    expect(second.escrow.acceptances).toEqual([]);
    expect(second.escrow.termsHash).not.toBe(first.escrow.termsHash);
    expect((await t.call('POST', `/escrows/${body.id}/accept`, { role: 'client', termsHash: first.escrow.termsHash })).status).toBe(409);

    // Cancel before funding; then nothing else is allowed.
    expect((await t.call('POST', `/escrows/${body.id}/cancel`, { role: 'freelancer' })).body.state).toBe('CANCELLED');
    expect((await t.call('POST', `/escrows/${body.id}/accept`, { role: 'client', termsHash: second.escrow.termsHash })).status).toBe(409);
  });

  it('client review: report → dispute → FUNDED → v2 → approve → released', async () => {
    const t = await start(testConfig(ai.url));
    agents.push(t.agent);
    const { id, clientToken } = await t.fundedEscrow(
      'Build a one-page landing site for my bakery as index.html. The page should look clean and use warm colours.',
    );
    expect(clientToken).toMatch(/^[0-9a-f]{64}$/);
    const proposed = (await t.detail(id)).events.find((e) => e.type === 'terms.proposed')!;
    expect(proposed.title).toBe('AI proposed 1 check and 1 item for the client to judge');

    // v1: automatic check passes → AWAITING_APPROVAL with a review window and the AI's opinion
    expect((await t.deliverFiles(id, landing('#1e3a8a'), 'landing-v1')).status).toBe(200);
    let d = await t.waitFor(id, (x) => Boolean(x.escrow.deliveries[0]?.review), 'review v1');
    expect(d.escrow.state).toBe('AWAITING_APPROVAL');
    const v1 = d.escrow.deliveries[0]!;
    expect(v1.results!.map((r) => r.conditionId)).toEqual(['c1']); // no result for the client_review item
    expect(Date.parse(v1.reviewDueAt!)).toBeGreaterThan(Date.now());
    expect(v1.review).toMatchObject({ source: 'ai', items: [{ conditionId: 'c2', opinion: 'looks_unmet' }] });
    expect(d.events.find((e) => e.type === 'review.report_ready')!.title).toBe('AI opinion on delivery 1: 1 looks unmet');
    expect(d.events.filter((e) => e.type === 'decision.made').at(-1)!.data).toMatchObject({ action: 'await_approval', pending: ['c2'] });

    // What the AI got: excerpts of text files, none for binaries, never the clientToken.
    const sent = JSON.parse(ai.reviews.at(-1)!);
    expect(sent.deliveryN).toBe(1);
    expect(sent.files.find((f: any) => f.path === 'styles.css').excerpt).toContain('#1e3a8a');
    expect(sent.files.find((f: any) => f.path === 'logo.bin').excerpt).toBeUndefined();

    // The clientToken never leaves POST /escrows.
    expect(JSON.stringify(d)).not.toContain(clientToken);
    expect(JSON.stringify(await t.call('GET', '/escrows'))).not.toContain(clientToken);
    expect(ai.reviews.join('')).not.toContain(clientToken);
    expect(fs.readFileSync(path.join(t.agent.store.dataDir, 'db.json'), 'utf8')).not.toContain(clientToken);

    // Delivered files, served sandboxed.
    const list = await t.call('GET', `/escrows/${id}/deliveries/1/files`);
    expect(list.body.map((f: any) => f.path)).toEqual(['index.html', 'logo.bin', 'README.md', 'styles.css']);
    const page = await fetch(`${t.base}/escrows/${id}/deliveries/1/files/index.html`);
    expect(page.status).toBe(200);
    expect(page.headers.get('content-security-policy')).toBe('sandbox');
    expect(page.headers.get('x-content-type-options')).toBe('nosniff');
    expect(page.headers.get('content-type')).toContain('text/html');
    expect(await page.text()).toContain('Bakery');
    expect((await fetch(`${t.base}/escrows/${id}/deliveries/1/files/..%2F..%2Fdb.json`)).status).toBe(404);
    expect((await fetch(`${t.base}/escrows/${id}/deliveries/1/files/nope.txt`)).status).toBe(404);
    expect((await t.call('GET', `/escrows/${id}/deliveries/9/files`)).status).toBe(404);

    // Guards on /approve and on new deliveries.
    expect((await t.deliverFiles(id, landing('#000'), 'early')).status).toBe(409);
    const answer = (body: object) => t.call('POST', `/escrows/${id}/approve`, { deliveryN: 1, clientToken, ...body });
    expect((await answer({ decision: 'approve', clientToken: 'f'.repeat(64) })).status).toBe(403);
    expect((await answer({ decision: 'dispute' })).status).toBe(400);
    expect((await answer({ decision: 'approve', deliveryN: 2 })).status).toBe(409);

    // Dispute → back to FUNDED; the reason is on the delivery for the freelancer.
    const disputed = await answer({ decision: 'dispute', reason: 'The header should be warm, not blue' });
    expect(disputed.body.state).toBe('FUNDED');
    expect(disputed.body.deliveries[0].approval).toMatchObject({ decision: 'dispute', reason: 'The header should be warm, not blue' });
    expect((await answer({ decision: 'approve' })).status).toBe(409); // nothing to approve now

    // v2 → approve → released
    expect((await t.deliverFiles(id, landing('#ff8c42'), 'landing-v2')).status).toBe(200);
    d = await t.waitFor(id, (x) => Boolean(x.escrow.deliveries[1]?.review), 'review v2');
    expect(d.escrow.deliveries[1]!.review!.items).toEqual([
      { conditionId: 'c2', opinion: 'looks_met', note: 'The header colour is in styles.css.' },
    ]);
    expect((await answer({ decision: 'approve', deliveryN: 1 })).status).toBe(409); // old delivery
    expect((await answer({ decision: 'approve', deliveryN: 2 })).body.state).toBe('RELEASING');
    d = await t.waitFor(id, (x) => x.escrow.state === 'RELEASED', 'RELEASED');

    const types = d.events.map((e) => e.type);
    expect(types.slice(types.indexOf('delivery.received'))).toEqual([
      'delivery.received', 'verify.started', 'verify.condition_result', 'verify.finished', 'decision.made',
      'review.report_ready', 'review.disputed', 'decision.made',
      'delivery.received', 'verify.started', 'verify.condition_result', 'verify.finished', 'decision.made',
      'review.report_ready', 'review.approved', 'decision.made', 'payout.sent', 'payout.settled',
    ]);
    expect(d.events.filter((e) => e.type === 'decision.made').map((e) => e.data?.action)).toEqual([
      'await_approval', 'retry', 'await_approval', 'release',
    ]);
    expect(d.events.find((e) => e.type === 'review.disputed')).toMatchObject({ actor: 'client', explain: true });
  });

  it('client review: no answer in the review window → released (AI down → fallback parser + template review)', async () => {
    const t = await start({ ...testConfig('http://127.0.0.1:9'), reviewWindowSec: 1 });
    agents.push(t.agent);
    const { id, clientToken } = await t.fundedEscrow('Include a README. The page should look clean and use warm colours.');
    let d = await t.detail(id);
    expect(d.escrow.conditions.map((c) => c.kind)).toEqual(['file_present', 'client_review']);

    expect((await t.deliverFiles(id, landing('#ff8c42'), 'v1')).status).toBe(200);
    d = await t.waitFor(id, (x) => x.escrow.state === 'RELEASED', 'RELEASED');
    const review = d.escrow.deliveries[0]!.review!;
    expect(review).toMatchObject({ source: 'template', items: [{ conditionId: 'c2', opinion: 'unsure' }] });
    const types = d.events.map((e) => e.type);
    expect(types.slice(types.indexOf('review.report_ready'))).toEqual([
      'review.report_ready', 'review.expired', 'decision.made', 'payout.sent', 'payout.settled',
    ]);
    expect(d.events.filter((e) => e.type === 'decision.made').at(-1)!.data).toMatchObject({ action: 'release' });
    expect((await t.call('POST', `/escrows/${id}/approve`, { deliveryN: 1, decision: 'approve', clientToken })).status).toBe(409);
  });

  // ---- edge cases: races, restarts, deadlines, hostile uploads -------------------------------

  const REVIEW_TEXT = 'Build a one-page landing site for my bakery as index.html. The page should look clean and use warm colours.';

  it('approve and dispute sent at the same time: exactly one wins, exactly one decision', async () => {
    const t = await start(testConfig(ai.url));
    agents.push(t.agent);
    const { id, clientToken } = await t.fundedEscrow(REVIEW_TEXT);
    await t.deliverFiles(id, landing('#ff8c42'), 'v1');
    await t.waitFor(id, (x) => x.escrow.state === 'AWAITING_APPROVAL', 'AWAITING_APPROVAL');

    const answer = (decision: string) =>
      t.call('POST', `/escrows/${id}/approve`, { deliveryN: 1, decision, reason: 'no', clientToken });
    const replies = await Promise.all([answer('approve'), answer('dispute'), answer('approve')]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409, 409]);

    const d = await t.detail(id);
    const answers = d.events.filter((e) => e.type === 'review.approved' || e.type === 'review.disputed');
    expect(answers).toHaveLength(1);
    expect(d.events.filter((e) => e.type === 'decision.made')).toHaveLength(2); // await_approval + the answer
  });

  it('two uploads at the same time: one is accepted, the other gets 409', async () => {
    const t = await start(testConfig(ai.url));
    agents.push(t.agent);
    const { id } = await t.fundedEscrow(REVIEW_TEXT);
    const replies = await Promise.all([
      t.deliverFiles(id, landing('#111'), 'a'),
      t.deliverFiles(id, landing('#222'), 'b'),
    ]);
    expect(replies.map((r) => r.status).sort()).toEqual([200, 409]);
    expect((await t.detail(id)).escrow.deliveries).toHaveLength(1);
  });

  it('agent restart while waiting for the client: the token still works and the escrow carries on', async () => {
    const config = testConfig(ai.url);
    const t = await start(config);
    agents.push(t.agent);
    const { id, clientToken } = await t.fundedEscrow(REVIEW_TEXT);
    await t.deliverFiles(id, landing('#ff8c42'), 'v1');
    await t.waitFor(id, (x) => Boolean(x.escrow.deliveries[0]?.review), 'review');
    await t.agent.app.close();

    const again = await start(testConfig(ai.url, config.dataDir));
    agents.push(again.agent);
    expect((await again.detail(id)).escrow.state).toBe('AWAITING_APPROVAL');
    const body = { deliveryN: 1, decision: 'approve', clientToken };
    expect((await again.call('POST', `/escrows/${id}/approve`, { ...body, clientToken: 'f'.repeat(64) })).status).toBe(403);
    expect((await again.call('POST', `/escrows/${id}/approve`, body)).status).toBe(200);
    await again.waitFor(id, (x) => x.escrow.state === 'RELEASED', 'RELEASED');
  });

  it('the deadline alone never refunds work under review; a dispute after the deadline refunds', async () => {
    const t = await start(testConfig(ai.url));
    agents.push(t.agent);
    const { id, clientToken } = await t.fundedEscrow(REVIEW_TEXT, 2500);
    await t.deliverFiles(id, landing('#ff8c42'), 'v1');
    let d = await t.waitFor(id, (x) => x.escrow.state === 'AWAITING_APPROVAL', 'AWAITING_APPROVAL');
    // Past the deadline by the agent's own clock (safeNow can trail a stepping wall clock), then 3 ticker runs.
    while (safeNow().getTime() < Date.parse(d.escrow.deadline)) await new Promise((r) => setTimeout(r, 50));
    await new Promise((r) => setTimeout(r, 600));
    expect((await t.detail(id)).escrow.state).toBe('AWAITING_APPROVAL');

    const res = await t.call('POST', `/escrows/${id}/approve`, { deliveryN: 1, decision: 'dispute', reason: 'Too late and wrong', clientToken });
    expect(res.body.state).toBe('REFUNDING');
    d = await t.waitFor(id, (x) => x.escrow.state === 'REFUNDED', 'REFUNDED');
    expect(d.events.filter((e) => e.type === 'decision.made').at(-1)!.data).toMatchObject({ action: 'refund' });
  });

  it('a zip that tries to escape its folder fails the checks instead of writing outside', async () => {
    const t = await start(testConfig(ai.url));
    agents.push(t.agent);
    const { id } = await t.fundedEscrow(REVIEW_TEXT);
    const AdmZip = (await import('adm-zip')).default;
    const zip = new AdmZip();
    zip.addFile('index.html', Buffer.from('<h1>x</h1>'));
    zip.addFile('placeholder.txt', Buffer.from('evil'));
    // adm-zip cleans names on addFile, so rename the entry in place to a hostile path.
    zip.getEntry('placeholder.txt')!.entryName = '../../escaped.txt';
    const fd = new FormData();
    fd.set('payoutInvoice', 'mock:freelancer:x:1');
    fd.set('file', new Blob([zip.toBuffer()]), 'evil.zip');
    expect((await fetch(`${t.base}/escrows/${id}/deliveries`, { method: 'POST', body: fd })).status).toBe(200);

    const d = await t.waitFor(id, (x) => x.escrow.state === 'FUNDED' && Boolean(x.escrow.deliveries[0]?.results), 'verified');
    const r = d.escrow.deliveries[0]!.results![0]!;
    expect(r.passed).toBe(false);
    expect(r.evidence.error).toMatch(/Unsafe path/);
    const dataDir = t.agent.store.dataDir;
    for (const dir of [dataDir, path.join(dataDir, 'work'), path.join(dataDir, 'work', id)]) {
      expect(fs.existsSync(path.join(dir, 'escaped.txt'))).toBe(false);
    }
    expect((await t.call('GET', `/escrows/${id}/deliveries/1/files`)).status).toBe(422);
  });

  it('approve on an unknown escrow → 404; before any delivery → 409', async () => {
    const t = await start(testConfig(ai.url));
    agents.push(t.agent);
    const { id, clientToken } = await t.fundedEscrow(REVIEW_TEXT);
    const body = { deliveryN: 1, decision: 'approve', clientToken };
    expect((await t.call('POST', '/escrows/esc_nope/approve', body)).status).toBe(404);
    expect((await t.call('POST', `/escrows/${id}/approve`, body)).status).toBe(409);
  });
});
