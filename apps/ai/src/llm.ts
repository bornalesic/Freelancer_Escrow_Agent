import type { AiConfig } from './config.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface GenerateOptions {
  messages: ChatMessage[];
  predict: number;                         // max new tokens
  jsonSchema?: Record<string, unknown>;    // grammar-constrained JSON output
  signal: AbortSignal;                     // timeout and/or client disconnect
  onDelta?: (text: string) => void;
  priority?: number;                       // higher runs first when all slots are busy
}

export interface GenerateResult {
  text: string;
  stopReason?: string;
  ms: number;
  tokensPerSecond?: number;
  generatedTokens?: number;
}

export interface EngineStatus {
  model: string;
  device: string;
  loaded: boolean;
  loading: boolean;
  progress?: number;
  error?: string;
  queued: number;
}

export interface LlmEngine {
  status(): EngineStatus;
  generate(o: GenerateOptions): Promise<GenerateResult>;
}

/** Concurrency limiter with priorities; waiting callers drop out when their signal aborts. */
export class Limiter {
  private active = 0;
  private seq = 0;
  private waiting: { priority: number; seq: number; start: () => void }[] = [];

  constructor(private readonly max: number) {}

  get queued(): number {
    return this.waiting.length;
  }

  async run<T>(priority: number, signal: AbortSignal, fn: () => Promise<T>): Promise<T> {
    await this.acquire(priority, signal);
    try {
      return await fn();
    } finally {
      this.active--;
      this.waiting.shift()?.start();
    }
  }

  private acquire(priority: number, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted();
    if (this.active < this.max) {
      this.active++;
      return Promise.resolve();
    }
    return new Promise((resolve, reject) => {
      const entry = {
        priority,
        seq: this.seq++,
        start: () => {
          signal.removeEventListener('abort', onAbort);
          this.active++;
          resolve();
        },
      };
      const onAbort = () => {
        this.waiting = this.waiting.filter((e) => e !== entry);
        reject(signal.reason);
      };
      signal.addEventListener('abort', onAbort, { once: true });
      this.waiting.push(entry);
      this.waiting.sort((a, b) => b.priority - a.priority || a.seq - b.seq);
    });
  }
}

// The subset of @qvac/sdk 0.21 we use. Typed locally so `npm run typecheck` works where the optional
// dependency is not installed (WSL with --omit=optional).
interface QvacFinal {
  contentText: string;
  stopReason?: string;
  stats?: { tokensPerSecond?: number; generatedTokens?: number; backendDevice?: string };
}
interface QvacRun {
  requestId: string;
  events: AsyncIterable<{ type: string; text?: string }>;
  final: Promise<QvacFinal>;
}
interface QvacSdk {
  loadModel(o: Record<string, unknown>): Promise<string>;
  completion(o: Record<string, unknown>): QvacRun;
  cancel(o: { requestId: string }): Promise<void>;
  unloadModel(o: { modelId: string }): Promise<void>;
  close(): Promise<void>;
}

type Log = (msg: string) => void;

export class QvacEngine implements LlmEngine {
  private sdk?: QvacSdk;
  private modelId?: string;
  private model: string;
  private device: string;
  private loaded = false;
  private loading = false;
  private progress?: number;
  private error?: string;
  private readonly limiter: Limiter;

  constructor(private readonly cfg: AiConfig, private readonly log: Log) {
    this.model = cfg.models[0]!;
    this.device = cfg.device;
    this.limiter = new Limiter(cfg.parallel);
  }

  status(): EngineStatus {
    return {
      model: this.model, device: this.device, loaded: this.loaded, loading: this.loading,
      progress: this.progress, error: this.error, queued: this.limiter.queued,
    };
  }

  /** Loads the first model that works: AI_MODEL, then AI_FALLBACK_MODEL, then (if gpu) the last one on cpu. */
  async load(): Promise<void> {
    this.loading = true;
    try {
      const spec = '@qvac/sdk';
      this.sdk = (await import(spec)) as QvacSdk;
    } catch (e) {
      this.loading = false;
      this.error = `@qvac/sdk not installed: ${(e as Error).message}`;
      this.log(`ai: ${this.error}`);
      return;
    }
    const sdk = this.sdk;
    const attempts = this.cfg.models.map((model) => ({ model, device: this.cfg.device as string }));
    if (this.cfg.device === 'gpu') attempts.push({ model: this.cfg.models.at(-1)!, device: 'cpu' });

    for (const a of attempts) {
      const src = (sdk as unknown as Record<string, unknown>)[a.model];
      if (!src) {
        this.log(`ai: unknown model constant ${a.model}, skipping`);
        continue;
      }
      this.model = a.model;
      this.device = a.device;
      this.progress = 0;
      const t0 = Date.now();
      this.log(`ai: loading ${a.model} on ${a.device} (ctx ${this.cfg.ctxSize}, parallel ${this.cfg.parallel})...`);
      try {
        let lastLogged = -10;
        this.modelId = await sdk.loadModel({
          modelSrc: src,
          modelConfig: {
            ctx_size: this.cfg.ctxSize,
            device: a.device,
            parallel: this.cfg.parallel,
            reasoning_budget: this.cfg.reasoningBudget,
          },
          onProgress: (p: { percentage: number }) => {
            this.progress = Math.floor(p.percentage);
            if (this.progress >= lastLogged + 10) {
              lastLogged = this.progress;
              this.log(`ai: download ${this.progress}%`);
            }
          },
        });
        this.log(`ai: ${a.model} loaded on ${a.device} in ${Date.now() - t0} ms; warming up...`);
        const warm = await this.complete({
          messages: [{ role: 'user', content: 'Reply with the single word OK.' }],
          predict: 4,
          signal: AbortSignal.timeout(60_000),
        });
        this.log(`ai: warm-up done in ${warm.ms} ms; ready`);
        this.loaded = true;
        this.error = undefined;
        this.loading = false;
        return;
      } catch (e) {
        this.error = `load ${a.model} on ${a.device} failed: ${(e as Error).message}`;
        this.log(`ai: ${this.error}`);
        if (this.modelId) await sdk.unloadModel({ modelId: this.modelId }).catch(() => {});
        this.modelId = undefined;
      }
    }
    this.loading = false;
    this.log('ai: no model could be loaded; serving fallback parser and templates only');
  }

  generate(o: GenerateOptions): Promise<GenerateResult> {
    if (!this.loaded) return Promise.reject(new Error('model not loaded'));
    return this.limiter.run(o.priority ?? 0, o.signal, () => this.complete(o));
  }

  private async complete(o: GenerateOptions): Promise<GenerateResult> {
    const sdk = this.sdk;
    if (!sdk || !this.modelId) throw new Error('model not loaded');
    o.signal.throwIfAborted();
    const t0 = performance.now();
    const run = sdk.completion({
      modelId: this.modelId,
      history: o.messages,
      stream: true,
      captureThinking: true, // safety net: stray <think> text lands in thinkingDelta, never in content
      generationParams: { temp: 0, seed: 7, predict: o.predict, reasoning_budget: this.cfg.reasoningBudget },
      ...(o.jsonSchema
        ? { responseFormat: { type: 'json_schema', json_schema: { name: 'output', schema: o.jsonSchema } } }
        : {}),
    });
    const onAbort = () => void sdk.cancel({ requestId: run.requestId }).catch(() => {});
    o.signal.addEventListener('abort', onAbort, { once: true });
    try {
      let text = '';
      for await (const ev of run.events) {
        if (o.signal.aborted) break;
        if (ev.type === 'contentDelta' && ev.text) {
          // SDK 0.21.0 quirk: after the token deltas it emits one more delta with the whole content again
          // (and final.contentText is doubled). Skip that repeat.
          if (text.length > 0 && ev.text.trim() === text.trim()) continue;
          text += ev.text;
          o.onDelta?.(ev.text);
        }
      }
      o.signal.throwIfAborted();
      const final = await run.final;
      return {
        text,
        stopReason: final.stopReason,
        ms: Math.round(performance.now() - t0),
        tokensPerSecond: final.stats?.tokensPerSecond,
        generatedTokens: final.stats?.generatedTokens,
      };
    } finally {
      o.signal.removeEventListener('abort', onAbort);
    }
  }

  async shutdown(): Promise<void> {
    if (!this.sdk) return;
    if (this.modelId) await this.sdk.unloadModel({ modelId: this.modelId }).catch(() => {});
    await this.sdk.close().catch(() => {});
  }
}
