// Where this screen finds the agent and its own party server.
// Precedence: query param (?agent=&party=) > value remembered this tab > VITE_* env.
// Remembering the query values in sessionStorage keeps them across reloads and route changes.

const STORAGE_KEY = 'escrow.web.overrides';

interface Overrides {
  agent?: string;
  party?: string;
  fixture?: boolean;
}

export interface WebConfig {
  agentUrl: string;
  partyUrl: string;
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

function load(): WebConfig {
  const q = new URLSearchParams(window.location.search);
  const o = readStored();
  if (q.has('agent')) o.agent = q.get('agent') || undefined;
  if (q.has('party')) o.party = q.get('party') || undefined;
  if (q.has('fixture')) o.fixture = q.get('fixture') !== '0';
  writeStored(o);

  return {
    agentUrl: trimSlash(o.agent ?? import.meta.env.VITE_AGENT_URL ?? 'http://localhost:4000'),
    partyUrl: trimSlash(o.party ?? import.meta.env.VITE_PARTY_URL ?? 'http://localhost:4101'),
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
