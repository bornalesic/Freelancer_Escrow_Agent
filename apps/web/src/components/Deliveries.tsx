// Every delivery with the verifier's result per condition. Newest first.
import type { Delivery, Escrow } from '@escrow/shared';
import { ConditionCard } from './Terms';

function DeliveryCard({ escrow, delivery: d, latest }: { escrow: Escrow; delivery: Delivery; latest: boolean }) {
  const results = d.results ?? [];
  const passed = results.filter((r) => r.passed).length;
  const verdict = !d.results
    ? { text: 'Checking…', cls: 'bg-violet-100 text-violet-800' }
    : passed === escrow.conditions.length
      ? { text: 'All checks passed', cls: 'bg-emerald-100 text-emerald-800' }
      : { text: `${passed} of ${escrow.conditions.length} checks passed`, cls: 'bg-red-100 text-red-800' };

  return (
    <div className={`space-y-3 rounded-xl border p-4 ${latest ? 'border-slate-300 bg-white' : 'border-slate-200 bg-slate-50 opacity-80'}`}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold">
          Delivery {d.n} · <span className="font-mono text-sm">{d.fileName}</span>
          <span className="ml-2 text-sm font-normal text-slate-500">{new Date(d.at).toLocaleTimeString()}</span>
        </p>
        <span className={`rounded-full px-3 py-0.5 text-sm font-semibold ${verdict.cls}`}>{verdict.text}</span>
      </div>
      {escrow.conditions.map((c) => {
        const r = results.find((x) => x.conditionId === c.id);
        const ev = r?.evidence;
        return (
          <div key={c.id} className="space-y-1">
            <ConditionCard condition={c} status={r ? (r.passed ? 'pass' : 'fail') : undefined} />
            {ev?.error && <p className="pl-4 text-sm text-red-700">{ev.error}</p>}
            {ev?.actualSha256 && !r?.passed && (
              <p className="pl-4 font-mono text-xs text-slate-500">got sha256 {ev.actualSha256}</p>
            )}
            {ev?.stdoutTail && (
              <details className="pl-4" open={latest && r?.passed === false}>
                <summary className="cursor-pointer text-sm text-slate-500">
                  Output{ev.exitCode !== undefined ? ` · exit code ${ev.exitCode}` : ''} · {ev.durationMs} ms
                </summary>
                <pre className="mt-1 max-h-72 overflow-auto rounded-lg bg-slate-900 p-3 text-xs leading-relaxed text-slate-100">
                  {ev.stdoutTail}
                </pre>
              </details>
            )}
          </div>
        );
      })}
    </div>
  );
}

export function Deliveries({ escrow }: { escrow: Escrow }) {
  if (escrow.deliveries.length === 0) return null;
  const list = [...escrow.deliveries].sort((a, b) => b.n - a.n);
  return (
    <div className="space-y-3">
      {list.map((d, i) => (
        <DeliveryCard key={d.n} escrow={escrow} delivery={d} latest={i === 0} />
      ))}
    </div>
  );
}
