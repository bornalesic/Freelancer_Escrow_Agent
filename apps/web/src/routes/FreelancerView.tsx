import { Link, useSearchParams } from 'react-router';
import { formatAmount } from '@escrow/shared';
import { EscrowSummary } from '../components/EscrowSummary';
import { Layout } from '../components/Layout';
import { Card, Empty, StateChip } from '../components/ui';
import { WalletCard } from '../components/WalletCard';
import { useEscrowStream } from '../lib/hooks';

export function FreelancerView() {
  const [params] = useSearchParams();
  const { state, status } = useEscrowStream();
  const selected = params.get('escrow');
  const list = Object.values(state).sort((a, b) => b.escrow.createdAt.localeCompare(a.escrow.createdAt));
  const view = selected ? state[selected] : undefined;

  return (
    <Layout role="freelancer" live={status === 'live' || status === 'fixture'}>
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_320px]">
        <div className="space-y-6">
          <Card title="Jobs">
            {list.length === 0 ? (
              <Empty>No jobs yet. They appear here as soon as a client creates one.</Empty>
            ) : (
              <ul className="divide-y divide-slate-100">
                {list.map(({ escrow }) => (
                  <li key={escrow.id}>
                    <Link
                      to={`?escrow=${escrow.id}`}
                      className={`flex items-center justify-between gap-3 px-2 py-3 hover:bg-slate-50 ${escrow.id === selected ? 'bg-slate-50' : ''}`}
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
            )}
          </Card>
          {/* TODO(web): terms + Accept, upload with payout invoice, per-condition results */}
          {view && (
            <Card title="Job">
              <EscrowSummary escrow={view.escrow} />
            </Card>
          )}
        </div>
        <WalletCard />
      </div>
    </Layout>
  );
}
