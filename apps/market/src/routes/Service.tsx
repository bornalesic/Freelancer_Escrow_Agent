// The projector: what the escrow service itself sees. Money it holds per job, every job's live log with
// QVAC's explanations, and the RGB trail open. Never anyone's wallet balance: the service can't read them.
import { useState } from 'react';
import { TERMINAL_STATES, type Escrow } from '@escrow/shared';
import { JobHeader } from '../components/Jobs';
import { Layout } from '../components/Layout';
import { RgbPanel } from '../components/RgbPanel';
import { Timeline } from '../components/Timeline';
import { Work } from '../components/Work';
import { Button, Card, Empty, StateBadge } from '../components/ui';
import { agentApi } from '../lib/api';
import { frozen, money } from '../lib/format';
import { useAction, useMarket, usePoll } from '../lib/hooks';

function Stat({ label, value, hint }: { label: string; value: string; hint?: string }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-5 shadow-sm">
      <p className="text-sm font-medium text-slate-500">{label}</p>
      <p className="mt-1 text-3xl font-bold tabular-nums text-slate-900">{value}</p>
      {hint && <p className="mt-1 text-xs text-slate-400">{hint}</p>}
    </div>
  );
}

export function Service() {
  const { jobs, asset, refresh } = useMarket();
  const [pinned, setPinned] = useState<string>();
  const ownWallet = usePoll(() => agentApi.wallet(), 5_000);
  const reset = useAction(async () => {
    if (window.confirm('Delete every job on the escrow service? Money it still holds stays in its wallet.')) {
      await agentApi.devReset();
      setPinned(undefined);
      refresh();
    }
  });

  const all = Object.values(jobs).sort((a, b) => Date.parse(b.escrow.updatedAt) - Date.parse(a.escrow.updatedAt));
  const active = all.filter((v) => !TERMINAL_STATES.includes(v.escrow.state));
  const held = all.reduce((sum, v) => sum + BigInt(frozen(v.escrow)), 0n);
  const fees = all.filter((v) => v.escrow.state === 'RELEASED').reduce((sum, v) => sum + BigInt(v.escrow.fee ?? '0'), 0n);
  const focus = (pinned && jobs[pinned]) || active[0] || all[0];
  const walletBal = asset ? ownWallet.data?.assets.find((a) => a.assetId === asset.assetId) : undefined;
  const m = (units: bigint | string) => (asset ? money(units, asset) : '…');
  const frozenJobs = all.filter((v) => frozen(v.escrow) !== '0').length;

  const row = (e: Escrow) => (
    <button
      key={e.id}
      type="button"
      onClick={() => setPinned(e.id === pinned ? undefined : e.id)}
      className={`w-full rounded-xl border px-4 py-3 text-left transition ${focus?.escrow.id === e.id ? 'border-indigo-400 bg-indigo-50/60' : 'border-slate-200 bg-white hover:border-slate-300'}`}
    >
      <div className="flex items-center justify-between gap-3">
        <p className="truncate font-semibold text-slate-900">{e.title}</p>
        <StateBadge state={e.state} />
      </div>
      <p className="mt-1 text-sm text-slate-500">
        {frozen(e) !== '0' ? <>Holding <strong className="text-slate-800">{m(frozen(e))}</strong></> : `Reward ${m(e.amount)}`}
        {e.id === pinned && ' · pinned'}
      </p>
    </button>
  );

  return (
    <Layout wide>
      <div className="space-y-6">
        <div className="flex flex-wrap items-end justify-between gap-3">
          <div>
            <h1 className="text-3xl font-bold text-slate-900">Escrow service</h1>
            <p className="text-slate-500">What the service holds and decides. It never sees anyone's wallet balance.</p>
          </div>
        </div>
        <div className="grid gap-4 md:grid-cols-4">
          <Stat label="Held in escrow now" value={m(held)} hint={`${frozenJobs} job${frozenJobs === 1 ? '' : 's'}, reward + fee each`} />
          <Stat label="Open listings" value={String(all.filter((v) => v.escrow.state === 'OPEN').length)} />
          <Stat label="Fees earned" value={m(fees)} hint="2% of every paid job" />
          <Stat
            label="Escrow wallet (RGB, Tether WDK)"
            value={walletBal ? m(walletBal.settled) : ownWallet.error ? 'offline' : '…'}
            hint="The service's own wallet: jobs held + fees kept"
          />
        </div>

        {all.length === 0 ? (
          <Empty>No jobs yet. Post one as a client to see it here live.</Empty>
        ) : (
          <div className="grid gap-6 xl:grid-cols-[360px_minmax(0,1fr)]">
            <div className="space-y-2">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">
                Jobs {pinned ? '· click again to follow the latest' : '· following the latest'}
              </p>
              {active.map((v) => row(v.escrow))}
              {all.filter((v) => TERMINAL_STATES.includes(v.escrow.state)).map((v) => row(v.escrow))}
            </div>
            {focus && (
              <div className="space-y-6">
                <JobHeader escrow={focus.escrow} asset={asset} />
                <div className="grid gap-6 2xl:grid-cols-2">
                  <Card title="Live decision log">
                    <Timeline events={focus.events} large />
                  </Card>
                  <div className="space-y-6">
                    <RgbPanel key={focus.escrow.id} escrow={focus.escrow} events={focus.events} asset={asset} open />
                    {focus.escrow.deliveries.length > 0 && (
                      <Card title="Delivered work">
                        <Work escrow={focus.escrow} token={undefined} viewer="service" />
                      </Card>
                    )}
                  </div>
                </div>
              </div>
            )}
          </div>
        )}

        <div className="flex items-center justify-end gap-3 border-t border-slate-200 pt-4 text-xs text-slate-400">
          {reset.error && <span className="text-red-600">{reset.error}</span>}
          <Button variant="ghost" className="!text-xs" busy={reset.busy} onClick={() => void reset.run()}>Demo: clear all jobs</Button>
        </div>
      </div>
    </Layout>
  );
}
