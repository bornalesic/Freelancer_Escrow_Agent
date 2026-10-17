/** One-line console logging. Never pass secrets (mnemonics) to these. */
const ts = () => new Date().toISOString().slice(11, 23);

export const log = {
  info: (msg: string) => console.log(`${ts()} [agent] ${msg}`),
  warn: (msg: string) => console.warn(`${ts()} [agent] WARN ${msg}`),
  error: (msg: string) => console.error(`${ts()} [agent] ERROR ${msg}`),
};
