// Pure helpers about an escrow's terms, shared by every screen.
import { isAutomaticCondition, termsHash, type Condition, type Escrow } from '@escrow/shared';

/** Judged by the client (helped by QVAC's opinion), not by the verifier. */
export const isClientReview = (c: Condition) => !isAutomaticCondition(c);

/** Recompute the hash of the terms shown on screen, so a party only accepts exactly what it sees. */
export const termsMatch = (e: Escrow) => !!e.termsHash && termsHash(e) === e.termsHash;
