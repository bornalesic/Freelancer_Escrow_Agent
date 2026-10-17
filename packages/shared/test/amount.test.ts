import { describe, expect, it } from 'vitest';
import { formatAmount, toBaseUnits } from '../src/amount.ts';
import { eventId, newEscrowId } from '../src/ids.ts';

describe('toBaseUnits', () => {
  it.each([
    ['50', 6, '50000000'],
    ['50.5', 6, '50500000'],
    ['0.000001', 6, '1'],
    ['  7 ', 0, '7'],
    ['007.10', 2, '710'],
    ['1.500000000', 6, '1500000'], // extra trailing zeros are fine
    ['50.', 6, '50000000'],
    ['123456789012345678901234567890', 6, '123456789012345678901234567890000000'],
  ])('%s @%i → %s', (display, precision, expected) => {
    expect(toBaseUnits(display, precision)).toBe(expected);
  });
  it.each(['', 'abc', '-1', '1e6', '.5', '1.2.3'])('rejects %j', (bad) => {
    expect(() => toBaseUnits(bad, 6)).toThrow();
  });
  it('rejects too many decimals', () => {
    expect(() => toBaseUnits('1.0000001', 6)).toThrow(/decimals/);
    expect(() => toBaseUnits('1.5', 0)).toThrow(/decimals/);
  });
  it('rejects bad precision', () => {
    expect(() => toBaseUnits('1', -1)).toThrow();
    expect(() => toBaseUnits('1', 1.5)).toThrow();
  });
});

describe('formatAmount', () => {
  it.each([
    ['50000000', 6, '50'],
    ['50500000', 6, '50.5'],
    ['1', 6, '0.000001'],
    ['0', 6, '0'],
    ['7', 0, '7'],
    ['100', 0, '100'],
    ['123456789012345678901234567890', 6, '123456789012345678901234.56789'],
  ])('%s @%i → %s', (base, precision, expected) => {
    expect(formatAmount(base, precision)).toBe(expected);
  });
  it('accepts bigint and negative values', () => {
    expect(formatAmount(1500000n, 6)).toBe('1.5');
    expect(formatAmount('-1500000', 6)).toBe('-1.5');
  });
  it('round-trips with toBaseUnits', () => {
    for (const s of ['0.1', '42', '3.141592']) expect(formatAmount(toBaseUnits(s, 6), 6)).toBe(s);
  });
});

describe('ids', () => {
  it('newEscrowId has the right shape', () => {
    expect(newEscrowId()).toMatch(/^esc_[0-9a-f]{4}$/);
  });
  it('eventId pads the sequence', () => {
    expect(eventId('esc_7f3a', 7)).toBe('esc_7f3a:0007');
  });
});
