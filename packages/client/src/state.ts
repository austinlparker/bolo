/**
 * Client-side mirror of the world, fed by welcome/state/spectate messages.
 * Tanks keep their previous snapshot so the renderer can interpolate
 * between server ticks.
 */
import {
  angleDelta,
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
  TICK_MS,
  type WarInfo,
  type WelcomeMsg,
} from '@bolo/shared';

export interface TankSnap {
  view: TankView;
  at: number;
}

export interface InterpTank {
  /** latest authoritative view (alive/armor/etc. read from here) */
  cur: TankView;
  /** recent snapshots, oldest first, for render-delayed interpolation */
  snaps: TankSnap[];
}

/**
 * Render this far in the past so network jitter is absorbed by the snapshot
 * buffer instead of freezing motion until the next packet lands.
 */
const RENDER_DELAY_MS = TICK_MS * 1.2;

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
  /** previous builder positions by tankId + the time of the current set, for lerping */
  buildersPrev = new Map<number, { x: number; y: number }>();
  buildersAt = 0;
  shells: ShellView[] = [];
  /** when the current shell snapshot landed; shells extrapolate from here */
  shellsAt = 0;
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
        existing.cur = tv;
        existing.snaps.push({ view: tv, at: now });
        if (existing.snaps.length > 5) existing.snaps.shift();
      } else {
        this.tanks.set(tv.id, { cur: tv, snaps: [{ view: tv, at: now }] });
      }
    }
    for (const id of [...this.tanks.keys()]) {
      if (!seen.has(id)) this.tanks.delete(id);
    }
    this.shells = msg.shells;
    this.shellsAt = now;
    this.buildersPrev = new Map(this.builders.map((b) => [b.tankId, { x: b.x, y: b.y }]));
    this.builders = msg.builders;
    this.buildersAt = now;
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
      case 'base_neutralized':
        this.pushFeed(`a base's defenses fell to ${e.by} fire`);
        break;
      case 'dominance':
        if (this.war) this.war.dominance = e.faction && e.endsAt ? { faction: e.faction, endsAt: e.endsAt } : null;
        this.pushFeed(e.faction ? `${e.faction} dominates the island — the war nears its end` : 'dominance broken — the war goes on');
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

  /**
   * Interpolated position for rendering: finds the two snapshots bracketing
   * (now - RENDER_DELAY_MS) and lerps between them, so arrival jitter
   * reshapes the timeline instead of freezing it.
   */
  lerpTank(it: InterpTank, now: number): { x: number; y: number; dir: number } {
    const s = it.snaps;
    const last = s[s.length - 1];
    if (s.length === 1) return { x: last.view.x, y: last.view.y, dir: last.view.dir };
    const target = now - RENDER_DELAY_MS;
    let a = s[0];
    let b = s[1];
    for (let i = s.length - 1; i > 0; i--) {
      if (s[i - 1].at <= target || i === 1) {
        a = s[i - 1];
        b = s[i];
        if (s[i - 1].at <= target) break;
      }
    }
    const span = b.at - a.at;
    const t = span > 0 ? Math.min(1, Math.max(0, (target - a.at) / span)) : 1;
    return {
      x: a.view.x + (b.view.x - a.view.x) * t,
      y: a.view.y + (b.view.y - a.view.y) * t,
      dir: a.view.dir + angleDelta(a.view.dir, b.view.dir) * t,
    };
  }
}

