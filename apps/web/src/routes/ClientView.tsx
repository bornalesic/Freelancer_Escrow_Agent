import { useSearchParams } from 'react-router';
import { EscrowPanel } from '../components/EscrowPanel';
import { Layout } from '../components/Layout';
import { NewAgreementForm } from '../components/NewAgreementForm';
import { Card, Spinner } from '../components/ui';
import { WalletCard } from '../components/WalletCard';
import { pickEscrow } from '../lib/escrowStore';
import { useEscrowStream } from '../lib/hooks';

export function ClientView() {
  const [params, setParams] = useSearchParams();
  const { state, status } = useEscrowStream();
  const creating = params.get('new') === '1';
  const view = creating ? undefined : pickEscrow(state, params.get('escrow'));
  const live = status === 'live' || status === 'fixture';

  return (
    <Layout role="client" live={live}>
      <div className="mx-auto max-w-6xl">
        {view ? (
          <EscrowPanel view={view} role="client" onNew={() => setParams({ new: '1' })} />
        ) : !live && !creating ? (
          <p className="flex items-center justify-center gap-3 py-20 text-slate-500">
            <Spinner /> Connecting to the escrow agent…
          </p>
        ) : (
          <div className="grid items-start gap-6 lg:grid-cols-[1fr_320px]">
            <Card>
              <NewAgreementForm onCreated={(escrow) => setParams({ escrow: escrow.id })} />
            </Card>
            <WalletCard />
          </div>
        )}
      </div>
    </Layout>
  );
}
