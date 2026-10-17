/** One-line console logging. Never pass secrets (mnemonics) to these. */
const ts = () => new Date().toISOString().slice(11, 23)

export interface Log {
  info(msg: string): void
  warn(msg: string): void
  error(msg: string): void
}

export function makeLog(tag: string): Log {
  return {
    info: (msg) => console.log(`${ts()} [${tag}] ${msg}`),
    warn: (msg) => console.warn(`${ts()} [${tag}] WARN ${msg}`),
    error: (msg) => console.error(`${ts()} [${tag}] ERROR ${msg}`),
  }
}
