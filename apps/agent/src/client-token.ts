import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * The client's proof for `POST /escrows/:id/approve`. Returned once by `POST /escrows`; the agent keeps
 * only its sha256 (in the store's internal record). Never in `Escrow`, events, WS messages or logs.
 */
export function newClientToken(): { token: string; hash: string } {
  const token = randomBytes(32).toString('hex');
  return { token, hash: hashClientToken(token) };
}

export function hashClientToken(token: string): string {
  return createHash('sha256').update(token, 'utf8').digest('hex');
}

/** Constant-time comparison of a presented token against the stored hash. */
export function checkClientToken(token: string, storedHash: string | undefined): boolean {
  if (!storedHash) return false;
  const a = Buffer.from(hashClientToken(token), 'hex');
  const b = Buffer.from(storedHash, 'hex');
  return a.length === b.length && timingSafeEqual(a, b);
}
