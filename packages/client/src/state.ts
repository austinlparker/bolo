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
  DT,
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

/** Drift above this (tiles) is a teleport/respawn — snap immediately. */
const HARD_SNAP_THRESHOLD = 1.5;
/** Spread residual prediction error over this many ms (~6 frames at 60fps). */
const ERROR_DECAY_MS = 100;
/** Max entries in the input replay ring buffer (~3s at 10Hz). */
const MAX_INPUT_BUFFER = 30;

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
  /** death markers for mutual kills: { x, y, at, victimHandle, killerHandle } */
  deathMarkers: { x: number; y: number; at: number; victimHandle: string; killerHandle: string }[] = [];
  /** social profiles keyed by DID: { avatar, displayName } */
  socialProfiles: Record<string, { avatar?: string; displayName?: string; handle?: string }> = {};
  /** your top nemesis (from welcome message) */
  nemesis: { did: string; handle: string; killedBy: number; youKilled: number; online: boolean } | null = null;
  /** DIDs of your currently-connected Bluesky mutuals */
  mutuals = new Set<string>();
  /** active bounty targets visible to this player */
  bounties: { targetDid: string; targetHandle: string; reward: number; victimHandle: string }[] = [];

  // ---------- client-side prediction (own tank) ----------
  /** current input the player is sending to the server */
  myInput: { accel: number; dir: number; fire: boolean } = { accel: 0, dir: 0, fire: false };
  /** client-authoritative heading (always exact; synced from server on respawn) */
  private myDir = 0;
  /**
   * Predicted state for the player's own tank: last authoritative snapshot
   * position/speed from the server, integrated forward by replayed inputs
   * each frame so the camera and own-tank sprite react instantly.
   * Heading is client-authoritative (always exact from myDir).
   */
  private pred: { x: number; y: number; dir: number; speed: number; onBoat: boolean; at: number } | null = null;
  /** performance.now() of the last server snapshot used to seed prediction */
  private predSeedAt = 0;
  /** true when a new server snapshot requires re-seed + input replay */
  private predDirty = false;
  /** ring buffer of recent inputs, tagged with estimated server tick */
  private inputBuffer: Array<{ tick: number; accel: number; dir: number; fire: boolean }> = [];
  /** last server tick acknowledged (from the most recent StateMsg) */
  private lastAckTick = 0;
  /** performance.now() when the last server snapshot arrived */
  private lastSnapshotAt = 0;
  /** error-decay correction buffers (residual position drift spread over ERROR_DECAY_MS) */
  private errorX = 0;
  private errorY = 0;
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
    this.nemesis = msg.nemesis ?? null;
    this.mutuals = new Set(msg.mutuals ?? []);
    this.tick = msg.tick;
    this.tanks.clear();
    this.shells = [];
    this.builders = [];
    this.mapVersion++;
    this.terrainLog = [];
  }

  applySocialData(profiles: Record<string, { avatar?: string; displayName?: string; handle?: string }>): void {
    this.socialProfiles = { ...this.socialProfiles, ...profiles };
  }

  applyMutuals(dids: string[]): void {
    this.mutuals = new Set(dids);
  }

  applyBountyActive(bounties: { targetDid: string; targetHandle: string; reward: number; victimHandle: string }[]): void {
    this.bounties = bounties;
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
      // mark prediction dirty when our own tank's snapshot arrives
      if (this.you && tv.id === this.you.tankId) {
        this.lastAckTick = msg.tick;
        this.lastSnapshotAt = now;
        this.predDirty = true;
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
      case 'revenge':
        this.pushFeed(`★ REVENGE! ${e.killerHandle} struck back at ${e.victimHandle}`);
        break;
      case 'payback':
        this.pushFeed(`${e.killerHandle} got payback on ${e.victimHandle}`);
        break;
      case 'mutual_killed':
        this.deathMarkers.push({ x: e.x, y: e.y, at: now, victimHandle: e.victimHandle, killerHandle: e.killerHandle });
        this.pushFeed(`⚠ your mutual @${e.victimHandle} was destroyed by @${e.killerHandle} [${e.cause}]`);
        break;
      case 'mutual_capture':
        this.pushFeed(`🏠 your mutual @${e.byHandle} captured a base`);
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
   * Record a local input (from keyboard or touch) for client-side prediction.
   * Stores the absolute heading so the prediction replay can dead-reckon
   * position without a turn model.
   */
  recordInput(accel: number, dir: number, fire: boolean): void {
    this.myInput = { accel, dir, fire };
    this.myDir = dir;
    const now = performance.now();
    const tick = this.lastAckTick + Math.floor((now - this.lastSnapshotAt) / TICK_MS);
    this.inputBuffer.push({ tick, accel, dir, fire });
    if (this.inputBuffer.length > MAX_INPUT_BUFFER) this.inputBuffer.shift();
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
   * Predicted position for the player's OWN tank, using input-replay
   * (Gambetta's model): on each server snapshot, re-seed from authoritative
   * state and replay the local input buffer forward to `now`. Between
   * snapshots, continue integrating with the latest input. Residual drift
   * (from unmodeled collisions etc.) is spread over ERROR_DECAY_MS instead
   * of snapping. Heading is always exact (client-authoritative).
   */
  predictedSelf(now: number): { x: number; y: number; dir: number } {
    const snap = this.me();
    if (!snap || !this.you || !snap.alive) {
      this.pred = null;
      this.errorX = this.errorY = 0;
      const it = this.you ? this.tanks.get(this.you.tankId) : undefined;
      return it ? this.lerpTank(it, now) : { x: MAP_SIZE / 2, y: MAP_SIZE / 2, dir: this.myDir };
    }

    // Frame dt for error decay (captured before pred.at is overwritten)
    const frameDt = this.pred ? Math.min(0.1, (now - this.pred.at) / 1000) : 0;

    if (this.predDirty || !this.pred) {
      // --- Re-seed from server snapshot + replay inputs (Gambetta's model) ---

      // Capture old display position so the renderer doesn't jump
      const oldX = this.pred ? this.pred.x + this.errorX : snap.x;
      const oldY = this.pred ? this.pred.y + this.errorY : snap.y;

      // Re-seed from authoritative server state (position only; heading stays client-owned)
      this.pred = {
        x: snap.x, y: snap.y, dir: snap.dir,
        speed: snap.speed,
        onBoat: snap.onBoat, at: this.lastSnapshotAt,
      };
      this.predSeedAt = this.lastSnapshotAt;

      // Replay inputs from lastSnapshotAt to now, stepping in server-tick increments
      if (this.pred.at < now) {
        let remaining = (now - this.pred.at) / 1000;
        while (remaining > 0) {
          const dt = Math.min(DT, remaining);
          const stepMs = now - remaining * 1000;
          const stepTick = this.lastAckTick + Math.floor((stepMs - this.lastSnapshotAt) / TICK_MS);
          this.predStep(dt, this.lookupInput(stepTick));
          remaining -= dt;
        }
        this.pred.at = now;
      }

      // Drop acknowledged buffer entries (server has already processed them)
      this.inputBuffer = this.inputBuffer.filter((e) => e.tick > this.lastAckTick);

      // Compute residual position error: old display position vs new prediction.
      const newPred = this.pred;
      const drift = Math.hypot(oldX - newPred.x, oldY - newPred.y);
      if (drift > HARD_SNAP_THRESHOLD) {
        // Catastrophic drift (teleport, respawn): snap immediately, no smoothing
        this.errorX = this.errorY = 0;
      } else {
        this.errorX = oldX - newPred.x;
        this.errorY = oldY - newPred.y;
      }

      this.predDirty = false;
    } else {
      // --- Continue integrating from the last frame to now ---
      if (this.pred.at < now) {
        let remaining = (now - this.pred.at) / 1000;
        while (remaining > 0) {
          const dt = Math.min(DT, remaining);
          this.predStep(dt, this.myInput);
          remaining -= dt;
        }
        this.pred.at = now;
      }
    }

    // --- Error decay: spread residual position correction over ERROR_DECAY_MS ---
    const correction = Math.min(1, frameDt / (ERROR_DECAY_MS / 1000));
    this.errorX *= 1 - correction;
    this.errorY *= 1 - correction;

    return {
      x: this.pred.x + this.errorX,
      y: this.pred.y + this.errorY,
      dir: this.myDir, // client-authoritative heading — always exact
    };
  }

  /**
   * Find the input that was active at a given estimated server tick.
   * Scans the buffer backward for the latest entry at or before stepTick.
   */
  private lookupInput(stepTick: number): { accel: number; dir: number; fire: boolean } {
    for (let i = this.inputBuffer.length - 1; i >= 0; i--) {
      if (this.inputBuffer[i].tick <= stepTick) {
        const e = this.inputBuffer[i];
        return { accel: e.accel, dir: e.dir, fire: e.fire };
      }
    }
    return this.myInput;
  }

  /**
   * One integration step replicating the server's tank movement model
   * (tank-system.ts): terrain-aware accel + building/sea collision.
   * Heading is client-authoritative (set from input.dir each step).
   * Collision prediction eliminates most position snaps when driving into walls.
   */
  private predStep(dt: number, input: { accel: number; dir: number }): void {
    if (!this.pred) return;
    const p = this.pred;
    p.dir = input.dir; // client-authoritative heading

    // --- speed: accel toward target speed fraction (terrain-aware) ---
    const maxSpeed = this.terrainMaxSpeed(p.x, p.y, p.onBoat);
    const target = input.accel >= 0
      ? input.accel * maxSpeed
      : input.accel * maxSpeed * TANK_REVERSE_FACTOR;
    const opposing = (input.accel < 0 && p.speed > 0) || (input.accel > 0 && p.speed < 0);
    const rate = opposing
      ? TANK_BRAKE
      : TANK_ACCEL * (1 - TANK_ACCEL_CURVE * Math.min(1, Math.abs(p.speed) / maxSpeed));
    if (p.speed < target) p.speed = Math.min(target, p.speed + rate * dt);
    else if (p.speed > target) p.speed = Math.max(target, p.speed - rate * dt);

    // --- movement + collision (mirrors server's tank-system.ts) ---
    if (p.speed !== 0) {
      const nx = p.x + Math.cos(p.dir) * p.speed * dt;
      const ny = p.y + Math.sin(p.dir) * p.speed * dt;
      const xi = Math.floor(nx);
      const yi = Math.floor(ny);
      if (xi >= 0 && yi >= 0 && xi < MAP_SIZE && yi < MAP_SIZE) {
        const nextTile = this.terrain[yi * MAP_SIZE + xi] as Terrain;
        const hereTile = this.terrain[Math.floor(p.y) * MAP_SIZE + Math.floor(p.x)] as Terrain;
        const blocked =
          nextTile === Terrain.Building ||
          (!p.onBoat && nextTile === Terrain.DeepSea && hereTile !== Terrain.DeepSea);
        if (blocked) {
          p.speed = 0;
        } else {
          p.x = Math.max(0.5, Math.min(MAP_SIZE - 0.5, nx));
          p.y = Math.max(0.5, Math.min(MAP_SIZE - 0.5, ny));
        }
      } else {
        p.x = Math.max(0.5, Math.min(MAP_SIZE - 0.5, nx));
        p.y = Math.max(0.5, Math.min(MAP_SIZE - 0.5, ny));
      }
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
}

