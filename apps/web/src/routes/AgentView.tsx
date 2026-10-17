// Projector screen: read-only, big text (min 20 px), readable from the back of the room.
import { useSearchParams } from 'react-router';
import { formatAmount, type Escrow, type EscrowState } from '@escrow/shared';
import { useHealth } from '../components/Connection';
import { DecisionLog } from '../components/DecisionLog';
import { Layout } from '../components/Layout';
import { StateTimeline } from '../components/StateTimeline';
import { Countdown, StateChip } from '../components/ui';
import { config } from '../config';
import { useAgentConfig } from '../lib/agentConfig';
import { findBalance, partyWalletAt } from '../lib/api';
import { isClosed, pickEscrow } from '../lib/escrowStore';
import { useEscrowStream, usePoll } from '../lib/hooks';

function Badges() {
  const { agent } = useHealth();
  const network = agent.data?.network ?? 'regtest';
  return (
    <div className="flex flex-wrap gap-3 text-lg font-medium text-slate-700">
      <span className="rounded-full bg-orange-100 px-4 py-1">RGB on Bitcoin · {network}</span>
      <span className="rounded-full bg-teal-100 px-4 py-1">Self-custodial · Tether WDK wallet</span>
      {/* TODO(web): model name once the agent's /health reports it */}
      <span className="rounded-full bg-violet-100 px-4 py-1">QVAC · running locally</span>
    </div>
  );
}

// Money sits in the agent's wallet from funding until the payout/refund has settled.
const HELD: EscrowState[] = ['FUNDED', 'DELIVERED', 'VERIFYING', 'RELEASING', 'REFUNDING'];

function PartyBalance({ label, url }: { label: string; url?: string }) {
  const asset = useAgentConfig();
  const wallet = usePoll(url && !config.fixture ? () => partyWalletAt(url) : null, 3_000);
  if (!url) return null;
  const bal = findBalance(wallet.data, asset?.assetId);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums">
        {bal && asset ? `${formatAmount(bal.settled, asset.precision)} ${asset.assetTicker}` : wallet.error ? 'offline' : '–'}
      </span>
    </div>
  );
}

function Money({ escrow }: { escrow: Escrow }) {
  const held = HELD.includes(escrow.state);
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-slate-900 p-6 text-white">
        <h2 className="text-base font-semibold uppercase tracking-wide text-slate-400">Held in escrow</h2>
        {/* TODO(web): the agent wallet's real balance once the agent exposes it */}
        <p className="mt-2 text-5xl font-bold tabular-nums">{held ? formatAmount(escrow.amount, escrow.precision) : '0'}</p>
        <p className="mt-1 text-xl text-slate-300">{escrow.assetTicker}</p>
        <p className="mt-4 text-base text-slate-400">Agent's own WDK wallet · RGB on Bitcoin</p>
      </div>
      <div className="space-y-2 text-xl">
        <PartyBalance label="Client" url={config.clientPartyUrl} />
        <PartyBalance label="Freelancer" url={config.freelancerPartyUrl} />
      </div>
    </div>
  );
}

export function AgentView() {
  const [params] = useSearchParams();
  const escrowId = params.get('escrow') ?? undefined;
  const { state, status } = useEscrowStream(escrowId);
  const view = pickEscrow(state, escrowId);

  return (
    <Layout role="agent" live={status === 'live' || status === 'fixture'} footer={<Badges />}>
      {!view ? (
        <div className="flex h-[70vh] flex-col items-center justify-center gap-3 text-center">
          {status === 'live' || status === 'fixture' ? (
            <>
              <p className="text-4xl font-bold text-slate-800">Waiting for an agreement…</p>
              <p className="text-2xl text-slate-500">The decision log appears here as soon as a client writes one.</p>
            </>
          ) : (
            <p className="text-4xl font-bold text-slate-800">Connecting to the escrow agent…</p>
          )}
        </div>
      ) : (
        <div className="grid h-[calc(100vh-10.5rem)] gap-8 xl:grid-cols-[minmax(260px,320px)_1fr_minmax(260px,300px)]">
          <aside className="space-y-6 text-xl">
            <div className="space-y-3">
              <h1 className="text-4xl font-bold leading-tight">{view.escrow.title}</h1>
              <p className="text-3xl font-semibold tabular-nums">
                {formatAmount(view.escrow.amount, view.escrow.precision)} {view.escrow.assetTicker}
              </p>
              <StateChip state={view.escrow.state} large />
              {!isClosed(view.escrow.state) && (
                <p className="text-slate-600">
                  <Countdown deadline={view.escrow.deadline} />
                </p>
              )}
            </div>
            <StateTimeline state={view.escrow.state} large />
          </aside>

          <section aria-label="Decision log" className="min-h-0">
            <DecisionLog events={view.events} />
          </section>

          <aside>
            <Money escrow={view.escrow} />
          </aside>
        </div>
      )}
    </Layout>
  );
}
