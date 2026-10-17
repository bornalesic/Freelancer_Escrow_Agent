// Typed clients for the agent (CONTRACTS.md §4, :4000) and this screen's party server (:4101/:4102).
import {
  AGENT_ROUTES,
  PARTY_ROUTES,
  type AcceptRequest,
  type AgentHealthResponse,
  type ApproveRequest,
  type AssetBalance,
  type ConfigResponse,
  type CreateEscrowRequest,
  type CreateEscrowResponse,
  type DeliveryFilesResponse,
  type DevMineResponse,
  type Escrow,
  type EscrowDetailResponse,
  type InvoiceResponse,
  type PartyHealthResponse,
  type PartyRole,
  type PayResponse,
  type SignResponse,
  type TransferSummary,
  type WalletResponse,
} from '@escrow/shared';
import { config } from '../config';
import { requestJson } from './http';

const agent = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  requestJson<T>(config.agentUrl, path, { body, timeoutMs });
const party = <T>(path: string, body?: unknown, timeoutMs?: number) =>
  requestJson<T>(config.partyUrl, path, { body, timeoutMs });

// Escrow ids come from the agent (`esc_` + hex), but encode anyway: they end up in a URL path.
const id = encodeURIComponent;

export const agentApi = {
  health: () => agent<AgentHealthResponse>(AGENT_ROUTES.health, undefined, 3_000),
  config: () => agent<ConfigResponse>(AGENT_ROUTES.config),
  wallet: () => agent<WalletResponse>(AGENT_ROUTES.wallet, undefined, 5_000),
  listEscrows: () => agent<Escrow[]>(AGENT_ROUTES.escrows),
  getEscrow: (escrowId: string) => agent<EscrowDetailResponse>(AGENT_ROUTES.escrow(id(escrowId))),
  createEscrow: (b: CreateEscrowRequest) => agent<CreateEscrowResponse>(AGENT_ROUTES.escrows, b),
  reparse: (escrowId: string, rawText?: string) => agent<Escrow>(AGENT_ROUTES.reparse(id(escrowId)), { rawText }),
  accept: (escrowId: string, b: AcceptRequest) => agent<Escrow>(AGENT_ROUTES.accept(id(escrowId)), b),
  cancel: (escrowId: string, role: PartyRole) => agent<Escrow>(AGENT_ROUTES.cancel(id(escrowId)), { role }),
  refundInvoice: (escrowId: string, invoice: string) => agent<Escrow>(AGENT_ROUTES.refundInvoice(id(escrowId)), { invoice }),
  funded: (escrowId: string, txid: string) => agent<Escrow>(AGENT_ROUTES.funded(id(escrowId)), { txid }),
  deliver: (escrowId: string, file: File, payoutInvoice: string) => {
    const form = new FormData();
    form.append('payoutInvoice', payoutInvoice);
    form.append('file', file);
    return agent<Escrow>(AGENT_ROUTES.deliveries(id(escrowId)), form, 60_000);
  },
  deliveryFiles: (escrowId: string, n: number) => agent<DeliveryFilesResponse>(AGENT_ROUTES.deliveryFiles(id(escrowId), n)),
  approve: (escrowId: string, b: ApproveRequest) => agent<Escrow>(AGENT_ROUTES.approve(id(escrowId)), b),
  mine: (blocks = 1) => agent<DevMineResponse>(AGENT_ROUTES.devMine, { blocks }),
};

/** Raw delivered file, served by the agent with `Content-Security-Policy: sandbox`. */
export const deliveryFileUrl = (escrowId: string, n: number, path: string) =>
  config.agentUrl + AGENT_ROUTES.deliveryFile(id(escrowId), n, path);

export const partyApi = {
  health: () => party<PartyHealthResponse>(PARTY_ROUTES.health, undefined, 3_000),
  wallet: () => party<WalletResponse>(PARTY_ROUTES.wallet),
  invoice: (assetId: string, amount: string) => party<InvoiceResponse>(PARTY_ROUTES.walletInvoice, { assetId, amount }, 30_000),
  pay: (invoice: string, assetId: string, amount: string) =>
    party<PayResponse>(PARTY_ROUTES.walletPay, { invoice, assetId, amount }, 60_000),
  refresh: () => party<{ ok: boolean }>(PARTY_ROUTES.walletRefresh, {}, 30_000),
  transfers: (assetId: string) =>
    party<TransferSummary[]>(`${PARTY_ROUTES.walletTransfers}?assetId=${encodeURIComponent(assetId)}`),
  sign: (message: string) => party<SignResponse>(PARTY_ROUTES.walletSign, { message }),
};

/** GET /wallet on any party server (the projector reads both parties' balances). */
export const partyWalletAt = (baseUrl: string) => requestJson<WalletResponse>(baseUrl, PARTY_ROUTES.wallet, { timeoutMs: 3_000 });

export function findBalance(wallet: WalletResponse | undefined, assetId: string | undefined): AssetBalance | undefined {
  return assetId ? wallet?.assets.find((a) => a.assetId === assetId) : undefined;
}
