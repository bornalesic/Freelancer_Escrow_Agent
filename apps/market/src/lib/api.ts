// Typed clients for the escrow agent and this laptop's party servers (docs/CONTRACTS.md §4).
import {
  AGENT_ROUTES,
  ESCROW_TOKEN_HEADER,
  PARTY_ROUTES,
  type AgentHealthResponse,
  type ApproveRequest,
  type AutopayStatus,
  type ConfigResponse,
  type CreateEscrowRequest,
  type CreateEscrowResponse,
  type DeliveryFilesResponse,
  type Escrow,
  type InvoiceResponse,
  type MakeOfferResponse,
  type PartyHealthResponse,
  type PartyRole,
  type TakeResponse,
  type TransferSummary,
  type WalletResponse,
} from '@escrow/shared';
import { config } from './config';
import { requestBlobUrl, requestJson, type RequestOptions } from './http';

const agent = <T>(path: string, opts?: RequestOptions) => requestJson<T>(config.agentUrl, path, opts);
const id = encodeURIComponent;
const tokenHeader = (token: string | undefined) => (token ? { [ESCROW_TOKEN_HEADER]: token } : undefined);

export const agentApi = {
  health: () => agent<AgentHealthResponse>(AGENT_ROUTES.health, { timeoutMs: 3_000 }),
  config: () => agent<ConfigResponse>(AGENT_ROUTES.config),
  /** The escrow service's own wallet (what it holds for all jobs). Never a party's wallet. */
  wallet: () => agent<WalletResponse>(AGENT_ROUTES.wallet, { timeoutMs: 5_000 }),
  /** Dev only (refused in production): deletes every job on the agent. Wallets are untouched. */
  devReset: () => agent<{ ok: boolean }>(AGENT_ROUTES.devReset, { body: {} }),
  list: () => agent<Escrow[]>(AGENT_ROUTES.escrows),
  create: (body: CreateEscrowRequest) => agent<CreateEscrowResponse>(AGENT_ROUTES.escrows, { body }),
  reparse: (escrowId: string, rawText: string, clientToken: string) =>
    agent<Escrow>(AGENT_ROUTES.reparse(id(escrowId)), { body: { rawText, clientToken } }),
  publish: (escrowId: string, termsHash: string, clientToken: string) =>
    agent<Escrow>(AGENT_ROUTES.publish(id(escrowId)), { body: { termsHash, clientToken } }),
  take: (escrowId: string, termsHash: string) => agent<TakeResponse>(AGENT_ROUTES.take(id(escrowId)), { body: { termsHash } }),
  makeOffer: (escrowId: string, termsHash: string, amount: string, note?: string) =>
    agent<MakeOfferResponse>(AGENT_ROUTES.offers(id(escrowId)), { body: { termsHash, amount, ...(note ? { note } : {}) } }),
  acceptOffer: (escrowId: string, offerId: string, termsHash: string, clientToken: string) =>
    agent<Escrow>(AGENT_ROUTES.acceptOffer(id(escrowId), id(offerId)), { body: { termsHash, clientToken } }),
  withdrawOffer: (escrowId: string, offerId: string, offerToken: string) =>
    agent<Escrow>(AGENT_ROUTES.withdrawOffer(id(escrowId), id(offerId)), { body: { offerToken } }),
  cancel: (escrowId: string, role: PartyRole, token: string | undefined) =>
    agent<Escrow>(AGENT_ROUTES.cancel(id(escrowId)), { body: { role, ...(token ? { token } : {}) } }),
  approve: (escrowId: string, body: ApproveRequest) => agent<Escrow>(AGENT_ROUTES.approve(id(escrowId)), { body }),
  deliver: (escrowId: string, file: File, payoutInvoice: string, freelancerToken: string) => {
    const form = new FormData();
    form.set('payoutInvoice', payoutInvoice);
    form.set('freelancerToken', freelancerToken);
    form.set('file', file);
    return agent<Escrow>(AGENT_ROUTES.deliveries(id(escrowId)), { body: form, timeoutMs: 120_000 });
  },
  files: (escrowId: string, n: number, token?: string) =>
    agent<DeliveryFilesResponse>(AGENT_ROUTES.deliveryFiles(id(escrowId), n), { headers: tokenHeader(token) }),
  fileUrl: (escrowId: string, n: number, path: string, token?: string) =>
    requestBlobUrl(config.agentUrl, AGENT_ROUTES.deliveryFile(id(escrowId), n, path), tokenHeader(token)),
};

/** This laptop's party server for `role`. Balance, history and auto-pay answer only this laptop. */
export const partyApi = (role: PartyRole) => {
  const party = <T>(path: string, opts?: RequestOptions) => requestJson<T>(config.partyUrl[role], path, opts);
  return {
    health: () => party<PartyHealthResponse>(PARTY_ROUTES.health, { timeoutMs: 3_000 }),
    wallet: () => party<WalletResponse>(PARTY_ROUTES.wallet, { timeoutMs: 5_000 }),
    transfers: (assetId: string) => party<TransferSummary[]>(`${PARTY_ROUTES.walletTransfers}?assetId=${encodeURIComponent(assetId)}`),
    invoice: (assetId: string, amount: string, expiresInSec: number) =>
      party<InvoiceResponse>(PARTY_ROUTES.walletInvoice, { body: { assetId, amount, expiresInSec }, timeoutMs: 30_000 }),
    autopay: (escrowId: string, clientToken: string) =>
      party<AutopayStatus>(PARTY_ROUTES.autopay, { body: { escrowId, clientToken }, timeoutMs: 15_000 }),
    autopayList: () => party<AutopayStatus[]>(PARTY_ROUTES.autopay),
  };
};
