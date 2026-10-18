// Pure helpers about an escrow's terms, shared by every screen.
import { isAutomaticCondition, termsHash, type Condition, type Escrow, type ExamplesCondition } from '@escrow/shared';

/**
 * Every condition kind the UI renders. `examples` (AI assist plan) is not in `Condition` until WS3 adds it to
 * ConditionSchema; after that this is just `Condition`, so the code below compiles before and after.
 */
export type AnyCondition = Condition | ExamplesCondition;
export const asAny = (c: Condition): AnyCondition => c;
export const isExamples = (c: AnyCondition): c is ExamplesCondition => c.kind === 'examples';

/** Judged by the client (helped by QVAC's opinion), not by the verifier. */
export const isClientReview = (c: Condition) => !isAutomaticCondition(c);

/** Recompute the hash of the terms shown on screen, so a party only accepts exactly what it sees. */
export const termsMatch = (e: Escrow) => !!e.termsHash && termsHash(e) === e.termsHash;
