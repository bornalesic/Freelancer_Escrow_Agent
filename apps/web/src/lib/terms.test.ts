import { describe, expect, it } from 'vitest';
import { fixtureEscrow, reviewFixtureEscrow } from '../fixtures/snapshot';
import { isClientReview, termsMatch } from './terms';

describe('termsMatch', () => {
  it('accepts terms whose hash the browser can recompute', () => {
    expect(termsMatch(fixtureEscrow)).toBe(true);
    expect(termsMatch(reviewFixtureEscrow)).toBe(true);
  });

  it('rejects terms that differ from the hash (e.g. a changed command or amount)', () => {
    const [c1, ...rest] = fixtureEscrow.conditions;
    expect(termsMatch({ ...fixtureEscrow, conditions: [{ ...c1, description: 'changed' }, ...rest] })).toBe(false);
    expect(termsMatch({ ...fixtureEscrow, amount: '1' })).toBe(false);
    expect(termsMatch({ ...fixtureEscrow, termsHash: undefined })).toBe(false);
  });

  it('ignores fields outside the terms (state, deliveries)', () => {
    expect(termsMatch({ ...fixtureEscrow, state: 'RELEASED', deliveries: [] })).toBe(true);
  });
});

describe('isClientReview', () => {
  it('is true only for client_review conditions', () => {
    expect(reviewFixtureEscrow.conditions.map(isClientReview)).toEqual([false, false, true]);
  });
});
