// The delivered versions of a job: automatic check results with evidence, QVAC's advisory review of
// what only the client can judge, file previews, and the client's answer.
import type { Delivery, Escrow } from '@escrow/shared';
import { relativeTime } from '../lib/format';
import { useNow } from '../lib/hooks';
import { AiReview } from './AiReview';
import { Checks } from './Checks';
import { Previews } from './Previews';
import { Pill } from './ui';

export type Viewer = 'client' | 'freelancer' | 'service';

function summary(d: Delivery) {
  const results = d.results ?? [];
  const passed = results.filter((r) => r.passed).length;
  return results.length ? `${passed} of ${results.length} checks passed` : 'not checked yet';
}

function Answer({ d }: { d: Delivery }) {
  if (!d.approval) return null;
  return d.approval.decision === 'approve' ? (
    <p className="text-sm font-medium text-emerald-700">The client approved this version.</p>
  ) : (
    <div className="rounded-xl bg-orange-50 px-4 py-3 text-sm text-orange-900 ring-1 ring-inset ring-orange-200">
      <p className="font-semibold">The client disputed this version</p>
      {d.approval.reason && <p className="mt-1">“{d.approval.reason}”</p>}
    </div>
  );
}

export function Work({ escrow, token, viewer }: { escrow: Escrow; token: string | undefined; viewer: Viewer }) {
  const now = useNow(30_000);
  const latest = escrow.deliveries.at(-1);
  if (!latest) return <p className="text-sm text-slate-500">Nothing delivered yet.</p>;
  const earlier = escrow.deliveries.slice(0, -1).reverse();
  const checking = escrow.state === 'DELIVERED' || escrow.state === 'VERIFYING';
  const reviewed = latest.results !== undefined && !checking;
  const downloads = viewer === 'freelancer' || (viewer === 'client' && escrow.state === 'RELEASED');

  return (
    <div className="space-y-5">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <p className="font-semibold text-slate-900">
          Version {latest.n} <span className="font-normal text-slate-500">· {latest.fileName} · {relativeTime(latest.at, now)}</span>
        </p>
        <Pill tone={checking ? 'violet' : latest.results?.every((r) => r.passed) ? 'green' : 'orange'}>{checking ? 'Checking…' : summary(latest)}</Pill>
      </div>
      <Checks conditions={escrow.conditions} results={latest.results} running={checking} />
      {reviewed && latest.results?.every((r) => r.passed) && <AiReview conditions={escrow.conditions} delivery={latest} />}
      <Answer d={latest} />
      {viewer !== 'freelancer' || token ? (
        <div>
          <p className="mb-2 text-sm font-semibold text-slate-900">Delivered files</p>
          <Previews escrowId={escrow.id} n={latest.n} state={escrow.state} token={token} downloads={downloads} />
        </div>
      ) : null}

      {earlier.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Earlier versions</p>
          {earlier.map((d) => (
            <details key={d.n} className="rounded-xl border border-slate-200 px-4 py-2">
              <summary className="cursor-pointer text-sm text-slate-700">
                Version {d.n} · {d.fileName} · {summary(d)}
                {d.approval?.decision === 'dispute' && ' · disputed'}
              </summary>
              <div className="mt-3 space-y-3 pb-2">
                <Checks conditions={escrow.conditions} results={d.results} running={false} />
                <Answer d={d} />
              </div>
            </details>
          ))}
        </div>
      )}
    </div>
  );
}
