// Freelancer step 2: drop the work, get a fresh payout invoice from the own wallet, send both to the agent.
import { useRef, useState, type DragEvent } from 'react';
import type { Escrow } from '@escrow/shared';
import { agentApi, partyApi } from '../lib/api';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

export function UploadPanel({ escrow }: { escrow: Escrow }) {
  const [file, setFile] = useState<File>();
  const [dragging, setDragging] = useState(false);
  const [step, setStep] = useState<string>();
  const inputRef = useRef<HTMLInputElement>(null);

  const submit = useAction(async () => {
    if (!file) return;
    try {
      // Invoices are single-use: a new one for every delivery.
      setStep('Creating a payout invoice in your wallet…');
      const { invoice } = await partyApi.invoice(escrow.assetId, escrow.amount);
      setStep('Uploading…');
      await agentApi.deliver(escrow.id, file, invoice);
      setFile(undefined);
    } finally {
      setStep(undefined);
    }
  });

  const onDrop = (e: DragEvent) => {
    e.preventDefault();
    setDragging(false);
    const f = e.dataTransfer.files[0];
    if (f) setFile(f);
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
            setFile(e.target.files?.[0]);
            e.target.value = '';
          }}
        />
      </div>
      <div className="flex items-center gap-3">
        <button
          type="button"
          onClick={() => void submit.run()}
          disabled={!file || submit.busy}
          className="rounded-lg bg-slate-900 px-6 py-3 text-lg font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {submit.busy ? 'Submitting…' : 'Submit for checking'}
        </button>
        {step && <span className="text-slate-600">{step}</span>}
      </div>
      {submit.error && <ErrorBanner>Could not submit: {submit.error}</ErrorBanner>}
    </div>
  );
}
