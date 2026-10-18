// Freelancer step 2: drop the work, optionally run a practice check (verifier + QVAC hints, nothing submitted),
// then get a fresh payout invoice from the own wallet and send both to the agent.
import { useRef, useState, type DragEvent } from 'react';
import type { DryRunResponse, Escrow } from '@escrow/shared';
import { agentApi, partyApi } from '../lib/api';
import { dryRun, isUnavailable } from '../lib/assist';
import { useAction } from '../lib/hooks';
import { DryRunResult } from './DryRun';
import { ErrorBanner } from './ui';

export function UploadPanel({ escrow }: { escrow: Escrow }) {
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<string>();
  const [practice, setPractice] = useState<{ file: File; result: DryRunResponse }>();
  const [practiceOff, setPracticeOff] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const choose = (f?: File) => {
    setFile(f);
    setPractice(undefined); // a result belongs to the file it checked
  };

  const submit = useAction(async () => {
    if (!file) return;
    try {
      // Invoices are single-use: a new one for every delivery.
      setStep('Creating a payout invoice in your wallet…');
      const { invoice } = await partyApi.invoice(escrow.assetId, escrow.amount);
      setStep('Uploading…');
      await agentApi.deliver(escrow.id, file, invoice);
      choose(undefined);
    } finally {
      setStep(undefined);
    }
  });

  const check = useAction(async () => {
    if (!file) return;
    setPractice(undefined);
    try {
      setPractice({ file, result: await dryRun(escrow.id, file) });
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      setPracticeOff(err.message);
    }
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) choose(f);
  };

  return (
    <div className="space-y-3">
      <div
        role="button"
        tabIndex={0}
        onClick={() => inputRef.current?.click()}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && inputRef.current?.click()}
        onDragOver={(e) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => setDragging(false)}
        onDrop={onDrop}
        className={`flex cursor-pointer flex-col items-center justify-center gap-1 rounded-xl border-2 border-dashed px-6 py-10 text-center transition ${
          dragging ? 'border-teal-500 bg-teal-50' : 'border-slate-300 bg-white hover:bg-slate-50'
        }`}
      >
        <span className="text-lg font-semibold">{file ? file.name : 'Drop your work here'}</span>
        <span className="text-sm text-slate-500">
          {file ? `${(file.size / 1024).toFixed(1)} KB · click to choose another file` : 'a .zip of the project, or a single file · or click to choose'}
        </span>
        <input
          ref={inputRef}
          type="file"
          className="hidden"
          onChange={(e) => {
            choose(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <div className="flex flex-wrap items-center gap-3">
        {!practiceOff && (
          <button
            type="button"
            onClick={() => void check.run()}
            disabled={!file || check.busy || submit.busy}
            className="rounded-lg border border-violet-300 bg-white px-5 py-3 text-lg font-semibold text-violet-800 hover:bg-violet-50 disabled:opacity-50"
            title="Runs the same checks as a real delivery, without submitting. QVAC explains any failure."
          >
            {check.busy ? 'Checking…' : 'Check without submitting'}
          </button>
        )}
        <button
          type="button"
          onClick={() => void submit.run()}
          disabled={!file || submit.busy || check.busy}
          className="rounded-lg bg-slate-900 px-6 py-3 text-lg font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submit.busy ? 'Submitting…' : 'Submit for checking'}
        </button>
        {step && <span className="text-slate-600">{step}</span>}
        {check.busy && <span className="text-slate-600">Running the checks, then asking QVAC about any failure…</span>}
      </div>
      {practiceOff && <p className="text-sm text-slate-500">Practice check: {practiceOff}</p>}
      {practice && <DryRunResult escrow={escrow} result={practice.result} fileName={practice.file.name} />}
      {check.error && <ErrorBanner>Practice check failed: {check.error}</ErrorBanner>}
      {submit.error && <ErrorBanner>Could not submit: {submit.error}</ErrorBanner>}
    </div>
  );
}
