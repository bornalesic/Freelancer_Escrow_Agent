// Client, before both sides agree: change the plain-language text and let QVAC read it again.
// The agent clears the proposed terms and every acceptance, so both parties accept the new terms.
import { useState } from 'react';
import type { Escrow } from '@escrow/shared';
import { agentApi } from '../lib/api';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

export function EditAgreement({ escrow, startOpen = false }: { escrow: Escrow; startOpen?: boolean }) {
  const [open, setOpen] = useState(startOpen);
  const [text, setText] = useState(escrow.rawText);
  const reparse = useAction(async () => {
    const rawText = text.trim();
    await agentApi.reparse(escrow.id, rawText === escrow.rawText ? undefined : rawText);
    setOpen(false);
  });

  if (!open) {
    return (
      <button type="button" onClick={() => setOpen(true)} className="rounded-lg border border-slate-300 px-4 py-2 font-medium hover:bg-slate-100">
        Edit agreement
      </button>
    );
  }

  return (
    <form
      className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4"
      onSubmit={(e) => {
        e.preventDefault();
        if (text.trim()) void reparse.run();
      }}
    >
      <label className="block space-y-1">
        <span className="font-medium text-slate-800">The agreement, in plain language</span>
        <textarea
          className="min-h-32 w-full rounded-lg border border-slate-300 bg-white px-3 py-2 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          value={text}
          onChange={(e) => setText(e.target.value)}
          maxLength={10_000}
          required
        />
      </label>
      <p className="text-sm text-slate-500">
        QVAC reads it again and proposes new checks.
        {escrow.acceptances.length > 0 && ' Acceptances so far are cleared: both of you accept the new terms.'}
      </p>
      <div className="flex flex-wrap gap-3">
        <button
          type="submit"
          disabled={reparse.busy || !text.trim()}
          className="rounded-lg bg-slate-900 px-5 py-2.5 font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {reparse.busy ? 'Sending…' : 'Read it again'}
        </button>
        <button
          type="button"
          onClick={() => {
            setText(escrow.rawText);
            setOpen(false);
          }}
          className="rounded-lg px-4 py-2.5 font-medium text-slate-600 hover:bg-white"
        >
          Cancel
        </button>
      </div>
      {reparse.error && <ErrorBanner>{reparse.error}</ErrorBanner>}
    </form>
  );
}
