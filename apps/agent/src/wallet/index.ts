import type { EscrowWallet } from '@escrow/shared';
import type { Config } from '../config';
import { log } from '../log';
import { errorMessage, withTimeout } from '../util';
import { StubWallet } from './stub';

/** Per-call timeouts. rgb-lib calls can be slow (refresh talks to indexer + proxy). */
const TIMEOUTS: Record<keyof EscrowWallet, number> = {
  init: 180_000, // may create UTXOs
  info: 20_000,
  balance: 20_000,
  listAssets: 20_000,
  createInvoice: 30_000,
  pay: 90_000,
  refresh: 60_000,
  transfers: 20_000,
  waitForTransfer: 600_000, // has its own timeoutMs; this is a backstop
  sign: 20_000,
};

/** Wrap every wallet method with a timeout, so nothing in the demo path can hang forever. */
function timed(w: EscrowWallet): EscrowWallet {
  return new Proxy(w, {
    get(target, prop, receiver) {
      const v = Reflect.get(target, prop, receiver);
      if (typeof v !== 'function' || !(prop in TIMEOUTS)) return v;
      return (...args: unknown[]) =>
        withTimeout(v.apply(target, args), TIMEOUTS[prop as keyof EscrowWallet], `wallet.${String(prop)}`);
    },
  });
}

type WalletModule = { createWallet: (opts: { role: 'agent'; mode: 'mock' | 'real' }) => EscrowWallet | Promise<EscrowWallet> };

/**
 * Load WS1's `@escrow/wallet` if it is installed (real RgbWdkWallet or shared-ledger MockWallet).
 * Until then, WALLET_MODE=mock falls back to the in-process StubWallet.
 */
async function loadWalletModule(): Promise<WalletModule | undefined> {
  const name = '@escrow/wallet'; // variable, so typecheck passes before WS1's package exists
  try {
    const mod = (await import(name)) as Partial<WalletModule>;
    return typeof mod.createWallet === 'function' ? (mod as WalletModule) : undefined;
  } catch (err) {
    log.warn(`@escrow/wallet not available (${errorMessage(err)})`);
    return undefined;
  }
}

export class WalletHolder {
  wallet!: EscrowWallet;
  ready = false;
  error?: string;
  private initializing?: Promise<void>;
  private lastAttempt = 0;

  constructor(private config: Config) {}

  /** Create the wallet object. `override` lets tests inject a wallet. */
  async create(override?: EscrowWallet): Promise<void> {
    if (override) {
      this.wallet = timed(override);
      return;
    }
    const mod = await loadWalletModule();
    if (mod) {
      this.wallet = timed(await mod.createWallet({ role: 'agent', mode: this.config.walletMode }));
      log.info(`agent wallet: @escrow/wallet (${this.config.walletMode})`);
    } else if (this.config.walletMode === 'mock') {
      this.wallet = timed(new StubWallet(this.config.network, this.config.mockSettleMs));
      log.warn('agent wallet: in-process StubWallet (fund via POST /escrows/:id/funded)');
    } else {
      throw new Error('WALLET_MODE=real needs @escrow/wallet (packages/wallet, WS1)');
    }
  }

  /** The stub, if that is what we run on (enables simulated funding). */
  get stub(): StubWallet | undefined {
    const w = this.wallet as unknown as { isStub?: boolean };
    return w?.isStub ? (this.wallet as unknown as StubWallet) : undefined;
  }

  /** init() with retry: called at startup and by the ticker until it succeeds. */
  init(): Promise<void> {
    if (this.ready) return Promise.resolve();
    if (this.initializing) return this.initializing;
    if (Date.now() - this.lastAttempt < 15_000 && this.lastAttempt) return Promise.resolve();
    this.lastAttempt = Date.now();
    this.initializing = this.wallet
      .init()
      .then(() => {
        this.ready = true;
        this.error = undefined;
        log.info('agent wallet ready');
      })
      .catch((err) => {
        this.error = `Agent wallet failed to start: ${errorMessage(err)}`;
        log.error(this.error);
      })
      .finally(() => {
        this.initializing = undefined;
      });
    return this.initializing;
  }
}
