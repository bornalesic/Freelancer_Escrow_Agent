import { Link } from 'react-router';
import { TERMINAL_STATES, type EscrowState } from '@escrow/shared';
import { JobRow } from '../../components/Jobs';
import { Layout } from '../../components/Layout';
import { Empty } from '../../components/ui';
import { money } from '../../lib/format';
import { useMarket } from '../../lib/hooks';
import { isMyJob, myOffers } from '../../lib/session';

const NEXT: Partial<Record<EscrowState, string>> = {
  FUNDED: 'Send your work',
  AGREED: 'Waiting for the payment',
  AWAITING_FUNDS: 'Waiting for the payment',
};

export function MyJobs() {
  const { jobs, asset } = useMarket();
  const all = Object.values(jobs).map((v) => v.escrow);
  // A job that went back to the marketplace (not funded in time) is no longer this freelancer's.
  const list = all.filter((e) => isMyJob('freelancer', e)).sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const active = list.filter((e) => !TERMINAL_STATES.includes(e.state));
  const done = list.filter((e) => TERMINAL_STATES.includes(e.state));
  // Open listings where this browser's offer waits for the client.
  const offered = all
    .filter((e) => e.state === 'OPEN')
    .map((e) => ({ e, offer: e.offers?.find((o) => o.status === 'pending' && myOffers(e.id).some((m) => m.offerId === o.id)) }))
    .filter((x) => x.offer !== undefined);

  return (
    <Layout role="freelancer">
      <h1 className="mb-6 text-2xl font-bold text-slate-900">My jobs</h1>
      {list.length === 0 && offered.length === 0 ? (
        <Empty>
          You have not taken a job yet. <Link to="/freelancer" className="font-medium text-indigo-600 hover:underline">Browse the marketplace</Link>.
        </Empty>
      ) : (
        <div className="space-y-8">
          <div className="space-y-3">
            {active.map((e) => (
              <JobRow key={e.id} escrow={e} to={`/freelancer/jobs/${e.id}`} asset={asset} aside={NEXT[e.state] && <span className="font-semibold text-indigo-700">→ {NEXT[e.state]}</span>} />
            ))}
            {active.length === 0 && <p className="text-sm text-slate-500">Nothing in progress.</p>}
          </div>
          {offered.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">My offers</h2>
              <div className="space-y-3">
                {offered.map(({ e, offer }) => (
                  <JobRow
                    key={e.id}
                    escrow={e}
                    to={`/freelancer/jobs/${e.id}`}
                    asset={asset}
                    aside={<span className="font-semibold text-indigo-700">Your offer: {asset ? money(offer!.amount, asset) : '…'}, waiting for the client</span>}
                  />
                ))}
              </div>
            </div>
          )}
          {done.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Finished</h2>
              <div className="space-y-3">{done.map((e) => <JobRow key={e.id} escrow={e} to={`/freelancer/jobs/${e.id}`} asset={asset} />)}</div>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}
