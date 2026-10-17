// Projector screen: read-only, big text (min 20 px), readable from the back of the room.
import { useSearchParams } from 'react-router';
import { formatAmount } from '@escrow/shared';
import { Countdown } from '../components/EscrowSummary';
import { useHealth } from '../components/Connection';
import { Layout } from '../components/Layout';
import { Empty, StateChip } from '../components/ui';
import { pickEscrow } from '../lib/escrowStore';
import { useEscrowStream } from '../lib/hooks';

function Badges() {
  const { agent } = useHealth();
  const network = agent.data?.network ?? 'regtest';
  return (
    <div className="flex flex-wrap gap-3 text-base font-medium text-slate-700">
      <span className="rounded-full bg-orange-100 px-4 py-1">RGB on Bitcoin · {network}</span>
      <span className="rounded-full bg-teal-100 px-4 py-1">Tether WDK wallet</span>
      {/* TODO(web): model name once the agent's /health reports it */}
      <span className="rounded-full bg-violet-100 px-4 py-1">QVAC · on-device</span>
    </div>
  );
}

export function AgentView() {
  const [params] = useSearchParams();
  const { state, status } = useEscrowStream(params.get('escrow') ?? undefined);
  const view = pickEscrow(state, params.get('escrow'));

  return (
    <Layout role="agent" live={status === 'live' || status === 'fixture'} footer={<Badges />}>
      {!view ? (
        <div className="text-xl">
          <Empty>Waiting for an agreement…</Empty>
        </div>
      ) : (
        <div className="grid gap-6 text-xl xl:grid-cols-[320px_1fr_300px]">
          <aside className="space-y-4">
            <h1 className="text-3xl font-bold">{view.escrow.title}</h1>
            <p className="text-2xl font-semibold tabular-nums">
              {formatAmount(view.escrow.amount, view.escrow.precision)} {view.escrow.assetTicker}
            </p>
            <StateChip state={view.escrow.state} large />
            <p className="text-slate-600">
              <Countdown deadline={view.escrow.deadline} />
            </p>
            {/* TODO(web): state timeline */}
          </aside>

          <section aria-label="Decision log" className="space-y-3">
            {/* TODO(web): the real decision log — actor icons, streaming typewriter, auto-scroll */}
            {view.events.map((e) => (
              <article key={e.id} className="rounded-xl border border-slate-200 bg-white px-5 py-3">
                <div className="flex items-baseline gap-3">
                  <time className="text-base tabular-nums text-slate-400">{new Date(e.at).toLocaleTimeString()}</time>
                  <span className="text-base text-slate-500">{e.actor}</span>
                  <span className="font-semibold">{e.title}</span>
                </div>
                {e.explanation && <p className="mt-1 text-slate-600">{e.explanation}</p>}
              </article>
            ))}
          </section>

          <aside className="space-y-2">
            <h2 className="text-base font-semibold uppercase tracking-wide text-slate-500">Held in escrow</h2>
            {/* TODO(web): agent wallet balance — needs an agent endpoint (asked WS3) */}
            <p className="text-slate-400">–</p>
          </aside>
        </div>
      )}
    </Layout>
  );
}
