import { Link } from 'react-router';
import { TERMINAL_STATES } from '@escrow/shared';
import { JobRow } from '../../components/Jobs';
import { Layout } from '../../components/Layout';
import { Empty } from '../../components/ui';
import { openOffers } from '../../lib/format';
import { useMarket } from '../../lib/hooks';
import { isMyJob } from '../../lib/session';

const NEXT: Partial<Record<string, string>> = {
  PROPOSED: 'Review the requirements',
  AWAITING_APPROVAL: 'Review the work',
};

export function MyListings() {
  const { jobs, asset } = useMarket();
  const list = Object.values(jobs)
    .map((v) => v.escrow)
    .filter((e) => isMyJob('client', e))
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt));
  const active = list.filter((e) => !TERMINAL_STATES.includes(e.state));
  const done = list.filter((e) => TERMINAL_STATES.includes(e.state));

  return (
    <Layout role="client">
      <div className="mb-6 flex items-center justify-between">
        <h1 className="text-2xl font-bold text-slate-900">My listings</h1>
        <Link to="/client/new" className="rounded-lg bg-indigo-600 px-4 py-2 text-sm font-semibold text-white hover:bg-indigo-700">
          New listing
        </Link>
      </div>
      {list.length === 0 ? (
        <Empty>
          No listings yet. <Link to="/client/new" className="font-medium text-indigo-600 hover:underline">Post your first job</Link>.
        </Empty>
      ) : (
        <div className="space-y-8">
          <div className="space-y-3">
            {active.map((e) => {
              const next = NEXT[e.state] ?? (e.state === 'OPEN' && openOffers(e, Date.now()).length > 0 ? 'Review the offers' : undefined);
              return (
                <JobRow
                  key={e.id}
                  escrow={e}
                  to={`/client/jobs/${e.id}`}
                  asset={asset}
                  showFee
                  aside={next && <span className="font-semibold text-indigo-700">→ {next}</span>}
                />
              );
            })}
            {active.length === 0 && <p className="text-sm text-slate-500">Nothing in progress.</p>}
          </div>
          {done.length > 0 && (
            <div>
              <h2 className="mb-3 text-sm font-semibold uppercase tracking-wide text-slate-500">Finished</h2>
              <div className="space-y-3">
                {done.map((e) => <JobRow key={e.id} escrow={e} to={`/client/jobs/${e.id}`} asset={asset} showFee />)}
              </div>
            </div>
          )}
        </div>
      )}
    </Layout>
  );
}
