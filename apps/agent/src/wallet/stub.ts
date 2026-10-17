import { randomBytes } from 'node:crypto';
import type { AssetBalance, EscrowWallet, TransferSummary, WalletInfo } from '@escrow/shared';

/**
 * In-process stand-in for the agent wallet, used only when WALLET_MODE=mock and WS1's
 * `@escrow/wallet` is not installed. It cannot see payments made by other processes, so funding is
 * simulated: `POST /escrows/:id/funded` calls `simulateIncoming()`. Transfers settle after `settleMs`.
 */
export class StubWallet implements EscrowWallet {
  readonly isStub = true;
  private transfersList: (TransferSummary & { settleAt: number })[] = [];
  private invoices = new Map<string, { assetId: string; amount: string }>();

  constructor(private network: string, private settleMs: number) {}

  async init(): Promise<void> {}

  async info(): Promise<WalletInfo> {
    return { role: 'agent', network: this.network, address: 'bcrt1qstubagentwallet', btcBalanceSat: '100000000' };
  }

  async balance(assetId: string): Promise<AssetBalance> {
    this.tick();
    let settled = 0n;
    let future = 0n;
    for (const t of this.transfersList) {
      if (t.assetId !== assetId || t.status === 'failed') continue;
      const v = BigInt(t.amount) * (t.direction === 'incoming' ? 1n : -1n);
      future += v;
      if (t.status === 'settled' || t.direction === 'outgoing') settled += v;
    }
    const s = settled.toString();
    return { assetId, settled: s, future: future.toString(), spendable: s };
  }

  async listAssets(): Promise<AssetBalance[]> {
    const ids = new Set(this.transfersList.map((t) => t.assetId));
    return Promise.all([...ids].map((id) => this.balance(id)));
  }

  async createInvoice(p: { assetId: string; amount: string }) {
    const recipientId = `stub-${randomBytes(6).toString('hex')}`;
    this.invoices.set(recipientId, p);
    return { invoice: `mock:${recipientId}:${p.assetId}:${p.amount}`, recipientId };
  }

  async pay(p: { invoice: string; assetId: string; amount: string }) {
    const txid = randomBytes(32).toString('hex');
    this.transfersList.push({
      id: txid.slice(0, 12), direction: 'outgoing', assetId: p.assetId, amount: p.amount,
      status: 'pending', rawStatus: 'WaitingCounterparty', txid, settleAt: Date.now() + this.settleMs,
    });
    return { txid };
  }

  /** Pretend the client paid one of our invoices. */
  simulateIncoming(recipientId: string, txid?: string): boolean {
    const inv = this.invoices.get(recipientId);
    if (!inv || this.transfersList.some((t) => t.recipientId === recipientId)) return false;
    const id = txid ?? randomBytes(32).toString('hex');
    this.transfersList.push({
      id: id.slice(0, 12), direction: 'incoming', assetId: inv.assetId, amount: inv.amount,
      status: 'pending', rawStatus: 'WaitingConfirmations', txid: id, recipientId, settleAt: Date.now() + this.settleMs,
    });
    return true;
  }

  async refresh(): Promise<void> {
    this.tick();
  }

  async transfers(assetId: string): Promise<TransferSummary[]> {
    this.tick();
    return this.transfersList.filter((t) => t.assetId === assetId).map(({ settleAt: _, ...t }) => ({ ...t }));
  }

  async waitForTransfer(p: { assetId: string; recipientId?: string; txid?: string; timeoutMs: number }) {
    const end = Date.now() + p.timeoutMs;
    for (;;) {
      const t = (await this.transfers(p.assetId)).find(
        (t) => (p.recipientId && t.recipientId === p.recipientId) || (p.txid && t.txid === p.txid),
      );
      if (t && t.status !== 'pending') return t;
      if (Date.now() > end) throw new Error('waitForTransfer timed out');
      await new Promise((r) => setTimeout(r, 100));
    }
  }

  private tick(): void {
    const now = Date.now();
    for (const t of this.transfersList) {
      if (t.status === 'pending' && now >= t.settleAt) {
        t.status = 'settled';
        t.rawStatus = 'Settled';
      }
    }
  }
}
