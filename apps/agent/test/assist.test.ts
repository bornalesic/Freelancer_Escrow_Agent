import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { DryRunResponseSchema, HintRequestSchema, type EscrowDetailResponse } from '@escrow/shared';
import { buildApp, type AgentApp } from '../src/app';
import { loadConfig, type Config } from '../src/config';
import { StubWallet } from '../src/wallet/stub';
import { slugifyProject, tmpDir, zipBuffer } from './helpers';

// ---- a fake apps/ai: /parse with an examples check, /assist/* -----------------------------------

const EXAMPLES = {
  id: 'x',
  kind: 'examples',
  description: 'slugify returns the agreed output for 2 example inputs.',
  target: { type: 'js_function', export: 'slugify' },
  cases: [
    { input: 'Hello, World!', expected: 'hello-world' },
    { input: 'A B', expected: 'a-b' },
  ],
  timeoutSec: 30,
};

function startFakeAi() {
  const calls: { url: string; body: any }[] = [];
  const json = (res: http.ServerResponse, body: unknown, status = 200) => {
    res.statusCode = status;
    res.setHeader('content-type', 'application/json');
    res.end(JSON.stringify(body));
  };
  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = raw ? JSON.parse(raw) : undefined;
      if (req.url !== '/health') calls.push({ url: req.url!, body });
      switch (req.url) {
        case '/health':
          return json(res, { ok: true, model: 'fake' });
        case '/parse':
          return json(res, {
            conditions: [
              { id: 'x', kind: 'tests_pass', description: 'The included tests pass.', command: 'npm test', timeoutSec: 30 },
              { id: 'x', kind: 'file_present', description: 'A README is included.', pathPattern: 'README*' },
              EXAMPLES,
            ],
            summary: 'Slugify for 50 TUSDT.',
            clarifications: [],
            source: 'ai',
            ms: 3,
          });
        case '/explain':
          res.setHeader('content-type', 'text/event-stream');
          return res.end('data: {"done":true,"text":"Plain words."}\n\n');
        case '/assist/clarify':
          return json(res, {
            questions: [{ id: 'q1', topic: 'Language', question: 'Which language?', why: 'Decides the test command.', options: ['JavaScript'] }],
            source: 'ai',
            ms: 4,
          });
        case '/assist/estimate':
          return json(res, { size: 'huge' }); // not an EstimateResult
        case '/assist/hint':
          return json(res, {
            items: body.results
              .filter((r: any) => !r.passed)
              .map((r: any) => ({ conditionId: r.conditionId, why: 'Punctuation is kept.', hint: 'Strip it in slugify.js.' })),
            source: 'ai',
            ms: 5,
          });
        default:
          return json(res, { error: 'not found' }, 404);
      }
    });
  });
  return new Promise<{ url: string; close: () => void; calls: typeof calls }>((resolve) =>
    server.listen(0, '127.0.0.1', () =>
      resolve({ url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`, close: () => server.close(), calls }),
    ),
  );
}

// ---- helpers -----------------------------------------------------------------------------------

const testConfig = (aiUrl: string): Config => ({
  ...loadConfig({}),
  dataDir: tmpDir(),
  aiUrl,
  clientPartyUrl: undefined,
  autoMine: false,
  walletPollMs: 50,
  mockSettleMs: 100,
  tickMs: 200,
  aiExplainTimeoutMs: 3000,
  aiAssistTimeoutMs: 3000,
});

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
  const upload = async (url: string, version: 1 | 2, fields: Record<string, string> = {}) => {
    const fd = new FormData();
    for (const [k, v] of Object.entries(fields)) fd.set(k, v);
    fd.set('file', new Blob([zipBuffer(slugifyProject(version))]), `slugify-v${version}.zip`);
    const res = await fetch(base + url, { method: 'POST', body: fd });
    return { status: res.status, body: (await res.json()) as any };
  };
  const proposed = async () => {
    const created = await call('POST', '/escrows', {
      title: 'Slugify',
      rawText: 'Build slugify. "Hello, World!" becomes "hello-world". The included tests must pass. Also include a README.',
      amount: '50000000',
      deadline: new Date(Date.now() + 30 * 60_000).toISOString(),
    });
    expect(created.status).toBe(201);
    const id = created.body.id as string;
    return { id, d: await waitFor(id, (x) => x.escrow.state === 'PROPOSED', 'PROPOSED') };
  };
  const fund = async (id: string, termsHash: string) => {
    for (const role of ['client', 'freelancer']) await call('POST', `/escrows/${id}/accept`, { role, termsHash });
    await waitFor(id, (x) => x.escrow.state === 'AWAITING_FUNDS', 'AWAITING_FUNDS');
    await call('POST', `/escrows/${id}/refund-invoice`, { invoice: 'mock:client-refund:x:50000000' });
    await call('POST', `/escrows/${id}/funded`, { txid: 'tx' });
    await waitFor(id, (x) => x.escrow.state === 'FUNDED', 'FUNDED');
  };
  /** A funded escrow: where the freelancer can deliver, and so where a practice check is allowed. */
  const funded = async () => {
    const { id, d } = await proposed();
    await fund(id, d.escrow.termsHash!);
    return id;
  };
  return { agent, base, config, call, detail, waitFor, upload, proposed, fund, funded };
}

// ---- tests -------------------------------------------------------------------------------------

describe('AI assist (fake apps/ai)', () => {
  let ai: Awaited<ReturnType<typeof startFakeAi>>;
  let t: Awaited<ReturnType<typeof start>>;
  const agents: AgentApp[] = [];

  beforeAll(async () => {
    ai = await startFakeAi();
    t = await start(testConfig(ai.url));
    agents.push(t.agent);
  });
  afterAll(async () => {
    ai.close();
    await Promise.all(agents.map((a) => a.app.close()));
  });

  describe('POST /assist/:name', () => {
    it('passes a proxied assist through and returns the AI result', async () => {
      const r = await t.call('POST', '/assist/clarify', { title: 'Logo', rawText: 'Make me a logo.' });
      expect(r.status).toBe(200);
      expect(r.body).toMatchObject({ questions: [{ id: 'q1', topic: 'Language' }], source: 'ai' });
      expect(ai.calls.at(-1)).toEqual({ url: '/assist/clarify', body: { title: 'Logo', rawText: 'Make me a logo.' } });
    });

    it('404 for an unknown name, and for hint (only the dry run calls it)', async () => {
      expect((await t.call('POST', '/assist/vibes', {})).status).toBe(404);
      expect((await t.call('POST', '/assist/hint', {})).status).toBe(404);
    });

    it('400 with details for an invalid body, without calling the AI', async () => {
      const before = ai.calls.length;
      const r = await t.call('POST', '/assist/clarify', { title: 'Logo' });
      expect(r.status).toBe(400);
      expect(r.body.details).toBeInstanceOf(Array);
      expect(ai.calls.length).toBe(before);
    });

    it("503 when the AI's answer is not the assist's result", async () => {
      const r = await t.call('POST', '/assist/estimate', { title: 'Logo', rawText: 'A logo.', amountDisplay: '50', assetTicker: 'TUSDT', deadlineMinutes: 60 });
      expect(r.status).toBe(503);
      expect(r.body.error).toBe('The AI assistant is not available right now');
    });
  });

  describe('examples condition, end to end', () => {
    it('v1 fails the punctuation example, v2 passes everything and is paid', async () => {
      const { id, d } = await t.proposed();
      expect(d.escrow.conditions.map((c) => c.kind)).toEqual(['tests_pass', 'file_present', 'examples']);
      await t.fund(id, d.escrow.termsHash!);

      expect((await t.upload(`/escrows/${id}/deliveries`, 1, { payoutInvoice: 'mock:freelancer:x:50000000' })).status).toBe(200);
      const v1 = await t.waitFor(id, (x) => x.escrow.state === 'FUNDED' && !!x.escrow.deliveries[0]?.results, 'v1 checked');
      const ex1 = v1.escrow.deliveries[0]!.results!.find((r) => r.conditionId === 'c3')!;
      expect(ex1.passed).toBe(false);
      expect(ex1.evidence.stdoutTail).toContain('✖ slugify("Hello, World!") → "hello-world"');

      expect((await t.upload(`/escrows/${id}/deliveries`, 2, { payoutInvoice: 'mock:freelancer:x:50000000' })).status).toBe(200);
      const v2 = await t.waitFor(id, (x) => x.escrow.state === 'RELEASED', 'RELEASED');
      expect(v2.escrow.deliveries[1]!.results!.every((r) => r.passed)).toBe(true);
    });
  });

  describe('POST /escrows/:id/dry-run', () => {
    it('runs the checks on a practice upload, with hints for what failed, and changes nothing', async () => {
      const id = await t.funded();
      const before = await t.detail(id);

      const r = await t.upload(`/escrows/${id}/dry-run`, 1);
      expect(r.status).toBe(200);
      const res = DryRunResponseSchema.parse(r.body);
      expect(res.results.map((x) => [x.conditionId, x.passed])).toEqual([['c1', false], ['c2', true], ['c3', false]]);
      expect([res.passed, res.total]).toEqual([1, 3]);
      expect(res.hints?.items.map((h) => h.conditionId)).toEqual(['c1', 'c3']);

      // What the AI got: the escrow, the results, and excerpts of the upload as sent.
      const hint = HintRequestSchema.parse(ai.calls.filter((c) => c.url === '/assist/hint').at(-1)!.body);
      expect(hint.escrow.id).toBe(id);
      expect(hint.files.find((f) => f.path === 'slugify.js')?.excerpt).toContain('export const slugify');

      // No state change, no log event, nothing left on disk.
      const after = await t.detail(id);
      expect(after.escrow).toEqual(before.escrow);
      expect(after.events.length).toBe(before.events.length);
      expect(after.escrow.state).toBe('FUNDED');
      expect(after.escrow.deliveries).toEqual([]);
      expect(fs.readdirSync(path.join(t.config.dataDir, 'work', id))).toEqual([]);
    });

    it('all checks pass → no hints, and the AI is not asked', async () => {
      const id = await t.funded();
      const hintsBefore = ai.calls.filter((c) => c.url === '/assist/hint').length;
      const res = DryRunResponseSchema.parse((await t.upload(`/escrows/${id}/dry-run`, 2)).body);
      expect([res.passed, res.total]).toEqual([3, 3]);
      expect(res.hints).toBeUndefined();
      expect(ai.calls.filter((c) => c.url === '/assist/hint').length).toBe(hintsBefore);
    });

    it('one practice check at a time per job', async () => {
      const id = await t.funded();
      const statuses = (await Promise.all([1, 1].map((v) => t.upload(`/escrows/${id}/dry-run`, v as 1)))).map((r) => r.status).sort();
      expect(statuses).toEqual([200, 409]);
    });

    it('404 "Escrow not found" for an unknown escrow (the UI tells it apart from a missing route)', async () => {
      const r = await t.upload('/escrows/esc_none/dry-run', 2);
      expect(r.status).toBe(404);
      expect(r.body.error).toBe('Escrow not found');
    });

    it('409 unless the escrow is funded (before funding, once finished), 400 without a file', async () => {
      const { id } = await t.proposed();
      const early = await t.upload(`/escrows/${id}/dry-run`, 2);
      expect(early.status).toBe(409);
      expect(early.body.error).toMatch(/state is PROPOSED/);
      const noFile = await fetch(`${t.base}/escrows/${id}/dry-run`, { method: 'POST', body: new FormData() });
      expect(noFile.status).toBe(400);
      await t.call('POST', `/escrows/${id}/cancel`, { role: 'client' });
      await t.waitFor(id, (x) => x.escrow.state === 'CANCELLED', 'CANCELLED');
      expect((await t.upload(`/escrows/${id}/dry-run`, 2)).body.error).toMatch(/state is CANCELLED/);
    });
  });
});

describe('AI assist with the AI down', () => {
  let t: Awaited<ReturnType<typeof start>>;
  beforeAll(async () => {
    t = await start(testConfig('http://127.0.0.1:9'));
  });
  afterAll(() => t.agent.app.close());

  it('the proxy answers 503, and a dry run still returns its results without hints', async () => {
    expect((await t.call('POST', '/assist/clarify', { title: 'Logo', rawText: 'Make me a logo.' })).status).toBe(503);
    const id = await t.funded(); // fallback parser: tests_pass, README, and the literal example
    const res = DryRunResponseSchema.parse((await t.upload(`/escrows/${id}/dry-run`, 1)).body);
    expect(res.passed).toBeLessThan(res.total);
    expect(res.hints).toBeUndefined();
  });
});
