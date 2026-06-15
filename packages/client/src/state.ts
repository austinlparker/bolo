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
  TANK_MAX_SPEED,
  TANK_ACCEL,
  TANK_ACCEL_CURVE,
  TANK_BRAKE,
  TANK_TURN_RATE,
  TANK_TURN_ACCEL,
  TANK_REVERSE_FACTOR,
  Terrain,
  TERRAIN,
  BOAT_SPEED,
  TANK_RADIUS,
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
const RENDER_DELAY_MS = TICK_MS * 2;

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

  // ---------- client-side prediction (own tank) ----------
  /** current input the player is sending to the server */
  myInput: { accel: number; turn: number; fire: boolean } = { accel: 0, turn: 0, fire: false };
  /**
   * Predicted state for the player's own tank: last authoritative snapshot
   * position/dir/speed from the server, integrated forward by current input
   * each frame so the camera and own-tank sprite react instantly.
   */
  private pred: { x: number; y: number; dir: number; speed: number; turnSpeed: number; at: number } | null = null;
  /** performance.now() of the last server snapshot used to seed prediction */
  private predSeedAt = 0;
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
        if (existing.snaps.length > 10) existing.snaps.shift();
      } else {
        this.tanks.set(tv.id, { cur: tv, snaps: [{ view: tv, at: now }] });
      }
      // reconcile prediction when our own tank's snapshot arrives
      if (this.you && tv.id === this.you.tankId) {
        this.reconcilePrediction(tv, now);
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

  /**
   * Predicted position for the player's OWN tank: dead-reckon from the last
   * server snapshot using the current input, integrating forward to `now`.
   * This gives instant visual response to controls without waiting for the
   * server round-trip + render delay. Other tanks still use lerpTank().
   */
  predictedSelf(now: number): { x: number; y: number; dir: number } {
    const snap = this.me();
    if (!snap || !this.you || !snap.alive) {
      // no tank or dead: reset prediction, fall back to interpolation
      this.pred = null;
      const it = this.you ? this.tanks.get(this.you.tankId) : undefined;
      return it ? this.lerpTank(it, now) : { x: MAP_SIZE / 2, y: MAP_SIZE / 2, dir: 0 };
    }
    if (!this.pred) {
      // seed from latest server snapshot
      this.pred = { x: snap.x, y: snap.y, dir: snap.dir, speed: snap.speed, turnSpeed: 0, at: now };
      this.predSeedAt = now;
    }
    // integrate forward from the last frame to now
    if (this.pred.at < now) {
      // step in small increments for stability (server uses DT = 1/TICK_HZ)
      const stepDt = 1 / 10; // 100ms steps matching server tick
      let remaining = (now - this.pred.at) / 1000;
      while (remaining > 0) {
        const dt = Math.min(stepDt, remaining);
        this.predStep(dt);
        remaining -= dt;
      }
      this.pred.at = now;
    }
    return { x: this.pred.x, y: this.pred.y, dir: this.pred.dir };
  }

  /**
   * One integration step replicating the server's tank movement model
   * (tank-system.ts): rotational inertia + terrain-agnostic accel toward
   * target speed. Collision/terrain checks are omitted (we can't know the
   * authoritative terrain state from here without full replication); the
   * server corrects any divergence when the next snapshot arrives.
   */
  private predStep(dt: number): void {
    if (!this.pred) return;
    const p = this.pred;
    const input = this.myInput;

    // --- turning: same inertia model as tank-system.ts ---
    const targetRate = Math.max(-1, Math.min(1, input.turn)) * TANK_TURN_RATE;
    if (targetRate * p.turnSpeed < 0) p.turnSpeed = 0;
    if (Math.abs(targetRate) <= Math.abs(p.turnSpeed)) {
      p.turnSpeed = targetRate;
    } else {
      p.turnSpeed = targetRate > 0
        ? Math.min(targetRate, p.turnSpeed + TANK_TURN_ACCEL * dt)
        : Math.max(targetRate, p.turnSpeed - TANK_TURN_ACCEL * dt);
    }
    p.dir += p.turnSpeed * dt;
    if (p.dir > Math.PI) p.dir -= 2 * Math.PI;
    else if (p.dir < -Math.PI) p.dir += 2 * Math.PI;

    // --- speed: accel toward target speed fraction (terrain-aware) ---
    const onBoat = false; // client prediction doesn't model boat state transitions
    const maxSpeed = this.terrainMaxSpeed(p.x, p.y, onBoat);
    const target = input.accel >= 0
      ? input.accel * maxSpeed
      : input.accel * maxSpeed * TANK_REVERSE_FACTOR;
    const opposing = (input.accel < 0 && p.speed > 0) || (input.accel > 0 && p.speed < 0);
    const rate = opposing
      ? TANK_BRAKE
      : TANK_ACCEL * (1 - TANK_ACCEL_CURVE * Math.min(1, Math.abs(p.speed) / maxSpeed));
    if (p.speed < target) p.speed = Math.min(target, p.speed + rate * dt);
    else if (p.speed > target) p.speed = Math.max(target, p.speed - rate * dt);

    // --- movement ---
    if (p.speed !== 0) {
      p.x += Math.cos(p.dir) * p.speed * dt;
      p.y += Math.sin(p.dir) * p.speed * dt;
    }
  }

  /**
   * Terrain-aware max speed, replicating the server's tank-system.ts model.
   * Samples the tile under the tank and checks tread corners for road shoulders.
   * Returns 0 for impassable terrain (building, deep sea off-boat).
   */
  private terrainMaxSpeed(x: number, y: number, onBoat: boolean): number {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= MAP_SIZE || yi >= MAP_SIZE) return TANK_MAX_SPEED;
    const here = this.terrain[yi * MAP_SIZE + xi] as Terrain;
    const onWater = here === Terrain.DeepSea || here === Terrain.River || here === Terrain.BoatTile;
    if (onBoat && onWater) return BOAT_SPEED;
    let terrainSpeed = TERRAIN[here].tankSpeed;
    if (terrainSpeed > 0 && here !== Terrain.Road) {
      const r = TANK_RADIUS * 0.9;
      for (const [ox, oy] of [[r, r], [r, -r], [-r, r], [-r, -r]]) {
        const txi = Math.floor(x + ox);
        const tyi = Math.floor(y + oy);
        if (txi >= 0 && tyi >= 0 && txi < MAP_SIZE && tyi < MAP_SIZE) {
          if ((this.terrain[tyi * MAP_SIZE + txi] as Terrain) === Terrain.Road) {
            terrainSpeed = 1.0;
            break;
          }
        }
      }
    }
    return TANK_MAX_SPEED * terrainSpeed;
  }

  /**
   * Reconcile prediction with authoritative server state: snap to the
   * server position when a new snapshot arrives for our own tank. The
   * prediction continues forward from there on the next frame.
   */
  private reconcilePrediction(tv: TankView, now: number): void {
    if (!this.pred) return;
    // snap to server position; keep predicted turnSpeed/speed as those are
    // continuously integrated. A large jump (wall hit we didn't predict)
    // is absorbed immediately.
    const dx = tv.x - this.pred.x;
    const dy = tv.y - this.pred.y;
    const drift = Math.hypot(dx, dy);
    if (drift > 0.75) {
      // large correction: snap hard
      this.pred.x = tv.x;
      this.pred.y = tv.y;
      this.pred.dir = tv.dir;
      this.pred.speed = tv.speed;
    } else {
      // small drift: blend toward server (absorb smoothly over ~2 frames)
      const blend = 0.5;
      this.pred.x += dx * blend;
      this.pred.y += dy * blend;
      // angle: take the shorter way
      const da = angleDelta(this.pred.dir, tv.dir);
      this.pred.dir += da * blend;
      this.pred.speed += (tv.speed - this.pred.speed) * blend;
    }
    this.pred.at = now;
  }
}

