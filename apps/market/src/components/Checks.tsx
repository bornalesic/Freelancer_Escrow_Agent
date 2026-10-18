// Results of the automatic checks on one delivery, with the evidence the verifier recorded.
import { isAutomaticCondition, type Condition, type HintItem, type VerificationResult } from '@escrow/shared';
import { conditionInfo } from '../lib/format';
import { Pill, Spinner } from './ui';

function Evidence({ r }: { r: VerificationResult }) {
  const ev = r.evidence;
  const facts = [
    ev.exitCode !== undefined && `exit code ${ev.exitCode}`,
    ev.matched && (ev.matched.length ? `found ${ev.matched.join(', ')}` : 'no matching file'),
    ev.actualSha256 && `fingerprint ${ev.actualSha256.slice(0, 12)}…`,
    `${(ev.durationMs / 1000).toFixed(1)} s`,
  ].filter(Boolean);
  return (
    <div className="mt-1 space-y-1">
      <p className="text-xs text-slate-500">{facts.join(' · ')}</p>
      {ev.error && <p className="text-xs text-red-700">{ev.error}</p>}
      {ev.stdoutTail && (
        <details className="group">
          <summary className="cursor-pointer text-xs font-medium text-indigo-700">Output</summary>
          <pre className="mt-1 max-h-56 overflow-auto rounded-lg bg-slate-900 p-3 text-[11px] leading-relaxed text-slate-100">{ev.stdoutTail}</pre>
        </details>
      )}
    </div>
  );
}

/** `hints`: QVAC's fix hints for failed checks (practice runs only). */
export function Checks({ conditions, results, running, hints }: { conditions: readonly Condition[]; results: readonly VerificationResult[] | undefined; running: boolean; hints?: readonly HintItem[] | undefined }) {
  const automatic = conditions.filter(isAutomaticCondition);
  const byId = new Map((results ?? []).map((r) => [r.conditionId, r]));
  const hintFor = new Map((hints ?? []).map((h) => [h.conditionId, h]));
  return (
    <ul className="divide-y divide-slate-100 rounded-xl border border-slate-200">
      {automatic.map((c) => {
        const r = byId.get(c.id);
        return (
          <li key={c.id} className="flex items-start gap-3 px-4 py-3">
            <span className="mt-0.5 w-5 text-center" aria-hidden>
              {r ? (r.passed ? '✅' : '❌') : running ? <Spinner className="text-slate-400" /> : '·'}
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-sm text-slate-900">{c.description}</p>
              <p className="text-xs text-slate-500">{conditionInfo(c).label}</p>
              {r && <Evidence r={r} />}
              {r && !r.passed && hintFor.has(c.id) && (
                <p className="mt-1 rounded-lg bg-fuchsia-50 px-2 py-1 text-xs text-fuchsia-900">
                  <strong>QVAC:</strong> {hintFor.get(c.id)!.why} {hintFor.get(c.id)!.hint}
                </p>
              )}
            </div>
            {r ? <Pill tone={r.passed ? 'green' : 'orange'}>{r.passed ? 'Passed' : 'Failed'}</Pill> : <Pill>{running ? 'Checking' : 'Not run'}</Pill>}
          </li>
        );
      })}
    </ul>
  );
}
