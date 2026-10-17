// Shared helpers for the demo setup scripts (setup-demo, setup-role, reset-demo). Run them with tsx from
// the repo root, inside WSL Ubuntu 24.04: the RGB wallet's native library needs glibc >= 2.38.
// Nothing here prints a mnemonic.

import { chmodSync, existsSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import net from 'node:net'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

import type { EscrowWallet, Role } from '@escrow/shared'

export const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..')
export const DEFAULT_ENV_FILE = join(REPO_ROOT, '.env.local')

export const sleep = (ms: number) => new Promise<void>((r) => { setTimeout(r, ms) })
export const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err))
export const step = (title: string) => console.log(`\n== ${title}`)
export const say = (line: string) => console.log(`   ${line}`)

// ---------------------------------------------------------------- arguments

export type Args = Map<string, string | true>

/** `--name value`, `--name=value` and bare `--switch`. */
export function parseArgs(argv: string[]): Args {
  const args: Args = new Map()
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i] ?? ''
    if (!arg.startsWith('--')) throw new Error(`unexpected argument "${arg}" (options look like --name value)`)
    const eq = arg.indexOf('=')
    if (eq > 0) {
      args.set(arg.slice(2, eq), arg.slice(eq + 1))
      continue
    }
    const next = argv[i + 1]
    if (next !== undefined && !next.startsWith('--')) {
      args.set(arg.slice(2), next)
      i += 1
    } else {
      args.set(arg.slice(2), true)
    }
  }
  return args
}

export function stringArg(args: Args, name: string): string | undefined {
  const value = args.get(name)
  if (value === true) throw new Error(`--${name} needs a value`)
  return value
}

// ---------------------------------------------------------------- env file

export function envFileFrom(args: Args): string {
  const file = stringArg(args, 'env-file')
  return file === undefined ? DEFAULT_ENV_FILE : resolve(file)
}

/** Load the env file into process.env. Values already set win, as in the servers. */
export function loadEnv(file: string): void {
  if (existsSync(file)) process.loadEnvFile(file)
}

export function env(name: string): string | undefined {
  const value = process.env[name]?.trim()
  return value === undefined || value === '' ? undefined : value
}

export function requiredEnv(name: string): string {
  const value = env(name)
  if (value === undefined) throw new Error(`${name} is not set: copy it from .env.example into .env.local`)
  return value
}

export function intEnv(name: string, fallback: number): number {
  const raw = env(name)
  if (raw === undefined) return fallback
  const n = Number(raw)
  if (!Number.isInteger(n) || n < 0) throw new Error(`${name} must be a non-negative integer, got "${raw}"`)
  return n
}

function readLines(file: string): string[] {
  const text = existsSync(file) ? readFileSync(file, 'utf8') : ''
  return text === '' ? [] : text.replace(/\n$/, '').split('\n')
}

function writeLines(file: string, lines: string[]): void {
  // 0600 and through a temp file: this file holds mnemonics.
  const tmp = `${file}.tmp`
  writeFileSync(tmp, lines.length === 0 ? '' : `${lines.join('\n')}\n`, { mode: 0o600 })
  renameSync(tmp, file)
  chmodSync(file, 0o600)
}

const lineFor = (key: string) => new RegExp(`^\\s*${key}\\s*=`)

// A mnemonic is twelve words: unquoted, Node's parser still reads it, but `source .env.local` in a
// shell stops at the first space.
const envValue = (value: string) => (/[\s#'"]/.test(value) ? `"${value}"` : value)

/** Set `KEY=value` in the env file (replacing the line, or appending one) and in process.env. */
export function writeEnv(file: string, values: Record<string, string>): void {
  const lines = readLines(file)
  for (const [key, value] of Object.entries(values)) {
    const line = `${key}=${envValue(value)}`
    const at = lines.findIndex((existing) => lineFor(key).test(existing))
    if (at >= 0) lines[at] = line
    else lines.push(line)
    process.env[key] = value
  }
  writeLines(file, lines)
}

/** Remove `KEY=` lines from the env file and the keys from process.env. */
export function removeEnv(file: string, keys: string[]): void {
  writeLines(file, readLines(file).filter((line) => !keys.some((key) => lineFor(key).test(line))))
  for (const key of keys) delete process.env[key]
}

/** RGB_TRANSPORT_ENDPOINT is written into every invoice: localhost there only works on one laptop. */
export function warnIfLocalhost(name: string, why: string): void {
  const value = env(name)
  if (value !== undefined && /\/\/(localhost|127\.0\.0\.1)[:/]/.test(value)) {
    console.log(`\n   WARNING ${name}=${value}\n   ${why}\n`)
  }
}

// ---------------------------------------------------------------- bitcoind (regtest)

const MINER = 'miner'

export class Bitcoind {
  readonly #url = env('BITCOIND_RPC_URL') ?? 'http://localhost:18443'
  // Fixed in the regtest image (scripts/regtest/README.md); Node's fetch() refuses them in the URL.
  readonly #auth = 'Basic ' + Buffer.from(`${env('BITCOIND_RPC_USER') ?? 'user'}:${env('BITCOIND_RPC_PASS') ?? 'default_password'}`).toString('base64')
  #minerAddress: string | undefined

  async call<T>(method: string, params: unknown[] = [], wallet?: string): Promise<T> {
    let res: Response
    try {
      res = await fetch(wallet === undefined ? this.#url : `${this.#url}/wallet/${wallet}`, {
        method: 'POST',
        headers: { 'content-type': 'text/plain;', authorization: this.#auth },
        body: JSON.stringify({ jsonrpc: '1.0', id: 'escrow-setup', method, params }),
        signal: AbortSignal.timeout(30_000),
      })
    } catch (err) {
      throw new Error(`bitcoind at ${this.#url} did not answer (is the regtest stack up?): ${errorMessage(err)}`)
    }
    const body = (await res.json()) as { result: T; error: { message?: string } | null }
    if (body.error) throw new Error(`bitcoind ${method}: ${body.error.message ?? JSON.stringify(body.error)}`)
    return body.result
  }

  /** The containers restart whenever the WSL distro comes back from idle; bitcoind needs a moment. */
  async waitUntilUp(timeoutMs = 60_000): Promise<void> {
    const deadline = performance.now() + timeoutMs
    for (;;) {
      try {
        await this.call<number>('getblockcount')
        return
      } catch (err) {
        if (performance.now() > deadline) throw err
        await sleep(1_000)
      }
    }
  }

  /** The `miner` wallet survives a container restart but is not loaded again: load it, or create it once. */
  async ensureMinerWallet(): Promise<void> {
    if ((await this.call<string[]>('listwallets')).includes(MINER)) return
    const onDisk = (await this.call<{ wallets: { name: string }[] }>('listwalletdir')).wallets.map((w) => w.name)
    await this.call(onDisk.includes(MINER) ? 'loadwallet' : 'createwallet', [MINER])
  }

  height(): Promise<number> {
    return this.call<number>('getblockcount')
  }

  async mine(blocks: number): Promise<void> {
    this.#minerAddress ??= await this.call<string>('getnewaddress', [], MINER)
    await this.call('generatetoaddress', [blocks, this.#minerAddress], MINER)
  }

  /** An ordinary output from the miner wallet: unlike a coinbase, spendable at once. */
  send(address: string, btc: number): Promise<string> {
    return this.call<string>('sendtoaddress', [address, btc], MINER)
  }
}

// ---------------------------------------------------------------- network checks

function electrumAnswers(host: string, port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = net.createConnection({ host, port })
    let buffer = ''
    const finish = (ok: boolean) => {
      sock.destroy()
      done(ok)
    }
    sock.setTimeout(3_000, () => { finish(false) })
    sock.on('error', () => { finish(false) })
    sock.on('connect', () => { sock.write('{"jsonrpc":"2.0","method":"server.version","params":["escrow-setup","1.4"],"id":1}\n') })
    sock.on('data', (chunk) => {
      buffer += chunk.toString()
      if (buffer.includes('\n')) finish(buffer.includes('"result"'))
    })
  })
}

/** electrs accepts TCP at once but answers only once the chain is past height 0 and indexed. */
export async function waitForIndexer(indexerUrl: string, timeoutMs = 90_000): Promise<void> {
  const match = /^tcp:\/\/([^:/]+):(\d+)$/.exec(indexerUrl)
  if (match === null) return // an esplora URL (signet): nothing to probe this way
  const deadline = performance.now() + timeoutMs
  while (!(await electrumAnswers(match[1] ?? '', Number(match[2])))) {
    if (performance.now() > deadline) {
      throw new Error(`the indexer at ${indexerUrl} does not answer: is the regtest stack up, and reachable from this laptop?`)
    }
    await sleep(1_000)
  }
}

/** True if something accepts TCP on localhost:port. */
export function portInUse(port: number): Promise<boolean> {
  return new Promise((done) => {
    const sock = net.createConnection({ host: '127.0.0.1', port })
    const finish = (inUse: boolean) => {
      sock.destroy()
      done(inUse)
    }
    sock.setTimeout(1_000, () => { finish(false) })
    sock.on('connect', () => { finish(true) })
    sock.on('error', () => { finish(false) })
  })
}

// ---------------------------------------------------------------- wallets

/** What the scripts use on top of EscrowWallet (both exist on RgbWdkWallet). */
export type SetupWallet = EscrowWallet & { freeUtxoCount(): Promise<number>; dispose(): void }

export const mnemonicKey = (role: string) => `${role.toUpperCase()}_MNEMONIC`

/** Same rule as createWallet(): one directory per role under RGB_DATA_DIR, relative to the repo root. */
export const walletDir = (role: string) => resolve(REPO_ROOT, join(env('RGB_DATA_DIR') ?? './.wallets', role))

/** Fresh mnemonics for the keys that have none, saved to the env file. Returns the keys created. */
export async function ensureMnemonics(file: string, keys: string[]): Promise<string[]> {
  const missing = keys.filter((key) => env(key) === undefined)
  if (missing.length > 0) {
    const { newMnemonic } = await import('@escrow/wallet/treasury')
    writeEnv(file, Object.fromEntries(missing.map((key) => [key, newMnemonic()])))
  }
  return missing
}

/**
 * Open a role's real wallet. Before it has BTC, init() opens and registers it but cannot create the
 * UTXOs -- expected here, so `funded: false` instead of an error.
 */
export async function openRoleWallet(role: Role): Promise<{ wallet: SetupWallet; funded: boolean }> {
  const { createWallet } = await import('@escrow/wallet')
  const wallet = (await createWallet({ role, mode: 'real' })) as SetupWallet
  try {
    await wallet.init()
    return { wallet, funded: true }
  } catch (err) {
    if (!/not enough BTC/.test(errorMessage(err))) throw err
    return { wallet, funded: false }
  }
}

/** The connection settings createWallet() would use, for the treasury (not an EscrowWallet role). */
export function rgbConnection(role: string) {
  return {
    network: env('RGB_NETWORK') ?? 'regtest',
    mnemonic: requiredEnv(mnemonicKey(role)),
    dataDir: walletDir(role),
    indexerUrl: requiredEnv('RGB_INDEXER_URL'),
    transportEndpoint: requiredEnv('RGB_TRANSPORT_ENDPOINT'),
    maxFeeSat: intEnv('MAX_FEE_SAT', 5_000),
    feeRate: intEnv('FEE_RATE', 2),
    minConfirmations: intEnv('MIN_CONFIRMATIONS', 1),
  }
}

// ---------------------------------------------------------------- HTTP

export async function getJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(10_000) })
  if (!res.ok) throw new Error(`GET ${url}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

export async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
    signal: AbortSignal.timeout(30_000),
  })
  if (!res.ok) throw new Error(`POST ${url}: HTTP ${res.status} ${await res.text()}`)
  return (await res.json()) as T
}

/** Run `main` when this file is the script tsx was started with (not when another script imports it). */
export function runIfMain(importMetaUrl: string, name: string, main: (argv: string[]) => Promise<void>): void {
  const entry = process.argv[1]
  if (entry === undefined || resolve(entry) !== fileURLToPath(importMetaUrl)) return
  main(process.argv.slice(2)).then(
    // Exit explicitly: the native wallet library can keep the event loop alive.
    () => process.exit(0),
    (err: unknown) => {
      console.error(`\n${name} failed: ${errorMessage(err)}`)
      process.exit(1)
    },
  )
}
