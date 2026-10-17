// The one-time `clientToken` from POST /escrows, needed to approve or dispute a delivery. Kept in memory
// and in localStorage keyed by escrow id, so a reload in the same browser still works. Never sent anywhere
// except POST /escrows/:id/approve.
const mem = new Map<string, string>();
const key = (escrowId: string) => `escrow.clientToken.${escrowId}`;

export function saveClientToken(escrowId: string, token: string): void {
  mem.set(escrowId, token);
  try {
    localStorage.setItem(key(escrowId), token);
  } catch {
    // private window or blocked storage: memory only, approve still works until reload
  }
}

export function getClientToken(escrowId: string): string | undefined {
  const inMem = mem.get(escrowId);
  if (inMem) return inMem;
  try {
    return localStorage.getItem(key(escrowId)) ?? undefined;
  } catch {
    return undefined;
  }
}
