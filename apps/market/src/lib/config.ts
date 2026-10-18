// Where this screen finds the escrow agent and this laptop's two party servers (one wallet per role:
// everyone can enter as either). Precedence: query parameter (?agent= ?client= ?freelancer=, remembered
// for the tab) > VITE_* env from the repo-root .env.local > localhost defaults.
import type { PartyRole } from '@escrow/shared';

const env = import.meta.env;
const strip = (url: string) => url.trim().replace(/\/$/, '');

function setting(param: string, fromEnv: string | undefined, fallback: string): string {
  const key = `market.url.${param}`;
  const fromQuery = new URLSearchParams(window.location.search).get(param);
  try {
    if (fromQuery) sessionStorage.setItem(key, fromQuery);
    const remembered = sessionStorage.getItem(key);
    if (remembered) return strip(remembered);
  } catch {
    // storage blocked: the query parameter still works for this page load
  }
  return strip(fromQuery ?? fromEnv ?? fallback);
}

export const config = {
  agentUrl: setting('agent', env.VITE_AGENT_URL, 'http://localhost:4000'),
  partyUrl: {
    client: setting('client', env.VITE_CLIENT_PARTY_URL, 'http://localhost:4101'),
    freelancer: setting('freelancer', env.VITE_FREELANCER_PARTY_URL, 'http://localhost:4102'),
  } satisfies Record<PartyRole, string>,
};

export const agentWsUrl = () => `${config.agentUrl.replace(/^http/, 'ws')}/ws`;
