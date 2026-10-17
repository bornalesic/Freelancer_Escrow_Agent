// Client step 3: "Lock 50 USDT". Refund invoice first (so the agent can always send the money back),
// then pay the agent's funding invoice from the client's own wallet, then hint the agent with the txid.
import { useState } from 'react';
import { formatAmount, type Escrow } from '@escrow/shared';
import { agentApi, partyApi } from '../lib/api';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

type Step = 'idle' | 'refund-invoice' | 'paying' | 'sent';

// Remember a sent payment per tab, so a reload while waiting for confirmation can't pay twice.
const sentKey = (escrowId: string) => `escrow.web.funding-sent.${escrowId}`;
function readSent(escrowId: string): string | undefined {
  try {
    return sessionStorage.getItem(sentKey(escrowId)) ?? undefined;
  } catch {
    return undefined;
  }
}
function writeSent(escrowId: string, txid: string): void {
  try {
    sessionStorage.setItem(sentKey(escrowId), txid);
  } catch {
    // storage blocked: the agent's payment_seen event still hides the button
  }
}

const STEP_TEXT: Record<Step, string> = {
  idle: '',
  'refund-invoice': 'Preparing a refund address in your wallet…',
  paying: 'Sending from your wallet…',
  sent: 'Sent. Waiting for Bitcoin to confirm…',
};

export function FundingPanel({ escrow, paymentSeen }: { escrow: Escrow; paymentSeen: boolean }) {
  const [txid, setTxid] = useState(() => readSent(escrow.id));
  const [step, setStep] = useState<Step>(txid || paymentSeen ? 'sent' : 'idle');
  const shownStep: Step = paymentSeen ? 'sent' : step;
  const display = `${formatAmount(escrow.amount, escrow.precision)} ${escrow.assetTicker}`;

  const lock = useAction(async () => {
    try {
      if (!escrow.fundingInvoice) throw new Error('The agent has not created its funding invoice yet.');
      if (!escrow.refundInvoice) {
        setStep('refund-invoice');
        const { invoice } = await partyApi.invoice(escrow.assetId, escrow.amount);
        await agentApi.refundInvoice(escrow.id, invoice);
      }
      setStep('paying');
      const paid = await partyApi.pay(escrow.fundingInvoice, escrow.assetId, escrow.amount);
      writeSent(escrow.id, paid.txid);
      setTxid(paid.txid);
      setStep('sent');
      await agentApi.funded(escrow.id, paid.txid).catch(() => {}); // only a hint; the agent watches its wallet anyway
    } catch (err) {
      setStep('idle');
      throw err;
    }
  });

  if (escrow.state === 'AGREED') {
    return <p className="text-slate-600">Both sides agreed. The agent is preparing its wallet to receive {display}…</p>;
  }
  if (escrow.state !== 'AWAITING_FUNDS') return null;

  return (
    <div className="space-y-3 rounded-xl border border-teal-200 bg-teal-50 p-5">
      <p className="text-slate-700">
        Lock the money with the escrow agent. It can only go to the freelancer when every check passes, or back to you
        after the deadline.
      </p>
      {shownStep === 'idle' ? (
        <button
          type="button"
          onClick={() => void lock.run()}
          disabled={lock.busy || !escrow.fundingInvoice}
          className="rounded-lg bg-teal-700 px-6 py-3 text-lg font-semibold text-white hover:bg-teal-600 disabled:opacity-50"
        >
          Lock {display}
        </button>
      ) : (
        <p className="flex items-center gap-2 font-medium text-teal-900">
          <span className="h-3 w-3 animate-pulse rounded-full bg-teal-600" />
          {STEP_TEXT[shownStep]}
        </p>
      )}
      {txid && <p className="font-mono text-xs text-slate-500">txid {txid}</p>}
      {lock.error && <ErrorBanner>Could not lock the money: {lock.error}</ErrorBanner>}
    </div>
  );
}
