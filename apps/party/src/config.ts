// Env -> Config for one party server. Config comes only from env vars listed in .env.example.

import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import { PartyRoleSchema, WalletModeSchema, type PartyRole, type WalletMode } from '@escrow/shared'

/** apps/party/src -> repo root, where .env.local lives. */
export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')

const DEFAULT_PORT: Record<PartyRole, number> = { client: 4101, freelancer: 4102 }
const DEFAULT_POLL_MS = 3_000

export interface Config {
  role: PartyRole
  port: number
  walletMode: WalletMode
  /** How often the background loop refreshes while a transfer is in flight (WALLET_POLL_MS). */
  pollMs: number
  /** The escrow agent (AGENT_URL): auto-pay reads the client's jobs there and attaches refund invoices. */
  agentUrl: string
  /** This role's own state (auto-pay authorisations): apps/party/data/<role>. */
  dataDir: string
}

function str(env: NodeJS.ProcessEnv, name: string): string | undefined {
  const raw = env[name]?.trim()
  return raw === undefined || raw === '' ? undefined : raw
}

function positiveInt(env: NodeJS.ProcessEnv, name: string, fallback: number): number {
  const raw = str(env, name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n <= 0) throw new Error(`${name} must be a positive integer, got "${raw}"`)
  return n
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  // No default role: a freelancer laptop that silently came up as the client would pay from the
  // wrong wallet.
  const role = PartyRoleSchema.safeParse(str(env, 'ROLE'))
  if (!role.success) throw new Error(`ROLE must be "client" or "freelancer", got "${env['ROLE'] ?? ''}"`)

  const mode = WalletModeSchema.safeParse(str(env, 'WALLET_MODE') ?? 'mock')
  if (!mode.success) throw new Error(`WALLET_MODE must be "mock" or "real", got "${env['WALLET_MODE'] ?? ''}"`)

  return {
    role: role.data,
    port: positiveInt(env, 'PARTY_PORT', DEFAULT_PORT[role.data]),
    walletMode: mode.data,
    pollMs: positiveInt(env, 'WALLET_POLL_MS', DEFAULT_POLL_MS),
    agentUrl: (str(env, 'AGENT_URL') ?? 'http://localhost:4000').replace(/\/$/, ''),
    dataDir: resolve(REPO_ROOT, 'apps/party/data', role.data),
  }
}
