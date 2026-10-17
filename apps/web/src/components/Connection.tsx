// Health of everything this screen depends on, polled from /health. Shared via context so every
// part of a view (dots, banner, wallet card) reads one poll instead of starting its own.
import { createContext, useContext, type ReactNode } from 'react';
import type { AgentHealth, PartyHealth } from '@escrow/shared';
import { config } from '../config';
import { agentApi, partyApi } from '../lib/api';
import { usePoll, type Poll } from '../lib/hooks';

interface Health {
  agent: Poll<AgentHealth>;
  /** undefined on screens without a party server (/agent). */
  party?: Poll<PartyHealth>;
}

const HealthContext = createContext<Health>({ agent: { loading: true } });

export function HealthProvider({ withParty, children }: { withParty: boolean; children: ReactNode }) {
  const live = !config.fixture;
  const agent = usePoll(live ? agentApi.health : null, 3_000);
  const party = usePoll(live && withParty ? partyApi.health : null, 3_000);
  return <HealthContext.Provider value={{ agent, party: withParty ? party : undefined }}>{children}</HealthContext.Provider>;
}

export const useHealth = () => useContext(HealthContext);

type Level = 'ok' | 'down' | 'unknown';

function level(p: Poll<{ ok: boolean }> | undefined): Level {
  if (config.fixture) return 'ok';
  if (!p || p.loading) return 'unknown';
  return p.error || !p.data?.ok ? 'down' : 'ok';
}

const DOT: Record<Level, string> = {
  ok: 'bg-emerald-500',
  down: 'bg-red-500',
  unknown: 'bg-slate-300 animate-pulse',
};

function Dot({ label, level: l, title }: { label: string; level: Level; title?: string }) {
  return (
    <span className="inline-flex items-center gap-1.5 text-sm text-slate-600" title={title}>
      <span className={`h-2.5 w-2.5 rounded-full ${DOT[l]}`} />
      {label}
    </span>
  );
}

export function ConnectionDots({ live }: { live: boolean }) {
  const { agent, party } = useHealth();
  const agentLevel = level(agent);
  const aiLevel: Level =
    config.fixture ? 'ok' : agentLevel !== 'ok' ? 'unknown' : agent.data?.aiUp ? 'ok' : 'down';

  return (
    <div className="flex items-center gap-4">
      <Dot label="Agent" level={agentLevel} title={config.agentUrl} />
      <Dot label="Live" level={config.fixture || live ? 'ok' : agentLevel === 'down' ? 'down' : 'unknown'} title="Live updates" />
      <Dot label="AI" level={aiLevel} title="Local QVAC model (reported by the agent)" />
      {party && <Dot label="Wallet" level={level(party)} title={config.partyUrl} />}
      {config.fixture && <span className="rounded bg-amber-100 px-2 py-0.5 text-xs font-semibold text-amber-800">fixture data</span>}
    </div>
  );
}

/** Explains what is unreachable, instead of leaving the screen blank. */
export function HealthBanner() {
  const { agent, party } = useHealth();
  const problems: string[] = [];
  if (level(agent) === 'down') problems.push(`Escrow agent not reachable at ${config.agentUrl}.`);
  if (party && level(party) === 'down') problems.push(`Your wallet server is not reachable at ${config.partyUrl}.`);
  if (!problems.length) return null;
  return (
    <div role="alert" className="border-b border-red-200 bg-red-50 px-6 py-2 text-sm text-red-800">
      {problems.join(' ')} Retrying every 3 seconds.
    </div>
  );
}
