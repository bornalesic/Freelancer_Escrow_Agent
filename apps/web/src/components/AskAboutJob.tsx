// Freelancer: ask about the job; QVAC answers only from the terms and quotes them. If the terms don't say,
// the question is for the client (an answer that changes the terms means editing the agreement: new terms).
import { useState, type FormEvent } from 'react';
import type { AnswerResult, Escrow } from '@escrow/shared';
import { assist, isUnavailable } from '../lib/assist';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

interface Entry {
  question: string;
  result?: AnswerResult;
  unavailable?: string;
}

export function AskAboutJob({ escrow }: { escrow: Escrow }) {
  const [question, setQuestion] = useState('');
  const [entries, setEntries] = useState<Entry[]>([]);

  const ask = useAction(async () => {
    const q = question.trim();
    if (q.length < 3) return;
    try {
      const result = await assist('answer', {
        title: escrow.title, rawText: escrow.rawText, conditions: escrow.conditions, clarifications: escrow.clarifications ?? [], question: q,
      });
      setEntries((list) => [...list, { question: q, result }]);
      setQuestion('');
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      setEntries((list) => [...list, { question: q, unavailable: err.message }]);
    }
  });

  const submit = (e: FormEvent) => {
    e.preventDefault();
    void ask.run();
  };

  return (
    <div className="space-y-3 rounded-xl border border-slate-200 bg-slate-50 p-4">
      <h3 className="font-semibold text-slate-800">Questions about this job</h3>
      {entries.map((e, i) => (
        <div key={i} className="space-y-1.5">
          <p className="font-medium text-slate-900">“{e.question}”</p>
          {e.result?.answered ? (
            <div className="rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm">
              <p className="text-slate-800">
                <span className="mr-2 rounded-full bg-violet-600 px-2 py-0.5 text-xs font-semibold text-white">QVAC · from the terms</span>
                {e.result.answer}
              </p>
              {e.result.quote && <blockquote className="mt-1.5 border-l-4 border-violet-200 pl-3 text-slate-600">{e.result.quote}</blockquote>}
            </div>
          ) : (
            <p className="rounded-lg border border-amber-200 bg-amber-50 px-3 py-2 text-sm text-amber-900">
              {e.unavailable
                ? `QVAC can't answer right now (${e.unavailable.replace(/\.$/, '')}). Ask the client.`
                : "The terms don't say this. Ask the client before you accept; if their answer matters, they add it to the agreement and you both accept the new terms."}
            </p>
          )}
        </div>
      ))}
      <form onSubmit={submit} className="flex flex-wrap gap-2">
        <input
          className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-2 focus:border-slate-900 focus:outline-none focus:ring-1 focus:ring-slate-900"
          placeholder="e.g. Do I need to include a README?"
          value={question}
          onChange={(e) => setQuestion(e.target.value)}
          maxLength={500}
        />
        <button
          type="submit"
          disabled={ask.busy || question.trim().length < 3}
          className="rounded-lg bg-slate-900 px-4 py-2 font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
        >
          {ask.busy ? 'Asking…' : 'Ask QVAC'}
        </button>
      </form>
      {ask.error && <ErrorBanner>{ask.error}</ErrorBanner>}
    </div>
  );
}
