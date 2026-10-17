// The proposed terms as both parties see them, and the Accept button.
import type { Condition, Escrow } from '@escrow/shared';
import { agentApi, partyApi } from '../lib/api';
import { useAction } from '../lib/hooks';
import { ErrorBanner } from './ui';

const KIND_TITLE: Record<Condition['kind'], string> = {
  tests_pass: 'Tests pass',
  file_present: 'File included',
  file_hash: 'File matches exactly',
};

export function conditionDetail(c: Condition): string {
  switch (c.kind) {
    case 'tests_pass':
      return c.command;
    case 'file_present':
      return c.pathPattern;
    case 'file_hash':
      return `${c.fileName ?? 'whole upload'} · sha256 ${c.sha256.slice(0, 12)}…`;
  }
}

export const shortHash = (h?: string) => (h ? `${h.slice(0, 4)}…` : '–');

export function ConditionCard({ condition: c, status }: { condition: Condition; status?: 'pass' | 'fail' }) {
  const icon = status === 'pass' ? '✓' : status === 'fail' ? '✗' : '☐';
  const tone =
    status === 'pass'
      ? 'border-emerald-200 bg-emerald-50'
      : status === 'fail'
        ? 'border-red-200 bg-red-50'
        : 'border-slate-200 bg-white';
  return (
    <div className={`flex gap-3 rounded-lg border px-4 py-3 ${tone}`}>
      <span
        className={`mt-0.5 font-bold ${status === 'pass' ? 'text-emerald-600' : status === 'fail' ? 'text-red-600' : 'text-slate-400'}`}
        aria-hidden
      >
        {icon}
      </span>
      <div className="min-w-0">
        <p className="font-semibold">
          {KIND_TITLE[c.kind]} — <code className="rounded bg-slate-100 px-1.5 py-0.5 text-sm font-normal">{conditionDetail(c)}</code>
        </p>
        <p className="text-sm text-slate-600">{c.description}</p>
      </div>
    </div>
  );
}

export function TermsView({ escrow }: { escrow: Escrow }) {
  return (
    <div className="space-y-4">
      {escrow.summary && <p className="text-lg leading-relaxed text-slate-800">{escrow.summary}</p>}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Checks the agent will run</h3>
        {escrow.conditions.length === 0 ? (
          <p className="text-slate-500">No machine-checkable conditions. Edit the agreement to add some.</p>
        ) : (
          escrow.conditions.map((c) => <ConditionCard key={c.id} condition={c} />)
        )}
      </div>
      {!!escrow.clarifications?.length && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Not checked automatically</h3>
          {escrow.clarifications.map((text) => (
            <p key={text} className="rounded-lg border border-amber-200 bg-amber-50 px-4 py-2 text-amber-900">
              {text}
            </p>
          ))}
        </div>
      )}
    </div>
  );
}

function acceptedBy(escrow: Escrow, role: 'client' | 'freelancer') {
  return escrow.acceptances.find((a) => a.role === role && a.termsHash === escrow.termsHash);
}

export function AcceptanceStatus({ escrow }: { escrow: Escrow }) {
  return (
    <div className="flex flex-wrap gap-2 text-sm">
      {(['client', 'freelancer'] as const).map((role) => {
        const a = acceptedBy(escrow, role);
        return (
          <span
            key={role}
            className={`rounded-full px-3 py-1 font-medium ${a ? 'bg-emerald-100 text-emerald-800' : 'bg-slate-100 text-slate-500'}`}
          >
            {a ? '✓' : '…'} {role === 'client' ? 'Client' : 'Freelancer'}
            {a ? (a.signature ? ' signed' : ' accepted') : ' has not accepted'}
          </span>
        );
      })}
      <span className="rounded-full bg-slate-100 px-3 py-1 font-mono text-slate-500" title={escrow.termsHash}>
        terms {shortHash(escrow.termsHash)}
      </span>
    </div>
  );
}

/** Signs the terms hash with the party wallet if it can, then accepts at the agent. */
export function AcceptButton({ escrow, role }: { escrow: Escrow; role: 'client' | 'freelancer' }) {
  const accept = useAction(async () => {
    const termsHash = escrow.termsHash;
    if (!termsHash) throw new Error('Terms are not ready yet.');
    const sig = await partyApi.sign(termsHash).catch(() => undefined); // optional (BIP-322 via WDK)
    await agentApi.accept(escrow.id, { role, termsHash, ...sig });
  });

  if (escrow.state !== 'PROPOSED' || !escrow.termsHash) return null;
  if (acceptedBy(escrow, role)) {
    return <p className="font-medium text-emerald-700">You accepted these terms. Waiting for the other side.</p>;
  }
  return (
    <div className="space-y-2">
      <button
        type="button"
        onClick={() => void accept.run()}
        disabled={accept.busy}
        className="rounded-lg bg-slate-900 px-6 py-3 text-lg font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
      >
        {accept.busy ? 'Accepting…' : 'Accept these terms'}
      </button>
      {accept.error && <ErrorBanner>{accept.error}</ErrorBanner>}
    </div>
  );
}
