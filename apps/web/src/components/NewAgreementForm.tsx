// Client step 1: the job in plain language, the amount and a deadline.
import { useState, type FormEvent } from 'react';
import { toBaseUnits, type Escrow } from '@escrow/shared';
import { agentApi } from '../lib/api';
import { useAgentConfig } from '../lib/agentConfig';
import { saveClientToken } from '../lib/clientToken';
import { DEMO_AGREEMENT, REVIEW_AGREEMENT } from '../lib/demo';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

const input =
  'w-full rounded-lg border border-slate-300 bg-white px-3 py-2 text-slate-900 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900';

export function NewAgreementForm({ onCreated }: { onCreated: (escrow: Escrow) => void }) {
  const asset = useAgentConfig();
  const [title, setTitle] = useState('');
  const [rawText, setRawText] = useState('');
  const [amount, setAmount] = useState('');
  const [minutes, setMinutes] = useState('30');

  const create = useAction(async () => {
    if (!asset) throw new Error('Still loading the asset settings from the agent.');
    const mins = Number(minutes);
    if (!Number.isFinite(mins) || mins <= 0) throw new Error('Deadline must be a positive number of minutes.');
    const { clientToken, ...escrow } = await agentApi.createEscrow({
      title: title.trim(),
      rawText: rawText.trim(),
      amount: toBaseUnits(amount, asset.precision),
      deadline: new Date(Date.now() + mins * 60_000).toISOString(),
    });
    if (clientToken) saveClientToken(escrow.id, clientToken); // returned only here, needed to approve
    onCreated(escrow);
  });

  const paste = (a: typeof DEMO_AGREEMENT) => {
    setTitle(a.title);
    setRawText(a.rawText);
    setAmount(a.amount);
    setMinutes(String(a.deadlineMinutes));
  };

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void create.run();
  };

  return (
    <form onSubmit={submit} className="space-y-4">
      <div className="flex items-center justify-between gap-3">
        <h1 className="text-2xl font-bold">New agreement</h1>
        <div className="flex flex-wrap gap-2">
          <button type="button" onClick={() => paste(DEMO_AGREEMENT)} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100">
            Paste demo agreement
          </button>
          <button type="button" onClick={() => paste(REVIEW_AGREEMENT)} className="rounded-lg border border-slate-200 px-3 py-1.5 text-sm text-slate-500 hover:bg-slate-100">
            Paste review demo
          </button>
        </div>
      </div>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">Job title</span>
        <input className={input} value={title} onChange={(e) => setTitle(e.target.value)} required maxLength={120} />
      </label>
      <label className="block space-y-1">
        <span className="text-sm font-medium text-slate-700">What should be delivered? Write it in plain language.</span>
        <textarea className={`${input} min-h-40`} value={rawText} onChange={(e) => setRawText(e.target.value)} required />
      </label>
      <div className="grid gap-4 sm:grid-cols-2">
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Amount ({asset?.assetTicker ?? 'USDT'})</span>
          <input className={input} value={amount} onChange={(e) => setAmount(e.target.value)} inputMode="decimal" pattern="\d+(\.\d+)?" required />
        </label>
        <label className="block space-y-1">
          <span className="text-sm font-medium text-slate-700">Deadline (minutes from now)</span>
          <input className={input} value={minutes} onChange={(e) => setMinutes(e.target.value)} inputMode="numeric" pattern="\d+" required />
        </label>
      </div>
      {create.error && <ErrorBanner>{create.error}</ErrorBanner>}
      <button
        type="submit"
        disabled={create.busy || !asset}
        className="rounded-lg bg-slate-900 px-6 py-3 text-lg font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {create.busy ? 'Sending…' : 'Turn into checks'}
      </button>
      <p className="text-sm text-slate-500">A local AI (QVAC) proposes checks. Nothing moves until both of you accept them.</p>
    </form>
  );
}
