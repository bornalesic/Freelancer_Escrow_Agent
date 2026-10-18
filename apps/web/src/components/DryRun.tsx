// Freelancer: the result of a practice check (the agent's verifier on an upload that is NOT submitted),
// with QVAC's explanation of each failure and a hint where to look. Advice only.
import type { DryRunResponse, Escrow } from '@escrow/shared';
import { isClientReview } from '../lib/terms';
import { ConditionCard } from './Terms';

export function DryRunResult({ escrow, result, fileName }: { escrow: Escrow; result: DryRunResponse; fileName: string }) {
  const all = result.passed === result.total;
  const review = escrow.conditions.some(isClientReview);
  return (
    <div className={`space-y-3 rounded-xl border p-4 ${all ? 'border-emerald-200 bg-emerald-50' : 'border-amber-200 bg-amber-50'}`}>
      <p className={`font-semibold ${all ? 'text-emerald-900' : 'text-amber-900'}`}>
        Practice check of <span className="font-mono text-sm">{fileName}</span>: {result.passed} of {result.total} passed.{' '}
        <span className="font-normal">
          {all
            ? `Nothing was submitted yet${review ? '; after you submit, the client still reviews their items' : ''}.`
            : 'Nothing was submitted. Fix it and check again.'}
        </span>
      </p>
      {escrow.conditions.filter((c) => !isClientReview(c)).map((c) => {
        const r = result.results.find((x) => x.conditionId === c.id);
        const hint = result.hints?.items.find((h) => h.conditionId === c.id);
        return (
          <div key={c.id} className="space-y-1">
            <ConditionCard condition={c} status={r ? (r.passed ? 'pass' : 'fail') : undefined} />
            {hint ? (
              <div className="ml-4 space-y-1 rounded-lg border border-violet-200 bg-white px-3 py-2 text-sm">
                <p className="flex flex-wrap items-center gap-2">
                  <span className="rounded-full bg-violet-600 px-2 py-0.5 text-xs font-semibold text-white" title={result.hints?.model}>
                    {result.hints?.source === 'ai' ? 'QVAC hint · advice only' : 'Hint'}
                  </span>
                  <span className="text-slate-800">{hint.why}</span>
                </p>
                <p className="text-slate-700">{hint.hint}</p>
              </div>
            ) : (
              r?.evidence.error && <p className="pl-4 text-sm text-red-700">{r.evidence.error}</p>
            )}
            {r && !r.passed && r.evidence.stdoutTail && (
              <details className="pl-4">
                <summary className="cursor-pointer text-sm text-slate-500">Output</summary>
                <pre className="mt-1 max-h-60 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">{r.evidence.stdoutTail}</pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}
