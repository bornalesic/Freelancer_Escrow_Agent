// One escrow as a party sees it: what to do next for this role, then the terms, results and outcome.
import type { ReactNode } from 'react';
import { formatAmount, type Escrow, type EscrowState, type LogEvent } from '@escrow/shared';
import { agentApi } from '../lib/api';
import { isClosed, type EscrowView } from '../lib/escrowStore';
import { useAction } from '../lib/hooks';
import { Explanation } from './DecisionLog';
import { Deliveries } from './Deliveries';
import { FundingPanel } from './FundingPanel';
import { StateTimeline } from './StateTimeline';
import { AcceptanceStatus, AcceptButton, TermsView } from './Terms';
import { UploadPanel } from './UploadPanel';
import { Card, Countdown, ErrorBanner, Spinner, StateChip } from './ui';
import { WalletCard } from './WalletCard';

type Party = 'client' | 'freelancer';

const CANCELLABLE: EscrowState[] = ['DRAFT', 'PROPOSED', 'AGREED', 'AWAITING_FUNDS'];

function Waiting({ children }: { children: ReactNode }) {
  return (
    <p className="flex items-center gap-3 rounded-xl bg-slate-100 px-5 py-4 text-lg text-slate-700">
      <Spinner />
      {children}
    </p>
  );
}

function Outcome({ escrow, role }: { escrow: Escrow; role: Party }) {
  const amount = `${formatAmount(escrow.amount, escrow.precision)} ${escrow.assetTicker}`;
  switch (escrow.state) {
    case 'RELEASING':
      return <Waiting>All checks passed. Paying {amount} to the freelancer…</Waiting>;
    case 'RELEASED':
      return (
        <p className="rounded-xl bg-emerald-600 px-5 py-4 text-xl font-semibold text-white">
          {role === 'freelancer' ? `You were paid ${amount}.` : `Done. ${amount} paid to the freelancer.`}
        </p>
      );
    case 'REFUNDING':
      return <Waiting>Deadline passed without a passing delivery. Refunding {amount} to the client…</Waiting>;
    case 'REFUNDED':
      return (
        <p className="rounded-xl bg-orange-600 px-5 py-4 text-xl font-semibold text-white">
          {role === 'client' ? `${amount} refunded to you.` : `The deadline passed. ${amount} went back to the client.`}
        </p>
      );
    case 'CANCELLED':
      return <p className="rounded-xl bg-slate-200 px-5 py-4 text-lg font-semibold text-slate-700">This agreement was cancelled.</p>;
    default:
      return null;
  }
}

/** What this role should do (or wait for) right now. */
function NextStep({ escrow, events, role }: { escrow: Escrow; events: LogEvent[]; role: Party }) {
  switch (escrow.state) {
    case 'DRAFT':
      return <Waiting>QVAC is turning the agreement into checks…</Waiting>;
    case 'PROPOSED':
      return <AcceptButton escrow={escrow} role={role} />;
    case 'AGREED':
    case 'AWAITING_FUNDS':
      return role === 'client' ? (
        <FundingPanel escrow={escrow} paymentSeen={events.some((e) => e.type === 'funding.payment_seen')} />
      ) : (
        <Waiting>Both sides agreed. Waiting for the client to lock the money…</Waiting>
      );
    case 'FUNDED':
      return role === 'freelancer' ? (
        <div className="space-y-2">
          <p className="text-lg font-medium text-teal-800">
            The money is locked. Upload your work{escrow.deliveries.length ? ' again' : ''} before the deadline.
          </p>
          <UploadPanel escrow={escrow} />
        </div>
      ) : (
        <Waiting>
          The money is locked. Waiting for the freelancer to {escrow.deliveries.length ? 'upload a fixed version' : 'deliver'}…
        </Waiting>
      );
    case 'DELIVERED':
    case 'VERIFYING':
      return <Waiting>Checking the delivery…</Waiting>;
    default:
      return <Outcome escrow={escrow} role={role} />;
  }
}

function LatestDecision({ events }: { events: LogEvent[] }) {
  const e = events.findLast((x) => x.type === 'decision.made');
  if (!e) return null;
  return (
    <div className="rounded-xl border border-violet-200 bg-violet-50 px-5 py-4">
      <p className="text-lg font-semibold">{e.title}</p>
      {e.explain && <Explanation event={e} />}
    </div>
  );
}

export function EscrowPanel({ view, role, onNew }: { view: EscrowView; role: Party; onNew?: () => void }) {
  const { escrow, events } = view;
  const cancel = useAction(() => agentApi.cancel(escrow.id, role));
  const showTerms = escrow.state !== 'DRAFT';

  return (
    <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
      <div className="space-y-6">
        <Card>
          <div className="space-y-4">
            <div className="flex flex-wrap items-start justify-between gap-3">
              <div>
                <h1 className="text-2xl font-bold">{escrow.title}</h1>
                <p className="mt-1 text-slate-600">
                  <span className="text-lg font-semibold text-slate-900">
                    {formatAmount(escrow.amount, escrow.precision)} {escrow.assetTicker}
                  </span>{' '}
                  {!isClosed(escrow.state) && (
                    <>
                      · <Countdown deadline={escrow.deadline} />
                    </>
                  )}
                </p>
              </div>
              <StateChip state={escrow.state} large />
            </div>
            <NextStep escrow={escrow} events={events} role={role} />
            {cancel.error && <ErrorBanner>{cancel.error}</ErrorBanner>}
          </div>
        </Card>

        {escrow.deliveries.length > 0 && (
          <Card title="Deliveries">
            <div className="space-y-4">
              <LatestDecision events={events} />
              <Deliveries escrow={escrow} />
            </div>
          </Card>
        )}

        {showTerms && (
          <Card title={escrow.state === 'PROPOSED' ? 'Proposed terms' : 'Terms'}>
            <div className="space-y-4">
              <AcceptanceStatus escrow={escrow} />
              <TermsView escrow={escrow} />
              <details className="text-sm text-slate-500">
                <summary className="cursor-pointer">Original agreement</summary>
                <p className="mt-2 whitespace-pre-wrap rounded-lg bg-slate-50 p-3 text-slate-700">{escrow.rawText}</p>
              </details>
            </div>
          </Card>
        )}
      </div>

      <div className="space-y-6">
        <WalletCard />
        <Card title="Progress">
          <StateTimeline state={escrow.state} />
        </Card>
        <div className="flex flex-wrap gap-2">
          {onNew && (
            <button type="button" onClick={onNew} className="rounded-lg border border-slate-300 px-3 py-1.5 text-sm font-medium hover:bg-slate-100">
              New agreement
            </button>
          )}
          {CANCELLABLE.includes(escrow.state) && (
            <button
              type="button"
              onClick={() => void cancel.run()}
              disabled={cancel.busy}
              className="rounded-lg border border-red-200 px-3 py-1.5 text-sm font-medium text-red-700 hover:bg-red-50 disabled:opacity-50"
            >
              Cancel agreement
            </button>
          )}
        </div>
      </div>
    </div>
  );
}
