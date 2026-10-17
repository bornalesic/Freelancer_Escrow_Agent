import { describe, expect, it } from 'vitest';
import { formatAmount, toBaseUnits } from './amount.ts';

describe('amount', () => {
  it('converts display to base units', () => {
    expect(toBaseUnits('50', 6)).toBe('50000000');
    expect(toBaseUnits('0.5', 6)).toBe('500000');
    expect(toBaseUnits('7', 0)).toBe('7');
    expect(toBaseUnits('12345678901234567890', 6)).toBe('12345678901234567890000000');
  });

  it('rejects bad input', () => {
    expect(() => toBaseUnits('1.1234567', 6)).toThrow();
    expect(() => toBaseUnits('abc', 6)).toThrow();
    expect(() => toBaseUnits('-1', 6)).toThrow();
  });

  it('formats base units for display', () => {
    expect(formatAmount('50000000', 6)).toBe('50');
    expect(formatAmount('50500000', 6)).toBe('50.5');
    expect(formatAmount('1', 6)).toBe('0.000001');
    expect(formatAmount('0', 6)).toBe('0');
    expect(formatAmount('42', 0)).toBe('42');
  });
});
