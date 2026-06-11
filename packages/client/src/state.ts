/**
 * Client-side mirror of the world, fed by welcome/state/spectate messages.
 * Tanks keep their previous snapshot so the renderer can interpolate
 * between server ticks.
 */
import {
  base64ToBytes,
  type Base,
  type BuilderView,
  type GameEvent,
  MAP_SIZE,
  type Pillbox,
  type PlayerProfile,
  type ShellView,
  type StateMsg,
  type TankView,
  type WarInfo,
  type WelcomeMsg,
} from '@bolo/shared';

export interface InterpTank {
  cur: TankView;
  prev: TankView;
  lastUpdate: number;
}

export interface Boom {
  x: number;
  y: number;
  kind: 'shell' | 'mine';
  at: number;
}

export class GameState {
  terrain = new Uint8Array(MAP_SIZE * MAP_SIZE);
  /** tiles where our faction knows a mine sits */
  mines = new Set<number>();
  bases: Base[] = [];
  pills: Pillbox[] = [];
  tanks = new Map<number, InterpTank>();
  builders: BuilderView[] = [];
  shells: ShellView[] = [];
  war: WarInfo | null = null;
  you: WelcomeMsg['you'] = null;
  /** your persistent career stats, from welcome */
  profile: PlayerProfile | null = null;
  tick = 0;
  booms: Boom[] = [];
  feed: string[] = [];
  /** active emote bubbles: tankId -> { kind, at } */
  emotes = new Map<number, { kind: string; at: number }>();
  /**
   * Terrain change tracking with multiple consumers (main view + minimap
   * caches): a version bump means "repaint everything"; the log appends
   * changed tiles and each TileCache keeps its own cursor into it.
   */
  mapVersion = 0;
  terrainLog: [number, number][] = [];

  /** record a terrain edit and cap the log so it can't grow unbounded */
  logTerrainChange(x: number, y: number): void {
    this.terrainLog.push([x, y]);
    if (this.terrainLog.length > 4096) {
      this.mapVersion++;
      this.terrainLog = [];
    }
  }

  applyWelcome(msg: WelcomeMsg): void {
    this.terrain = base64ToBytes(msg.map.terrain);
    this.mines = new Set(msg.mines.map(([x, y]) => y * MAP_SIZE + x));
    this.bases = msg.bases;
    this.pills = msg.pills;
    this.war = msg.war;
    this.you = msg.you;
    this.profile = msg.profile ?? null;
    this.tick = msg.tick;
    this.tanks.clear();
    this.shells = [];
    this.builders = [];
    this.mapVersion++;
    this.terrainLog = [];
  }

  applyState(msg: StateMsg): void {
    const now = performance.now();
    this.tick = msg.tick;
    const seen = new Set<number>();
    for (const tv of msg.tanks) {
      seen.add(tv.id);
      const existing = this.tanks.get(tv.id);
      if (existing) {
        existing.prev = existing.cur;
        existing.cur = tv;
        existing.lastUpdate = now;
      } else {
        this.tanks.set(tv.id, { cur: tv, prev: tv, lastUpdate: now });
      }
    }
    for (const id of [...this.tanks.keys()]) {
      if (!seen.has(id)) this.tanks.delete(id);
    }
    this.shells = msg.shells;
    this.builders = msg.builders;
    if (msg.pills) this.pills = msg.pills;
    if (msg.bases) this.bases = msg.bases;
    if (msg.terrain) {
      for (const [x, y, t] of msg.terrain) {
        this.terrain[y * MAP_SIZE + x] = t;
        this.logTerrainChange(x, y);
      }
    }
    if (msg.mines) {
      for (const [x, y, present] of msg.mines) {
        const i = y * MAP_SIZE + x;
        if (present) this.mines.add(i);
        else this.mines.delete(i);
      }
    }
    if (msg.events) {
      for (const e of msg.events) this.applyEvent(e, now);
    }
  }

  private applyEvent(e: GameEvent, now: number): void {
    switch (e.e) {
      case 'boom':
        this.booms.push({ x: e.x, y: e.y, kind: e.kind, at: now });
        break;
      case 'kill':
        this.pushFeed(`${e.killer} destroyed ${e.victim}`);
        break;
      case 'base_captured':
        this.pushFeed(`${e.handle} captured a base for ${e.by}`);
        break;
      case 'pill_captured':
        this.pushFeed(`${e.handle} salvaged a pillbox`);
        break;
      case 'pill_placed':
        this.pushFeed(`new ${e.by} pillbox dug in`);
        break;
      case 'builder_killed':
        break;
    }
  }

  pushFeed(line: string): void {
    this.feed.push(line);
    if (this.feed.length > 6) this.feed.shift();
  }

  /** Your own tank's latest server view (includes armor/shells/etc). */
  me(): TankView | null {
    if (!this.you) return null;
    return this.tanks.get(this.you.tankId)?.cur ?? null;
  }

  /** Interpolated position for rendering. */
  lerpTank(it: InterpTank, now: number, tickMs: number): { x: number; y: number; dir: number } {
    const t = Math.min(1, (now - it.lastUpdate) / tickMs);
    const dir = it.prev.dir + shortestAngle(it.prev.dir, it.cur.dir) * t;
    return {
      x: it.prev.x + (it.cur.x - it.prev.x) * t,
      y: it.prev.y + (it.cur.y - it.prev.y) * t,
      dir,
    };
  }
}

function shortestAngle(a: number, b: number): number {
  let d = b - a;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
