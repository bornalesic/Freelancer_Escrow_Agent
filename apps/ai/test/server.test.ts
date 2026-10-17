import { AiHealthSchema, AiReviewSchema, ExplainSyncResultSchema, ParseResultSchema } from '@escrow/shared';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { FastifyInstance } from 'fastify';
import { mockHandlers } from '../src/mock.ts';
import { buildServer } from '../src/server.ts';
import { escrow, event, landingEscrow, slugify } from './fixtures.ts';

let app: FastifyInstance;
beforeAll(async () => { app = await buildServer(mockHandlers()); });
afterAll(async () => { await app.close(); });

const parseBody = slugify;

describe('server (mock mode)', () => {
  it('GET /health', async () => {
    const res = await app.inject({ method: 'GET', url: '/health' });
    expect(res.statusCode).toBe(200);
    expect(AiHealthSchema.parse(res.json())).toMatchObject({ ok: true, loaded: true });
    expect(res.headers['access-control-allow-origin']).toBe('*');
  });

  it('POST /parse returns a valid ParseResult', async () => {
    const res = await app.inject({ method: 'POST', url: '/parse', payload: parseBody });
    expect(res.statusCode).toBe(200);
    const r = ParseResultSchema.parse(res.json());
    expect(r.conditions.map((c) => c.kind)).toEqual(['tests_pass', 'file_present']);
  });

  it('POST /parse rejects a bad body with 400 { error, details }', async () => {
    const res = await app.inject({ method: 'POST', url: '/parse', payload: { title: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.any(String), details: expect.any(Array) });
  });

  it('POST /explain/sync', async () => {
    const res = await app.inject({ method: 'POST', url: '/explain/sync', payload: { event: event('funding.settled'), escrow: escrow() } });
    expect(res.statusCode).toBe(200);
    expect(ExplainSyncResultSchema.parse(res.json()).text).toContain('50 tUSDT');
  });

  it('POST /explain streams SSE deltas and a final done message', async () => {
    const res = await app.inject({ method: 'POST', url: '/explain', payload: { event: event('terms.agreed'), escrow: escrow() } });
    expect(res.statusCode).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    const chunks = res.body.split('\n\n').filter(Boolean).map((l) => JSON.parse(l.replace(/^data: /, '')));
    const done = chunks.at(-1);
    expect(done).toMatchObject({ done: true, source: 'template' });
    expect(chunks.slice(0, -1).map((c) => c.text).join('')).toBe(done.text);
  });

  it('POST /explain rejects a bad body with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/explain', payload: { event: {} } });
    expect(res.statusCode).toBe(400);
  });

  it('POST /review (mock) mirrors the demo: delivery #1 looks unmet, later ones look met', async () => {
    const files = [{ path: 'index.html', sizeBytes: 10, excerpt: '<html></html>' }];
    const v1 = await app.inject({ method: 'POST', url: '/review', payload: { escrow: landingEscrow(), deliveryN: 1, files } });
    expect(v1.statusCode).toBe(200);
    expect(AiReviewSchema.parse(v1.json()).items).toEqual([expect.objectContaining({ conditionId: 'c3', opinion: 'looks_unmet' })]);

    const two = landingEscrow({ deliveries: [...landingEscrow().deliveries, { n: 2, fileName: 'landing-v2.zip', sha256: 'c'.repeat(64), sizeBytes: 2048, at: '2026-10-17T12:10:00Z' }] });
    const v2 = await app.inject({ method: 'POST', url: '/review', payload: { escrow: two, deliveryN: 2, files } });
    expect(AiReviewSchema.parse(v2.json()).items[0]).toMatchObject({ opinion: 'looks_met' });
  });

  it('POST /review rejects an unknown delivery number with 400', async () => {
    const res = await app.inject({ method: 'POST', url: '/review', payload: { escrow: landingEscrow(), deliveryN: 7, files: [] } });
    expect(res.statusCode).toBe(400);
    expect(res.json()).toMatchObject({ error: expect.stringContaining('#7') });
  });
});
