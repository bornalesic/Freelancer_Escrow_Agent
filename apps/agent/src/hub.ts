import type { WsMessage } from '@escrow/shared';
import type { Store } from './store';

/** The subset of a `ws` WebSocket the hub needs. */
export interface Socket {
  readonly readyState: number;
  send(data: string): void;
  on(event: 'close' | 'error', cb: () => void): unknown;
}

const OPEN = 1;

interface Client {
  socket: Socket;
  escrowId?: string;
}

/** WebSocket hub: snapshot on connect, then escrow/event/explanation messages per escrow. */
export class Hub {
  private clients = new Set<Client>();

  constructor(private store: Store) {}

  get size(): number {
    return this.clients.size;
  }

  attach(socket: Socket, escrowId?: string): void {
    const client: Client = { socket, escrowId: escrowId || undefined };
    this.clients.add(client);
    const drop = () => this.clients.delete(client);
    socket.on('close', drop);
    socket.on('error', drop);

    const escrows = client.escrowId
      ? [this.store.get(client.escrowId)].filter((e) => e !== undefined)
      : this.store.list();
    for (const escrow of escrows) {
      this.send(client, { kind: 'snapshot', escrow, events: this.store.eventsOf(escrow.id) });
    }
  }

  broadcast(escrowId: string, msg: WsMessage): void {
    for (const c of this.clients) {
      if (!c.escrowId || c.escrowId === escrowId) this.send(c, msg);
    }
  }

  private send(c: Client, msg: WsMessage): void {
    if (c.socket.readyState !== OPEN) return;
    try {
      c.socket.send(JSON.stringify(msg));
    } catch {
      this.clients.delete(c);
    }
  }
}
