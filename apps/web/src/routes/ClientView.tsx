import { useSearchParams } from 'react-router';
import { EscrowSummary } from '../components/EscrowSummary';
import { Layout } from '../components/Layout';
import { Card, Empty } from '../components/ui';
import { WalletCard } from '../components/WalletCard';
import { pickEscrow } from '../lib/escrowStore';
import { useEscrowStream } from '../lib/hooks';

export function ClientView() {
  const [params] = useSearchParams();
  const { state, status } = useEscrowStream();
  const view = pickEscrow(state, params.get('escrow'));

  return (
    <Layout role="client" live={status === 'live' || status === 'fixture'}>
      <div className="mx-auto grid max-w-6xl gap-6 lg:grid-cols-[1fr_320px]">
        <Card title="Agreement">
          {/* TODO(web): new-agreement form, terms + Accept, Lock funds, status timeline */}
          {view ? <EscrowSummary escrow={view.escrow} /> : <Empty>No agreement yet.</Empty>}
        </Card>
        <WalletCard />
      </div>
    </Layout>
  );
}
