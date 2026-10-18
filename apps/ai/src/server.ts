import cors from '@fastify/cors';
import {
  AI_ROUTES, ASSIST_NAMES, ASSIST_SCHEMAS, ExplainRequestSchema, ParseRequestSchema, ReviewRequestSchema,
  type AiHealth, type AiReview, type ExplainRequest, type ExplainStreamChunk, type ExplainSyncResult,
  type ParseRequest, type ParseResult, type ReviewRequest,
} from '@escrow/shared';
import Fastify, { type FastifyInstance, type FastifyReply } from 'fastify';
import type { z } from 'zod';
import type { AssistHandlers } from './assistHandlers.ts';

export interface AiHandlers {
  health(): AiHealth & Record<string, unknown>;
  parse(req: ParseRequest): Promise<ParseResult>;
  /** Streams deltas via onDelta; the resolved text is authoritative. Must not throw. */
  explain(req: ExplainRequest, onDelta?: (text: string) => void, signal?: AbortSignal): Promise<ExplainSyncResult>;
  /** Advisory opinion on each client_review condition. Must not throw. */
  review(req: ReviewRequest): Promise<AiReview>;
  /** POST /assist/<name>: advisory helpers, each with a deterministic fallback. Must not throw. */
  assist: AssistHandlers;
}

function badRequest(reply: FastifyReply, error: z.ZodError) {
  return reply.code(400).send({ error: 'invalid request body', details: error.issues });
}

export async function buildServer(h: AiHandlers, log: (msg: string) => void = () => {}): Promise<FastifyInstance> {
  const app = Fastify({ logger: false, bodyLimit: 2 * 1024 * 1024 });
  await app.register(cors, { origin: '*' });

  // One line per request. Hijacked SSE responses log themselves. Every agent polls /health every 5 s,
  // so a successful health check is logged only the first time a caller shows up.
  const healthCallers = new Set<string>();
  app.addHook('onResponse', async (req, reply) => {
    if (reply.statusCode === 200 && req.url === AI_ROUTES.explain) return;
    if (reply.statusCode === 200 && req.url === AI_ROUTES.health) {
      if (!healthCallers.has(req.ip)) log(`health: first poll from ${req.ip} (later polls are not logged)`);
      healthCallers.add(req.ip);
      return;
    }
    log(`${req.method} ${req.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
  });

  app.setErrorHandler((err: Error & { statusCode?: number }, _req, reply) => {
    const status = err.statusCode && err.statusCode < 500 ? err.statusCode : 500;
    if (status === 500) log(`error: ${err.stack ?? err.message}`);
    void reply.code(status).send({ error: err.message, details: null });
  });

  app.get(AI_ROUTES.health, async () => h.health());

  app.post(AI_ROUTES.parse, async (request, reply) => {
    const body = ParseRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    return h.parse(body.data);
  });

  app.post(AI_ROUTES.review, async (request, reply) => {
    const body = ReviewRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    if (!body.data.escrow.deliveries.some((d) => d.n === body.data.deliveryN)) {
      return reply.code(400).send({ error: `escrow has no delivery #${body.data.deliveryN}`, details: null });
    }
    return h.review(body.data);
  });

  for (const name of ASSIST_NAMES) {
    app.post(AI_ROUTES.assist(name), async (request, reply) => {
      const body = ASSIST_SCHEMAS[name].request.safeParse(request.body);
      if (!body.success) return badRequest(reply, body.error);
      return (h.assist[name] as (req: unknown) => Promise<unknown>)(body.data);
    });
  }

  app.post(AI_ROUTES.explainSync, async (request, reply) => {
    const body = ExplainRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);
    return h.explain(body.data);
  });

  // SSE: `data: {"text": "..."}` deltas, then `data: {"done": true, "text": "<full>", "source": "ai"|"template"}`.
  app.post(AI_ROUTES.explain, async (request, reply) => {
    const body = ExplainRequestSchema.safeParse(request.body);
    if (!body.success) return badRequest(reply, body.error);

    const t0 = performance.now();
    const client = new AbortController();
    reply.raw.on('close', () => {
      if (!reply.raw.writableFinished) client.abort(new Error('client disconnected'));
    });
    reply.hijack();
    reply.raw.writeHead(200, {
      'content-type': 'text/event-stream; charset=utf-8',
      'cache-control': 'no-cache, no-transform',
      connection: 'keep-alive',
      'access-control-allow-origin': '*',
      'x-accel-buffering': 'no',
    });
    const send = (chunk: ExplainStreamChunk) => {
      if (!reply.raw.writableEnded) reply.raw.write(`data: ${JSON.stringify(chunk)}\n\n`);
    };
    let result: ExplainSyncResult;
    try {
      result = await h.explain(body.data, (text) => { if (text) send({ text }); }, client.signal);
    } catch (e) {
      log(`explain: handler threw: ${(e as Error).message}`);
      result = { text: body.data.event.title, source: 'template' };
    }
    send({ done: true, text: result.text, source: result.source });
    reply.raw.end();
    log(`POST ${request.url} 200 ${Math.round(performance.now() - t0)}ms (sse, ${result.source})`);
  });

  return app;
}
