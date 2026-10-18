// Where this screen finds the agent and its own party server (and, on /agent, both party servers).
// Precedence: query param (?agent=&party=&client=&freelancer=) > value remembered this tab > env.
// Remembering the query values in sessionStorage keeps them across reloads and route changes.
// Env defaults that say "localhost" follow the page's own host when it was opened from another laptop.

import { onPageHost } from './lib/pageHost';

const STORAGE_KEY = 'escrow.web.overrides';

interface Overrides {
  agent?: string;
  party?: string;
  client?: string;
  freelancer?: string;
  fixture?: boolean;
}

export interface WebConfig {
  agentUrl: string;
  partyUrl: string;
  /** Party servers shown as small balances on the projector; unset = not shown. */
  clientPartyUrl?: string;
  freelancerPartyUrl?: string;
  /** Render from a local fixture snapshot instead of a live agent (UI work before mocks exist). */
  fixture: boolean;
}

function readStored(): Overrides {
  try {
    return JSON.parse(sessionStorage.getItem(STORAGE_KEY) ?? '{}') as Overrides;
  } catch {
    return {};
  }
}

function writeStored(o: Overrides): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(o));
  } catch {
    // private window or blocked storage: overrides then only last for this page load
  }
}

const trimSlash = (u: string) => u.replace(/\/+$/, '');
const optional = (u?: string) => (u ? trimSlash(u) : undefined);

function load(): WebConfig {
  const q = new URLSearchParams(window.location.search);
  const o = readStored();
  if (q.has('agent')) o.agent = q.get('agent') || undefined;
  if (q.has('party')) o.party = q.get('party') || undefined;
  if (q.has('client')) o.client = q.get('client') || undefined;
  if (q.has('freelancer')) o.freelancer = q.get('freelancer') || undefined;
  if (q.has('fixture')) o.fixture = q.get('fixture') !== '0';
  writeStored(o);
  const env = (u: string | undefined) => (u ? onPageHost(u, window.location.hostname) : undefined);

  return {
    agentUrl: trimSlash(o.agent ?? env(import.meta.env.VITE_AGENT_URL ?? 'http://localhost:4000')!),
    partyUrl: trimSlash(o.party ?? env(import.meta.env.VITE_PARTY_URL ?? 'http://localhost:4101')!),
    clientPartyUrl: optional(o.client ?? env(import.meta.env.CLIENT_PARTY_URL)),
    freelancerPartyUrl: optional(o.freelancer ?? env(import.meta.env.FREELANCER_PARTY_URL)),
    fixture: o.fixture ?? false,
  };
}

export const config: WebConfig = load();

export function agentWsUrl(escrowId?: string): string {
  const u = new URL('/ws', config.agentUrl);
  u.protocol = u.protocol === 'https:' ? 'wss:' : 'ws:';
  if (escrowId) u.searchParams.set('escrowId', escrowId);
  return u.toString();
}
