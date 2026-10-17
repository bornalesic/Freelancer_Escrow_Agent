/** "esc_" + 4 random hex chars, e.g. "esc_7f3a". Callers must check for collisions. */
export function newEscrowId(): string {
  const b = crypto.getRandomValues(new Uint8Array(2));
  return `esc_${Array.from(b, (x) => x.toString(16).padStart(2, '0')).join('')}`;
}

/** eventId("esc_7f3a", 7) → "esc_7f3a:0007". */
export function eventId(escrowId: string, seq: number): string {
  return `${escrowId}:${String(seq).padStart(4, '0')}`;
}
