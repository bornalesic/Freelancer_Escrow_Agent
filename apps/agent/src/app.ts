import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import {
  AGENT_ROUTES,
  AcceptRequestSchema,
  ApproveRequestSchema,
  CancelRequestSchema,
  CreateEscrowRequestSchema,
  DeliveryFieldsSchema,
  DevMineRequestSchema,
  FundedRequestSchema,
  RefundInvoiceRequestSchema,
  ReparseRequestSchema,
  RetryStepRequestSchema,
  type AgentHealthResponse,
  type ConfigResponse,
  type CreateEscrowResponse,
  type DeliveryFilesResponse,
  type EscrowDetailResponse,
  type EscrowWallet,
  type WalletResponse,
} from '@escrow/shared';
import { AiClient, Explainer } from './ai-client';
import type { Config } from './config';
import { Dev } from './dev';
import { Hub } from './hub';
import { log } from './log';
import { Machine } from './machine';
import { Orchestrator, type Upload } from './orchestrator';
import { Store } from './store';
import { explanationTemplate } from './templates';
import { startTicker } from './ticker';
import { HttpError, errorMessage, notFound } from './util';
import { contentType, deliveryRoot, listFiles, resolveDeliveryFile } from './verifier/files';
import { WalletHolder } from './wallet';

export const MAX_UPLOAD_BYTES = 20 * 1024 * 1024;

export interface AppOptions {
  config: Config;
  /** Inject a wallet (tests). Otherwise @escrow/wallet, or the stub in mock mode. */
  wallet?: EscrowWallet;
}

export interface AgentApp {
  app: FastifyInstance;
  store: Store;
  orchestrator: Orchestrator;
  wallets: WalletHolder;
}

function parse<T>(schema: ZodType<T>, data: unknown): T {
  return schema.parse(data ?? {});
}

/** Keep a readable, safe file name: no path, no leading dot, limited charset. */
export function safeFileName(name: string | undefined): string {
  const base = path.basename((name ?? '').replace(/\\/g, '/')).replace(/[^\w.-]+/g, '_').slice(-100);
  if (!base || /^\.+$/.test(base)) return 'upload.bin';
  return base.startsWith('.') ? `_${base}` : base;
}

export async function buildApp(opts: AppOptions): Promise<AgentApp> {
  const { config } = opts;
  const store = new Store(config.dataDir);
  store.load();
  const hub = new Hub(store);
  const ai = new AiClient(config);
  const explainer = new Explainer(ai);

  const machine = new Machine(store, hub, (event, escrow) => {
    if (!event.explain) return;
    explainer.enqueue(
      event,
      escrow,
      explanationTemplate(event, escrow),
      (text) => hub.broadcast(event.escrowId, { kind: 'explanation_delta', eventId: event.id, text }),
      (text, source) => {
        if (!store.updateEvent(event.escrowId, event.id, { explanation: text, explanationSource: source })) return;
        hub.broadcast(event.escrowId, { kind: 'explanation_done', eventId: event.id, text, source });
      },
    );
  });

  const wallets = new WalletHolder(config);
  await wallets.create(opts.wallet);
  const dev = new Dev(config, wallets);
  const orchestrator = new Orchestrator({ config, store, machine, wallets, ai, dev });

  const app = Fastify({ logger: false, bodyLimit: 1024 * 1024 });
  await app.register(cors, { origin: true });
  await app.register(websocket);
  await app.register(multipart, { limits: { fileSize: MAX_UPLOAD_BYTES, files: 1, fields: 10, parts: 20 } });

  app.addHook('onResponse', async (req, reply) => {
    log.info(`${req.method} ${req.url} ${reply.statusCode} ${Math.round(reply.elapsedTime)}ms`);
  });

  app.setErrorHandler((err, _req, reply) => {
    if (err instanceof ZodError) return reply.code(400).send({ error: 'Invalid request', details: err.issues });
    if (err instanceof HttpError) {
      return reply.code(err.statusCode).send({ error: err.message, ...(err.details !== undefined ? { details: err.details } : {}) });
    }
    const e = err as { statusCode?: number; message?: string };
    if (e.statusCode && e.statusCode >= 400 && e.statusCode < 500) return reply.code(e.statusCode).send({ error: e.message });
    log.error(`unhandled: ${e.message}`);
    return reply.code(500).send({ error: 'Internal error', details: e.message });
  });

  // ---- info ----------------------------------------------------------------------------------

  app.get(AGENT_ROUTES.health, async (): Promise<AgentHealthResponse> => ({
    ok: wallets.ready,
    walletMode: config.walletMode,
    aiUp: ai.isUp,
    ...(ai.model ? { aiModel: ai.model } : {}),
    network: config.network,
    ...(wallets.error ? { error: wallets.error } : !wallets.ready ? { error: 'Agent wallet is starting' } : {}),
  }));

  app.get(AGENT_ROUTES.config, async (): Promise<ConfigResponse> => ({
    assetId: config.assetId,
    assetTicker: config.assetTicker,
    precision: config.precision,
    network: config.network,
  }));

  app.get(AGENT_ROUTES.wallet, async (): Promise<WalletResponse> => {
    if (!wallets.ready) throw new HttpError(503, wallets.error ?? 'Agent wallet is starting');
    const [info, assets] = await Promise.all([wallets.wallet.info(), wallets.wallet.listAssets()]);
    return { ...info, assets };
  });

  // ---- escrows -------------------------------------------------------------------------------

  type IdParams = { Params: { id: string } };

  app.post(AGENT_ROUTES.escrows, async (req, reply) => {
    const { escrow, clientToken } = await orchestrator.create(parse(CreateEscrowRequestSchema, req.body));
    const body: CreateEscrowResponse = { ...escrow, clientToken };
    return reply.code(201).send(body);
  });

  app.get(AGENT_ROUTES.escrows, async () => store.list());

  app.get<IdParams>(AGENT_ROUTES.escrow(':id'), async (req): Promise<EscrowDetailResponse> => {
    const escrow = store.get(req.params.id);
    if (!escrow) throw notFound('Escrow');
    return { escrow, events: store.eventsOf(escrow.id) };
  });

  app.post<IdParams>(AGENT_ROUTES.reparse(':id'), async (req) =>
    orchestrator.reparse(req.params.id, parse(ReparseRequestSchema, req.body).rawText),
  );

  app.post<IdParams>(AGENT_ROUTES.accept(':id'), async (req) =>
    orchestrator.accept(req.params.id, parse(AcceptRequestSchema, req.body)),
  );

  app.post<IdParams>(AGENT_ROUTES.cancel(':id'), async (req) =>
    orchestrator.cancel(req.params.id, parse(CancelRequestSchema, req.body).role),
  );

  app.post<IdParams>(AGENT_ROUTES.refundInvoice(':id'), async (req) =>
    orchestrator.setRefundInvoice(req.params.id, parse(RefundInvoiceRequestSchema, req.body).invoice),
  );

  app.post<IdParams>(AGENT_ROUTES.funded(':id'), async (req) =>
    orchestrator.fundedHint(req.params.id, parse(FundedRequestSchema, req.body).txid),
  );

  app.post<IdParams>(AGENT_ROUTES.approve(':id'), async (req) =>
    orchestrator.approve(req.params.id, parse(ApproveRequestSchema, req.body)),
  );

  /** The unpacked files of delivery `n` (a fresh copy, not the folder the tests ran in). */
  const filesRoot = (id: string, n: string): string => {
    const escrow = store.get(id);
    if (!escrow) throw notFound('Escrow');
    const delivery = escrow.deliveries.find((d) => String(d.n) === n);
    if (!delivery) throw notFound('Delivery');
    try {
      return deliveryRoot(config.dataDir, id, delivery.n, delivery.fileName);
    } catch (err) {
      throw new HttpError(422, 'The delivery could not be unpacked', errorMessage(err));
    }
  };

  type FileParams = { Params: { id: string; n: string; '*': string } };

  app.get<FileParams>(AGENT_ROUTES.deliveryFiles(':id', ':n'), async (req): Promise<DeliveryFilesResponse> =>
    listFiles(filesRoot(req.params.id, req.params.n)),
  );

  app.get<FileParams>(AGENT_ROUTES.deliveryFile(':id', ':n', '*'), async (req, reply) => {
    const file = resolveDeliveryFile(filesRoot(req.params.id, req.params.n), req.params['*']);
    if (!file) throw notFound('File');
    // Sandboxed: a delivered web page can't run scripts against the agent API or read its origin.
    return reply
      .header('content-security-policy', 'sandbox')
      .header('x-content-type-options', 'nosniff')
      .header('cache-control', 'no-store')
      .type(contentType(file))
      .send(fs.createReadStream(file));
  });

  app.post<IdParams>(AGENT_ROUTES.retryStep(':id'), async (req) =>
    orchestrator.retryStep(req.params.id, parse(RetryStepRequestSchema, req.body).force),
  );

  app.post<IdParams>(AGENT_ROUTES.deliveries(':id'), async (req) => {
    if (!store.has(req.params.id)) throw notFound('Escrow');
    if (!req.isMultipart()) throw new HttpError(400, 'Send multipart/form-data with a "file" and a "payoutInvoice"');
    const tmpDir = path.join(config.dataDir, 'tmp');
    fs.mkdirSync(tmpDir, { recursive: true });
    const fields: Record<string, string> = {};
    const tmpFiles: string[] = [];
    let upload: Upload | undefined;
    try {
      for await (const part of req.parts()) {
        if (part.type === 'file') {
          if (part.fieldname !== 'file' || upload) {
            part.file.resume();
            continue;
          }
          const tmpPath = path.join(tmpDir, `${Date.now()}-${randomBytes(4).toString('hex')}`);
          tmpFiles.push(tmpPath);
          await pipeline(part.file, fs.createWriteStream(tmpPath));
          if (part.file.truncated) throw new HttpError(413, 'The file is larger than 20 MB');
          upload = { tmpPath, fileName: safeFileName(part.filename), sizeBytes: fs.statSync(tmpPath).size };
        } else {
          fields[part.fieldname] = String(part.value);
        }
      }
      const { payoutInvoice } = parse(DeliveryFieldsSchema, fields);
      if (!upload) throw new HttpError(400, 'A "file" is required');
      if (upload.sizeBytes === 0) throw new HttpError(400, 'The file is empty');
      return await orchestrator.addDelivery(req.params.id, upload, payoutInvoice);
    } finally {
      for (const f of tmpFiles) fs.rmSync(f, { force: true });
    }
  });

  // ---- dev -----------------------------------------------------------------------------------

  app.post(AGENT_ROUTES.devMine, async (req) => dev.mine(parse(DevMineRequestSchema, req.body).blocks ?? 1));

  app.post(AGENT_ROUTES.devReset, async () => {
    if (config.nodeEnv === 'production') throw new HttpError(403, '/dev/reset is disabled in production');
    store.reset();
    log.warn('dev reset: all escrows deleted');
    return { ok: true };
  });

  // ---- websocket -----------------------------------------------------------------------------

  app.get(AGENT_ROUTES.ws, { websocket: true }, (socket, req) => {
    const { escrowId } = req.query as { escrowId?: string };
    hub.attach(socket, escrowId);
  });

  // ---- background ----------------------------------------------------------------------------

  const onTick = async () => {
    await wallets.init();
    await ai.health();
    orchestrator.tick();
  };
  const stopTicker = startTicker(config.tickMs, onTick);
  app.addHook('onClose', async () => stopTicker());
  void onTick();

  return { app, store, orchestrator, wallets };
}
