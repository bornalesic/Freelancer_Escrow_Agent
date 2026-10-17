// Base-unit <-> display conversions. bigint-safe; amounts are decimal strings everywhere in JSON.

/** toBaseUnits("50", 6) -> "50000000"; toBaseUnits("0.5", 6) -> "500000". Throws on bad input. */
export function toBaseUnits(display: string, precision: number): string {
  const s = display.trim();
  const m = /^(\d+)(?:\.(\d*))?$/.exec(s);
  if (!m) throw new Error(`invalid amount: "${display}"`);
  const whole = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > precision) throw new Error(`amount "${display}" has more than ${precision} decimals`);
  const base = BigInt(whole) * 10n ** BigInt(precision) + BigInt(frac.padEnd(precision, '0') || '0');
  return base.toString();
}

/** formatAmount("50000000", 6) -> "50"; formatAmount("50500000", 6) -> "50.5". */
export function formatAmount(base: string, precision: number): string {
  const v = BigInt(base);
  if (precision === 0) return v.toString();
  const neg = v < 0n;
  const abs = neg ? -v : v;
  const unit = 10n ** BigInt(precision);
  const whole = abs / unit;
  const frac = (abs % unit).toString().padStart(precision, '0').replace(/0+$/, '');
  return `${neg ? '-' : ''}${whole}${frac ? `.${frac}` : ''}`;
}
