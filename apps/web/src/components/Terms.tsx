// The proposed terms as both parties see them, and the Accept button.
import type { ReactNode } from 'react';
import type { Condition, Escrow, PartyRole } from '@escrow/shared';
import { agentApi, partyApi } from '../lib/api';
import { useAction } from '../lib/hooks';
import { isClientReview, termsMatch } from '../lib/terms';
import { ErrorBanner } from './ui';

type Party = PartyRole;

const KIND_TITLE: Record<Condition['kind'], string> = {
  tests_pass: 'Tests pass',
  file_present: 'File included',
  file_hash: 'File matches exactly',
  client_review: 'Client decides',
};



export function conditionDetail(c: Condition): string {
  switch (c.kind) {
    case 'tests_pass':
      return c.command;
    case 'file_present':
      return c.pathPattern;
    case 'file_hash':
      return `${c.fileName ?? 'whole upload'} · sha256 ${c.sha256.slice(0, 12)}…`;
    case 'client_review':
      return c.description;
  }
}

export const shortHash = (h?: string) => (h ? `${h.slice(0, 4)}…` : '–');

export function PersonIcon({ className = 'h-5 w-5' }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.75} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <path d="M15.75 6a3.75 3.75 0 1 1-7.5 0 3.75 3.75 0 0 1 7.5 0ZM4.5 20.1a7.5 7.5 0 0 1 15 0" />
    </svg>
  );
}

/** A client_review condition: visibly different from the automatic checks. `children` = opinion/answer. */
export function ReviewConditionCard({
  condition: c,
  role,
  status,
  children,
}: {
  condition: Condition;
  role?: Party;
  status?: 'pass' | 'fail';
  children?: ReactNode;
}) {
  const tone =
    status === 'pass' ? 'border-emerald-300 bg-emerald-50' : status === 'fail' ? 'border-red-300 bg-red-50' : 'border-sky-300 bg-sky-50';
  return (
    <div className={`flex gap-3 rounded-lg border border-dashed px-4 py-3 ${tone}`}>
      <span className="mt-0.5 text-sky-600">
        <PersonIcon />
      </span>
      <div className="min-w-0 flex-1 space-y-2">
        <p className="font-semibold text-slate-900">
          <span className="text-sky-800">{role === 'client' ? 'You decide' : 'Client decides'}:</span>{' '}
          <span className="font-normal">{c.description}</span>
        </p>
        {children}
      </div>
    </div>
  );
}

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

export function TermsView({ escrow, role }: { escrow: Escrow; role: Party }) {
  const automatic = escrow.conditions.filter((c) => !isClientReview(c));
  const review = escrow.conditions.filter(isClientReview);
  return (
    <div className="space-y-4">
      {escrow.summary && <p className="text-lg leading-relaxed text-slate-800">{escrow.summary}</p>}
      <div className="space-y-2">
        <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Checks the agent will run</h3>
        {automatic.length === 0 ? (
          <p className="text-slate-500">No automatic checks. Edit the agreement to add some.</p>
        ) : (
          automatic.map((c) => <ConditionCard key={c.id} condition={c} />)
        )}
      </div>
      {review.length > 0 && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">
            {role === 'client' ? 'You judge these yourself' : 'The client judges these'}
          </h3>
          {review.map((c) => (
            <ReviewConditionCard key={c.id} condition={c} role={role} />
          ))}
          <p className="text-sm text-slate-500">
            After the automatic checks pass, QVAC gives the client an opinion and the client approves or disputes. No answer in
            time means the freelancer is paid.
          </p>
        </div>
      )}
      {!!escrow.clarifications?.length && (
        <div className="space-y-2">
          <h3 className="text-sm font-semibold uppercase tracking-wide text-slate-500">Still unclear</h3>
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

function acceptedBy(escrow: Escrow, role: Party) {
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
      {escrow.termsHash && (
        <span
          className={`rounded-full px-3 py-1 font-mono ${termsMatch(escrow) ? 'bg-slate-100 text-slate-500' : 'bg-red-100 text-red-800'}`}
          title={`${escrow.termsHash}\n${termsMatch(escrow) ? 'Recomputed in this browser from the terms shown: matches.' : 'Does NOT match the terms shown.'}`}
        >
          terms {shortHash(escrow.termsHash)} {termsMatch(escrow) ? '· checked here ✓' : '· mismatch'}
        </span>
      )}
    </div>
  );
}

/** Signs the terms hash with the party wallet if it can, then accepts at the agent. */
export function AcceptButton({ escrow, role }: { escrow: Escrow; role: Party }) {
  const accept = useAction(async () => {
    const termsHash = escrow.termsHash;
    if (!termsHash) throw new Error('Terms are not ready yet.');
    if (!termsMatch(escrow)) throw new Error("The agent's terms hash doesn't match the terms on screen. Reload before accepting.");
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
