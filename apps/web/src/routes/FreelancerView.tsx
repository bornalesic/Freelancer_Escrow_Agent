import { Link, useSearchParams } from 'react-router';
import { formatAmount } from '@escrow/shared';
import { EscrowPanel } from '../components/EscrowPanel';
import { Layout } from '../components/Layout';
import { Card, Empty, StateChip } from '../components/ui';
import { WalletCard } from '../components/WalletCard';
import { pickEscrow, type StreamState } from '../lib/escrowStore';
import { useEscrowStream } from '../lib/hooks';

function JobList({ state, selected }: { state: StreamState; selected?: string }) {
  const list = Object.values(state).sort((a, b) => b.escrow.createdAt.localeCompare(a.escrow.createdAt));
  if (list.length < 2) return null; // one job: just show it
  return (
    <Card title="Jobs">
      <ul className="divide-y divide-slate-100">
        {list.map(({ escrow }) => (
          <li key={escrow.id}>
            <Link
              to={`?escrow=${escrow.id}`}
              className={`flex items-center justify-between gap-3 rounded px-2 py-2 hover:bg-slate-50 ${escrow.id === selected ? 'bg-slate-100' : ''}`}
            >
              <span className="font-medium">{escrow.title}</span>
              <span className="flex items-center gap-3 text-sm text-slate-600">
                {formatAmount(escrow.amount, escrow.precision)} {escrow.assetTicker}
                <StateChip state={escrow.state} />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </Card>
  );
}

export function FreelancerView() {
  const [params] = useSearchParams();
  const { state, status } = useEscrowStream();
  const view = pickEscrow(state, params.get('escrow'));

  return (
    <Layout role="freelancer" live={status === 'live' || status === 'fixture'}>
      <div className="mx-auto max-w-6xl space-y-6">
        <JobList state={state} selected={view?.escrow.id} />
        {view ? (
          <EscrowPanel view={view} role="freelancer" />
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[minmax(0,1fr)_320px]">
            <Card>
              <Empty>No jobs yet. A job appears here as soon as a client writes an agreement.</Empty>
            </Card>
            <WalletCard />
          </div>
        )}
      </div>
    </Layout>
  );
}
