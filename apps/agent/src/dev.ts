import type { Config } from './config';
import { log } from './log';
import { HttpError, errorMessage } from './util';
import type { WalletHolder } from './wallet';

/** Regtest helpers: mine blocks via bitcoind JSON-RPC to the agent wallet's address. */
export class Dev {
  private fakeHeight = 0;
  private lastAutoMine = 0;
  private address?: string;

  constructor(private config: Config, private wallets: WalletHolder) {}

  /** Auto-mine only makes sense with real wallets on regtest. */
  get autoMineEnabled(): boolean {
    return this.config.autoMine && this.config.walletMode === 'real' && this.config.network === 'regtest';
  }

  async mine(blocks = 1): Promise<{ height: number }> {
    if (this.config.walletMode === 'mock') {
      this.fakeHeight += blocks;
      return { height: this.fakeHeight };
    }
    if (this.config.network !== 'regtest') throw new HttpError(400, 'Mining is only possible on regtest');
    this.address ??= (await this.wallets.wallet.info()).address;
    await this.rpc('generatetoaddress', [blocks, this.address]);
    return { height: (await this.rpc('getblockcount', [])) as number };
  }

  /** Mine one block while a transfer is pending, at most every 3 s. Never throws. */
  async autoMine(): Promise<void> {
    if (!this.autoMineEnabled || Date.now() - this.lastAutoMine < 3000) return;
    this.lastAutoMine = Date.now();
    try {
      const { height } = await this.mine(1);
      log.info(`auto-mined a block (height ${height})`);
    } catch (err) {
      log.warn(`auto-mine failed: ${errorMessage(err)}`);
    }
  }

  private async rpc(method: string, params: unknown[]): Promise<unknown> {
    const { url, user, pass } = this.config.bitcoind;
    if (!url) throw new HttpError(500, 'BITCOIND_RPC_URL is not set');
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        ...(user ? { authorization: `Basic ${Buffer.from(`${user}:${pass ?? ''}`).toString('base64')}` } : {}),
      },
      body: JSON.stringify({ jsonrpc: '1.0', id: 'agent', method, params }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { result?: unknown; error?: { message?: string } | null };
    if (!res.ok || body.error) throw new HttpError(502, `bitcoind ${method} failed: ${body.error?.message ?? `HTTP ${res.status}`}`);
    return body.result;
  }
}
