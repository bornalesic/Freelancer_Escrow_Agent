import fs from 'node:fs';
import path from 'node:path';
import type { Escrow, LogEvent } from '@escrow/shared';

/** Agent-private bookkeeping per escrow. Never sent to clients. */
export interface EscrowInternal {
  /** Bumped on every re-parse so a stale /parse answer is ignored. */
  parseSeq: number;
  fundingRecipientId?: string;
  fundingSeen?: boolean;
  fundingTxid?: string;
  /**
   * Outgoing payment (release or refund). `sending` is written to disk BEFORE wallet.pay(), so a
   * crash mid-call leaves `sending` and we never re-pay automatically (see retry-step `force`).
   */
  payout?: { kind: 'release' | 'refund'; status: 'sending' | 'sent' | 'failed'; invoice: string; txid?: string };
  /** sha256 of the clientToken returned by POST /escrows. The token itself is never stored. */
  clientTokenHash?: string;
  /** `${state}:${title}` of the last error event, so a retried step doesn't spam the log. */
  lastError?: string;
}

interface DbFile {
  escrows: Escrow[];
  events: Record<string, LogEvent[]>;
  internal: Record<string, EscrowInternal>;
}

/** JSON-file store (data/db.json). Every mutation writes the whole file atomically (tmp + rename). */
export class Store {
  private escrows = new Map<string, Escrow>();
  private events = new Map<string, LogEvent[]>();
  private internals = new Map<string, EscrowInternal>();
  readonly file: string;

  constructor(readonly dataDir: string) {
    this.file = path.join(dataDir, 'db.json');
  }

  load(): void {
    fs.mkdirSync(this.dataDir, { recursive: true });
    if (!fs.existsSync(this.file)) return;
    const db = JSON.parse(fs.readFileSync(this.file, 'utf8')) as DbFile;
    for (const e of db.escrows) this.escrows.set(e.id, e);
    for (const [id, evs] of Object.entries(db.events)) this.events.set(id, evs);
    for (const [id, i] of Object.entries(db.internal ?? {})) this.internals.set(id, i);
  }

  private flush(): void {
    const db: DbFile = {
      escrows: [...this.escrows.values()],
      events: Object.fromEntries(this.events),
      internal: Object.fromEntries(this.internals),
    };
    const tmp = `${this.file}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, JSON.stringify(db, null, 1));
    fs.renameSync(tmp, this.file);
  }

  has(id: string): boolean {
    return this.escrows.has(id);
  }

  get(id: string): Escrow | undefined {
    return this.escrows.get(id);
  }

  list(): Escrow[] {
    return [...this.escrows.values()].sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  eventsOf(id: string): LogEvent[] {
    return this.events.get(id) ?? [];
  }

  internal(id: string): EscrowInternal {
    let i = this.internals.get(id);
    if (!i) {
      i = { parseSeq: 0 };
      this.internals.set(id, i);
    }
    return i;
  }

  /** Mutate the internal record and persist. */
  patchInternal(id: string, patch: Partial<EscrowInternal>): EscrowInternal {
    const i = Object.assign(this.internal(id), patch);
    this.flush();
    return i;
  }

  putEscrow(escrow: Escrow): void {
    this.escrows.set(escrow.id, escrow);
    this.flush();
  }

  /** Next event sequence number for an escrow (1-based). */
  nextSeq(id: string): number {
    return this.eventsOf(id).length + 1;
  }

  addEvent(event: LogEvent): void {
    const list = this.events.get(event.escrowId) ?? [];
    list.push(event);
    this.events.set(event.escrowId, list);
    this.flush();
  }

  updateEvent(escrowId: string, eventId: string, patch: Partial<LogEvent>): LogEvent | undefined {
    const ev = this.eventsOf(escrowId).find((e) => e.id === eventId);
    if (!ev) return undefined;
    Object.assign(ev, patch);
    this.flush();
    return ev;
  }

  /** Dev only: drop all escrows, events and stored files. */
  reset(): void {
    this.escrows.clear();
    this.events.clear();
    this.internals.clear();
    for (const dir of ['deliverables', 'work', 'files', 'tmp']) {
      fs.rmSync(path.join(this.dataDir, dir), { recursive: true, force: true });
    }
    this.flush();
  }
}
