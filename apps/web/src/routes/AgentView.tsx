// Projector screen: read-only, big text (min 20 px), readable from the back of the room.
import { useSearchParams } from 'react-router';
import { formatAmount, type Escrow, type EscrowState } from '@escrow/shared';
import { useHealth } from '../components/Connection';
import { DecisionLog } from '../components/DecisionLog';
import { Layout } from '../components/Layout';
import { latestDelivery, OpinionChip, SourceBadge } from '../components/Review';
import { StateTimeline } from '../components/StateTimeline';
import { VerifiabilityBadge } from '../components/Verifiability';
import { isClientReview } from '../lib/terms';
import { AnimatedAmount, Countdown, ReviewCountdown, StateChip } from '../components/ui';
import { config } from '../config';
import { useAgentConfig } from '../lib/agentConfig';
import { agentApi, findBalance, partyWalletAt } from '../lib/api';
import { isClosed, pickEscrow } from '../lib/escrowStore';
import { useEscrowStream, usePoll } from '../lib/hooks';

/** "QWEN3_5_4B_MULTIMODAL_Q4_K_M" (an @qvac/sdk constant) → "Qwen3.5 4B"; anything else as is. */
export function modelLabel(model: string): string {
  const m = /^QWEN(\d+)_(\d+)_(\d+(?:_\d+)?)B/i.exec(model);
  return m ? `Qwen${m[1]}.${m[2]} ${m[3].replace('_', '.')}B` : model;
}

function Badges() {
  const { agent } = useHealth();
  const network = agent.data?.network ?? 'regtest';
  const model = agent.data?.aiModel;
  return (
    <div className="flex flex-wrap gap-3 text-lg font-medium text-slate-700">
      <span className="rounded-full bg-orange-100 px-4 py-1">RGB on Bitcoin · {network}</span>
      <span className="rounded-full bg-teal-100 px-4 py-1">Self-custodial · Tether WDK wallet</span>
      <span className="rounded-full bg-violet-100 px-4 py-1">{!model ? 'QVAC · on-device' : model === 'mock' ? 'QVAC · mock mode' : `QVAC ${modelLabel(model)} · on-device`}</span>
    </div>
  );
}

// Money sits in the agent's wallet from funding until the payout/refund has settled.
const HELD: EscrowState[] = ['FUNDED', 'DELIVERED', 'VERIFYING', 'AWAITING_APPROVAL', 'RELEASING', 'REFUNDING'];

/** While the client reviews: QVAC's opinion, framed so the room sees the client decides. */
function ClientsCall({ escrow }: { escrow: Escrow }) {
  const d = latestDelivery(escrow);
  if (escrow.state !== 'AWAITING_APPROVAL' || !d) return null;
  return (
    <div className="space-y-3 rounded-2xl border-2 border-sky-300 bg-sky-50 p-5">
      <h2 className="text-base font-semibold uppercase tracking-wide text-sky-800">The client decides</h2>
      {d.review ? (
        <>
          <div className="flex items-center gap-2 text-lg text-slate-700">
            AI opinion <SourceBadge review={d.review} />
          </div>
          <ul className="space-y-2">
            {escrow.conditions.filter(isClientReview).map((c) => (
              <li key={c.id} className="space-y-1">
                <p className="text-lg leading-snug text-slate-900">{c.description}</p>
                <OpinionChip opinion={d.review?.items.find((i) => i.conditionId === c.id)?.opinion ?? 'unsure'} large />
              </li>
            ))}
          </ul>
        </>
      ) : (
        <p className="text-lg text-violet-700">QVAC is looking at the work…</p>
      )}
      <p className="text-base text-slate-600">Advice only. The AI never moves the money.</p>
    </div>
  );
}

function PartyBalance({ label, url }: { label: string; url?: string }) {
  const asset = useAgentConfig();
  const wallet = usePoll(url && !config.fixture ? () => partyWalletAt(url) : null, 3_000);
  if (!url) return null;
  const bal = findBalance(wallet.data, asset?.assetId);
  return (
    <div className="flex items-baseline justify-between gap-3">
      <span className="text-slate-500">{label}</span>
      <span className="font-semibold tabular-nums">
        {bal && asset ? (
          <>
            <AnimatedAmount value={formatAmount(bal.settled, asset.precision)} /> {asset.assetTicker}
          </>
        ) : wallet.error ? (
          'offline'
        ) : (
          '–'
        )}
      </span>
    </div>
  );
}

function Money({ escrow }: { escrow: Escrow }) {
  // The agent wallet's real balance; derived from the state only when the agent can't report it.
  const wallet = usePoll(config.fixture ? null : agentApi.wallet, 3_000);
  const bal = findBalance(wallet.data, escrow.assetId);
  const held = bal ? bal.settled : HELD.includes(escrow.state) ? escrow.amount : '0';
  return (
    <div className="space-y-6">
      <div className="rounded-2xl bg-slate-900 p-6 text-white">
        <h2 className="text-base font-semibold uppercase tracking-wide text-slate-400">Held in escrow</h2>
        <p className="mt-2 text-5xl font-bold tabular-nums">
          <AnimatedAmount value={formatAmount(held, escrow.precision)} />
        </p>
        <p className="mt-1 text-xl text-slate-300">{escrow.assetTicker}</p>
        <p className="mt-4 text-base text-slate-400">Agent's own WDK wallet · RGB on Bitcoin</p>
      </div>
      <ClientsCall escrow={escrow} />
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
  const reviewDue = view?.escrow.state === 'AWAITING_APPROVAL' ? latestDelivery(view.escrow)?.reviewDueAt : undefined;

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
        <div className="grid h-[calc(100vh-10.5rem)] gap-8 xl:grid-cols-[minmax(260px,320px)_minmax(0,1fr)_minmax(260px,300px)]">
          <aside className="space-y-6 text-xl">
            <div className="space-y-3">
              <h1 className="text-4xl font-bold leading-tight">{view.escrow.title}</h1>
              <p className="text-3xl font-semibold tabular-nums">
                {formatAmount(view.escrow.amount, view.escrow.precision)} {view.escrow.assetTicker}
              </p>
              <StateChip state={view.escrow.state} large />
              {view.escrow.state !== 'DRAFT' && (
                <div>
                  <VerifiabilityBadge conditions={view.escrow.conditions} />
                </div>
              )}
              {reviewDue ? (
                <p className="font-semibold text-sky-700">
                  <ReviewCountdown dueAt={reviewDue} />
                </p>
              ) : (
                !isClosed(view.escrow.state) && (
                  <p className="text-slate-600">
                    <Countdown deadline={view.escrow.deadline} />
                  </p>
                )
              )}
            </div>
            <StateTimeline state={view.escrow.state} review={view.escrow.conditions.some(isClientReview)} large />
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
