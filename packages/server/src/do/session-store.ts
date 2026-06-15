/**
 * Session tracking and broadcast plumbing.
 *
 * Manages the set of live WebSocket sessions and provides optimized
 * broadcast helpers that serialize once and fan out to all connections.
 */
import type { Faction, ServerMsg } from '@bolo/shared';

export interface Session {
  ws: WebSocket;
  role: 'player' | 'spectator';
  did?: string;
  handle?: string;
  tankId?: number;
  /** spectators accumulate terrain deltas between their 1Hz frames */
  pendingTerrain: [number, number, number][];
  msgBudget: number;
  lastEmoteAt: number;
  /** DIDs of currently-connected Bluesky mutuals (follows both ways) */
  mutuals: Set<string>;
}

export class SessionStore {
  private sessions = new Set<Session>();

  add(s: Session): void {
    this.sessions.add(s);
  }

  remove(s: Session): boolean {
    return this.sessions.delete(s);
  }

  has(s: Session): boolean {
    return this.sessions.has(s);
  }

  get size(): number {
    return this.sessions.size;
  }

  *[Symbol.iterator](): IterableIterator<Session> {
    for (const s of this.sessions) yield s;
  }

  /** Count players vs spectators. */
  playerSpectatorCounts(): { players: number; spectators: number } {
    let players = 0;
    let spectators = 0;
    for (const s of this.sessions) {
      if (s.role === 'player') players++;
      else spectators++;
    }
    return { players, spectators };
  }

  send(session: Session, msg: ServerMsg): void {
    this.sendRaw(session, JSON.stringify(msg));
  }

  sendRaw(session: Session, raw: string): void {
    try {
      session.ws.send(raw);
    } catch {
      // socket already closing; the close handler cleans up
    }
  }

  broadcast(msg: ServerMsg): void {
    const raw = JSON.stringify(msg); // serialize once, not once per socket
    for (const s of this.sessions) this.sendRaw(s, raw);
  }

  broadcastRaw(raw: string): void {
    for (const s of this.sessions) this.sendRaw(s, raw);
  }

  broadcastChat(from: string, text: string, faction: Faction | 'system' = 'system'): void {
    this.broadcast({ t: 'chat', from, faction, text });
  }
}
