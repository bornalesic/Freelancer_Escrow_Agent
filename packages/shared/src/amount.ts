// Amount helpers. Money is always bigint in code and a decimal string of base units in JSON.

function checkPrecision(precision: number): void {
  if (!Number.isInteger(precision) || precision < 0 || precision > 18) {
    throw new Error(`Invalid precision: ${precision}`);
  }
}

/** "50.5" with precision 6 → "50500000". Throws on bad input or too many decimals. */
export function toBaseUnits(display: string, precision: number): string {
  checkPrecision(precision);
  const m = /^(\d+)(?:\.(\d*))?$/.exec(display.trim());
  if (!m) throw new Error(`Invalid amount: "${display}"`);
  const int = m[1]!;
  const frac = m[2] ?? '';
  if (frac.length > precision && /[^0]/.test(frac.slice(precision))) {
    throw new Error(`Amount "${display}" has more than ${precision} decimals`);
  }
  return BigInt(int + frac.slice(0, precision).padEnd(precision, '0')).toString();
}

/** "50500000" with precision 6 → "50.5". */
export function formatAmount(base: string | bigint, precision: number): string {
  checkPrecision(precision);
  const v = BigInt(base);
  const neg = v < 0n;
  const digits = (neg ? -v : v).toString().padStart(precision + 1, '0');
  const int = digits.slice(0, digits.length - precision);
  const frac = digits.slice(digits.length - precision).replace(/0+$/, '');
  return (neg ? '-' : '') + int + (frac ? `.${frac}` : '');
}
