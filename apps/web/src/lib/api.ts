// Typed clients for the agent (CONTRACTS.md §4, :4000) and this screen's party server (:4101/:4102).
// TODO(shared): switch the path strings to AGENT_ROUTES / PARTY_ROUTES once packages/shared exports them.
import type {
  AgentConfig,
  AgentHealth,
  AssetBalance,
  Escrow,
  LogEvent,
  PartyHealth,
  PartyWallet,
  TransferSummary,
} from '@escrow/shared';
import { config } from '../config';
import { requestJson } from './http';

const agent = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  requestJson<T>(config.agentUrl, path, { body, timeoutMs });
const party = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  requestJson<T>(config.partyUrl, path, { body, timeoutMs });

const id = (escrowId: string) => `/escrows/${encodeURIComponent(escrowId)}`;

export const agentApi = {
  health: () => agent<AgentHealth>('/health', undefined, 3_000),
  config: () => agent<AgentConfig>('/config'),
  listEscrows: () => agent<Escrow[]>('/escrows'),
  getEscrow: (escrowId: string) => agent<{ escrow: Escrow; events: LogEvent[] }>(id(escrowId)),
  createEscrow: (b: { title: string; rawText: string; amount: string; deadline: string }) =>
    agent<Escrow>('/escrows', b),
  reparse: (escrowId: string, rawText?: string) => agent<Escrow>(`${id(escrowId)}/reparse`, { rawText }),
  accept: (escrowId: string, b: { role: 'client' | 'freelancer'; termsHash: string; signature?: string; address?: string }) =>
    agent<Escrow>(`${id(escrowId)}/accept`, b),
  cancel: (escrowId: string, role: 'client' | 'freelancer') => agent<Escrow>(`${id(escrowId)}/cancel`, { role }),
  refundInvoice: (escrowId: string, invoice: string) => agent<Escrow>(`${id(escrowId)}/refund-invoice`, { invoice }),
  funded: (escrowId: string, txid: string) => agent<Escrow>(`${id(escrowId)}/funded`, { txid }),
  deliver: (escrowId: string, file: File, payoutInvoice: string) => {
    const form = new FormData();
    form.append('payoutInvoice', payoutInvoice);
    form.append('file', file);
    return agent<Escrow>(`${id(escrowId)}/deliveries`, form, 60_000);
  },
  mine: (blocks = 1) => agent<{ height: number }>('/dev/mine', { blocks }),
};

export const partyApi = {
  health: () => party<PartyHealth>('/health', undefined, 3_000),
  wallet: () => party<PartyWallet>('/wallet'),
  invoice: (assetId: string, amount: string) =>
    party<{ invoice: string; recipientId: string; expiresAt?: string }>('/wallet/invoice', { assetId, amount }, 30_000),
  pay: (invoice: string, assetId: string, amount: string) =>
    party<{ txid: string }>('/wallet/pay', { invoice, assetId, amount }, 60_000),
  refresh: () => party<{ ok: boolean }>('/wallet/refresh', {}, 30_000),
  transfers: (assetId: string) => party<TransferSummary[]>(`/wallet/transfers?assetId=${encodeURIComponent(assetId)}`),
  sign: (message: string) => party<{ signature: string; address: string }>('/wallet/sign', { message }),
};

export function findBalance(wallet: PartyWallet | undefined, assetId: string | undefined): AssetBalance | undefined {
  return assetId ? wallet?.assets.find((a) => a.assetId === assetId) : undefined;
}
