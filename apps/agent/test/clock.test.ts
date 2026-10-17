import { afterEach, describe, expect, it, vi } from 'vitest';
import type { Condition, Delivery } from '@escrow/shared';
import { decide } from '../src/decide';
import { safeNow } from '../src/util';

// On WSL the wall clock steps: ~3 s on this laptop, ~96 s on WS1's (packages/wallet/CLAUDE.md).
// A step must never make the agent release (review window) or refund (deadline) early.
const JUMP_MS = 96_700;

describe('safeNow', () => {
  afterEach(() => vi.restoreAllMocks());

  it('is never later than the wall clock', () => {
    expect(safeNow().getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('ignores a forward jump of the wall clock', () => {
    const before = safeNow().getTime();
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + JUMP_MS);
    expect(safeNow().getTime() - before).toBeLessThan(1000);
  });

  it('follows a backward jump (acting late is safe, acting early is not)', () => {
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() - JUMP_MS);
    expect(safeNow().getTime()).toBeLessThanOrEqual(Date.now());
  });

  it('a forward jump does not close a 120 s review window that has 60 s left', () => {
    const conditions: Condition[] = [{ id: 'c1', kind: 'client_review', description: 'Warm colours' }];
    const delivery: Delivery = {
      n: 1, fileName: 'f.zip', sha256: 'a'.repeat(64), sizeBytes: 1, at: new Date().toISOString(),
      reviewDueAt: new Date(safeNow().getTime() + 60_000).toISOString(),
    };
    const escrow = { state: 'AWAITING_APPROVAL' as const, deadline: new Date(Date.now() + 3_600_000).toISOString(), conditions, deliveries: [delivery] };
    const real = Date.now;
    vi.spyOn(Date, 'now').mockImplementation(() => real() + JUMP_MS);
    expect(decide(escrow, [], new Date(Date.now())).action).toBe('release'); // what the wall clock alone would do
    expect(decide(escrow, [], safeNow()).action).toBe('wait'); // what the agent does
  });
});
