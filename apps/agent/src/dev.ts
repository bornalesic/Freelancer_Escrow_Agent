import type { Config } from './config';
import { log } from './log';
import { HttpError, errorMessage } from './util';

/** bitcoind's own wallet in the regtest stack, the one `npm run demo:setup` funds everyone from. */
const MINER = 'miner';

/**
 * Regtest helpers: mine blocks via bitcoind JSON-RPC to bitcoind's `miner` wallet. Never to an RGB wallet:
 * a coinbase needs 100 confirmations, but rgb-lib picks it anyway when it next creates UTXOs, bitcoind
 * rejects that ("premature spend of coinbase") and the agent wallet cannot start. Same rule as
 * scripts/demo-lib.ts.
 */
export class Dev {
  private fakeHeight = 0;
  private lastAutoMine = 0;
  private minerAddress?: string;

  constructor(private config: Config) {}

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
    this.minerAddress ??= await this.newMinerAddress();
    await this.rpc('generatetoaddress', [blocks, this.minerAddress]);
    return { height: (await this.rpc('getblockcount', [])) as number };
  }

  /** The `miner` wallet survives a container restart but is not loaded again: load it, or create it once. */
  private async newMinerAddress(): Promise<string> {
    if (!((await this.rpc('listwallets', [])) as string[]).includes(MINER)) {
      const onDisk = ((await this.rpc('listwalletdir', [])) as { wallets: { name: string }[] }).wallets.map((w) => w.name);
      await this.rpc(onDisk.includes(MINER) ? 'loadwallet' : 'createwallet', [MINER]);
    }
    return (await this.rpc('getnewaddress', [], MINER)) as string;
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

  private async rpc(method: string, params: unknown[], wallet?: string): Promise<unknown> {
    const { url, user, pass } = this.config.bitcoind;
    if (!url) throw new HttpError(500, 'BITCOIND_RPC_URL is not set');
    const res = await fetch(wallet ? `${url.replace(/\/$/, '')}/wallet/${wallet}` : url, {
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
