import { randomBytes } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyRequest } from 'fastify';
import { ZodError, type ZodType } from 'zod';
import {
  AGENT_ROUTES,
  ASSIST_SCHEMAS,
  AcceptOfferRequestSchema,
  AcceptRequestSchema,
  ApproveRequestSchema,
  CancelRequestSchema,
  CreateEscrowRequestSchema,
  DeliveryFieldsSchema,
  DevMineRequestSchema,
  ESCROW_TOKEN_HEADER,
  FundedRequestSchema,
  MakeOfferRequestSchema,
  PROXIED_ASSISTS,
  PublishRequestSchema,
  RefundInvoiceRequestSchema,
  ReparseRequestSchema,
  RetryStepRequestSchema,
  TakeRequestSchema,
  WithdrawOfferRequestSchema,
  type AgentHealthResponse,
  type ConfigResponse,
  type CreateEscrowResponse,
  type DeliveryFilesResponse,
  type DryRunResponse,
  type EscrowDetailResponse,
  type EscrowWallet,
  type MakeOfferResponse,
  type ProxiedAssistName,
  type TakeResponse,
  type WalletResponse,
} from '@escrow/shared';
import { AiClient, Explainer } from './ai-client';
import type { Config } from './config';
import { Dev } from './dev';
import { DryRuns } from './dry-run';
import { Hub } from './hub';
import { log } from './log';
import { Machine } from './machine';
import { Orchestrator, type Upload } from './orchestrator';
import { Store } from './store';
import { explanationTemplate } from './templates';
import { startTicker } from './ticker';
import { HttpError, errorMessage, notFound } from './util';
import { contentType, deliveryRoot, isPreviewImage, listFiles, resolveDeliveryFile } from './verifier/files';
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
  const dryRuns = new DryRuns({ config, store, ai });

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

  app.post<IdParams>(AGENT_ROUTES.reparse(':id'), async (req) => {
    const body = parse(ReparseRequestSchema, req.body);
    return orchestrator.reparse(req.params.id, body.rawText, body.clientToken);
  });

  app.post<IdParams>(AGENT_ROUTES.accept(':id'), async (req) =>
    orchestrator.accept(req.params.id, parse(AcceptRequestSchema, req.body)),
  );

  app.post<IdParams>(AGENT_ROUTES.publish(':id'), async (req) =>
    orchestrator.publish(req.params.id, parse(PublishRequestSchema, req.body)),
  );

  app.post<IdParams>(AGENT_ROUTES.take(':id'), async (req): Promise<TakeResponse> => {
    const { escrow, freelancerToken } = await orchestrator.take(req.params.id, parse(TakeRequestSchema, req.body));
    return { ...escrow, freelancerToken };
  });

  type OfferParams = { Params: { id: string; offerId: string } };

  app.post<IdParams>(AGENT_ROUTES.offers(':id'), async (req): Promise<MakeOfferResponse> =>
    orchestrator.makeOffer(req.params.id, parse(MakeOfferRequestSchema, req.body)),
  );

  app.post<OfferParams>(AGENT_ROUTES.acceptOffer(':id', ':offerId'), async (req) =>
    orchestrator.acceptOffer(req.params.id, req.params.offerId, parse(AcceptOfferRequestSchema, req.body)),
  );

  app.post<OfferParams>(AGENT_ROUTES.withdrawOffer(':id', ':offerId'), async (req) =>
    orchestrator.withdrawOffer(req.params.id, req.params.offerId, parse(WithdrawOfferRequestSchema, req.body).offerToken),
  );

  app.post<IdParams>(AGENT_ROUTES.cancel(':id'), async (req) => {
    const body = parse(CancelRequestSchema, req.body);
    return orchestrator.cancel(req.params.id, body.role, body.token);
  });

  app.post<IdParams>(AGENT_ROUTES.refundInvoice(':id'), async (req) => {
    const body = parse(RefundInvoiceRequestSchema, req.body);
    return orchestrator.setRefundInvoice(req.params.id, body.invoice, body.clientToken);
  });

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

  // The projector runs on the agent's own laptop, so a loopback request is "the agent".
  const fromAgentLaptop = (req: FastifyRequest) => ['127.0.0.1', '::1', '::ffff:127.0.0.1'].includes(req.ip);
  const tokenOf = (req: FastifyRequest) => {
    const value = req.headers[ESCROW_TOKEN_HEADER];
    return typeof value === 'string' && value !== '' ? value : undefined;
  };
  const fileAccess = (req: FastifyRequest<FileParams>) => {
    if (!store.has(req.params.id)) throw notFound('Escrow');
    const access = orchestrator.fileAccess(req.params.id, tokenOf(req), fromAgentLaptop(req));
    if (access === 'none') throw new HttpError(403, 'Only the client, the freelancer and the escrow service can see this work');
    return access;
  };

  app.get<FileParams>(AGENT_ROUTES.deliveryFiles(':id', ':n'), async (req): Promise<DeliveryFilesResponse> => {
    const access = fileAccess(req);
    return listFiles(filesRoot(req.params.id, req.params.n)).map((f) => ({
      ...f,
      previewable: access === 'all' || isPreviewImage(f.path),
    }));
  });

  app.get<FileParams>(AGENT_ROUTES.deliveryFile(':id', ':n', '*'), async (req, reply) => {
    const access = fileAccess(req);
    const file = resolveDeliveryFile(filesRoot(req.params.id, req.params.n), req.params['*']);
    if (!file) throw notFound('File');
    if (access === 'images' && !isPreviewImage(file)) {
      throw new HttpError(403, 'Until the work is paid, only image previews can be opened');
    }
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

  /**
   * Stream a multipart upload (one `file`, max 20 MB) to data/tmp, then run `use` with it and the text fields.
   * The temp file is always deleted afterwards (addDelivery moves it away first).
   */
  async function withUpload<T>(req: FastifyRequest, usage: string, use: (upload: Upload, fields: Record<string, string>) => Promise<T>): Promise<T> {
    if (!req.isMultipart()) throw new HttpError(400, `Send multipart/form-data with ${usage}`);
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
      if (!upload) throw new HttpError(400, 'A "file" is required');
      if (upload.sizeBytes === 0) throw new HttpError(400, 'The file is empty');
      return await use(upload, fields);
    } finally {
      for (const f of tmpFiles) fs.rmSync(f, { force: true });
    }
  }

  app.post<IdParams>(AGENT_ROUTES.deliveries(':id'), async (req) => {
    if (!store.has(req.params.id)) throw notFound('Escrow');
    return withUpload(req, 'a "file" and a "payoutInvoice"', (upload, fields) => {
      const body = parse(DeliveryFieldsSchema, fields);
      return orchestrator.addDelivery(req.params.id, upload, body.payoutInvoice, body.freelancerToken);
    });
  });

  app.post<IdParams>(AGENT_ROUTES.dryRun(':id'), async (req): Promise<DryRunResponse> => {
    if (!store.has(req.params.id)) throw notFound('Escrow');
    return withUpload(req, 'a "file"', (upload) => dryRuns.run(req.params.id, upload));
  });

  // ---- AI assist -----------------------------------------------------------------------------

  /** Pass-through to apps/ai `/assist/:name` for the UI. Advisory: no state change, no LogEvent. */
  app.post<{ Params: { name: string } }>(AGENT_ROUTES.assist(':name'), async (req) => {
    const name = req.params.name as ProxiedAssistName;
    if (!PROXIED_ASSISTS.includes(name)) throw new HttpError(404, `Unknown assist: ${req.params.name}`);
    const body = parse<unknown>(ASSIST_SCHEMAS[name].request, req.body);
    try {
      return await ai.assist(name, body);
    } catch (err) {
      log.warn(`assist ${name} failed: ${errorMessage(err)}`);
      throw new HttpError(503, 'The AI assistant is not available right now');
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
