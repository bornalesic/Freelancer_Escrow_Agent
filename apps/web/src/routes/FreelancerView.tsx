import { useState, type FormEvent } from 'react';
import { Link, useSearchParams } from 'react-router';
import { formatAmount, type JobFit, type MatchResult } from '@escrow/shared';
import { EscrowPanel } from '../components/EscrowPanel';
import { Layout } from '../components/Layout';
import { Card, Empty, StateChip } from '../components/ui';
import { VerifiabilityBadge } from '../components/Verifiability';
import { WalletCard } from '../components/WalletCard';
import { assist, isUnavailable } from '../lib/assist';
import { isClosed, pickEscrow, type StreamState } from '../lib/escrowStore';
import { useAction, useEscrowStream } from '../lib/hooks';

const FIT: Record<JobFit, { label: string; cls: string; rank: number }> = {
  good: { label: 'Good fit', cls: 'bg-emerald-100 text-emerald-800', rank: 0 },
  partial: { label: 'Partial fit', cls: 'bg-amber-100 text-amber-800', rank: 1 },
  poor: { label: 'Poor fit', cls: 'bg-slate-200 text-slate-600', rank: 2 },
};

/** "My skills" → QVAC ranks the open jobs. */
function useMatch(state: StreamState) {
  const [skills, setSkills] = useState('');
  const [result, setResult] = useState<MatchResult>();
  const [off, setOff] = useState<string>();
  const match = useAction(async () => {
    const jobs = Object.values(state)
      .filter(({ escrow }) => !isClosed(escrow.state))
      .slice(0, 20)
      .map(({ escrow }) => ({ id: escrow.id, title: escrow.title, rawText: escrow.rawText, conditions: escrow.conditions }));
    if (!jobs.length) return;
    try {
      setResult(await assist('match', { skills: skills.trim(), jobs }));
    } catch (err) {
      if (!isUnavailable(err)) throw err;
      setOff(err.message);
    }
  });
  return { skills, setSkills, result, off, match };
}

function JobList({ state, selected }: { state: StreamState; selected?: string }) {
  const m = useMatch(state);
  const fitOf = (id: string) => m.result?.ranked.find((r) => r.id === id);
  // Best fit first once matched (closed jobs were not ranked: last); otherwise newest first.
  const rank = (id: string) => (m.result ? FIT[fitOf(id)?.fit ?? 'poor'].rank + (fitOf(id) ? 0 : 1) : 0);
  const list = Object.values(state).sort((a, b) => rank(a.escrow.id) - rank(b.escrow.id) || b.escrow.createdAt.localeCompare(a.escrow.createdAt));
  if (list.length < 2) return null; // one job: just show it

  const submit = (e: FormEvent) => {
    e.preventDefault();
    if (m.skills.trim().length >= 2) void m.match.run();
  };

  return (
    <Card title="Jobs">
      {!m.off && (
        <form onSubmit={submit} className="mb-3 flex flex-wrap gap-2">
          <input
            className="min-w-0 flex-1 rounded-lg border border-slate-300 bg-white px-3 py-1.5 text-sm focus:border-slate-900 focus:outline-none"
            placeholder="My skills, e.g. JavaScript, testing, CSS"
            value={m.skills}
            onChange={(e) => m.setSkills(e.target.value)}
            maxLength={1000}
          />
          <button
            type="submit"
            disabled={m.match.busy || m.skills.trim().length < 2}
            className="rounded-lg bg-slate-900 px-3 py-1.5 text-sm font-semibold text-white hover:bg-slate-700 disabled:opacity-50"
          >
            {m.match.busy ? 'Matching…' : 'Find jobs that fit'}
          </button>
        </form>
      )}
      {m.match.error && <p className="mb-2 text-sm text-red-700">{m.match.error}</p>}
      <ul className="divide-y divide-slate-100">
        {list.map(({ escrow }) => {
          const fit = fitOf(escrow.id);
          return (
            <li key={escrow.id}>
              <Link
                to={`?escrow=${escrow.id}`}
                className={`flex items-center justify-between gap-3 rounded px-2 py-2 hover:bg-slate-50 ${escrow.id === selected ? 'bg-slate-100' : ''}`}
              >
                <span className="min-w-0">
                  <span className="flex flex-wrap items-center gap-2 font-medium">
                    {escrow.title}
                    {fit && <span className={`rounded-full px-2 py-0.5 text-xs font-semibold ${FIT[fit.fit].cls}`}>{FIT[fit.fit].label}</span>}
                  </span>
                  {fit && <span className="block text-sm text-slate-500">{fit.reason}</span>}
                </span>
                <span className="flex shrink-0 items-center gap-3 text-sm text-slate-600">
                  <VerifiabilityBadge conditions={escrow.conditions} compact />
                  {formatAmount(escrow.amount, escrow.precision)} {escrow.assetTicker}
                  <StateChip state={escrow.state} />
                </span>
              </Link>
            </li>
          );
        })}
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
