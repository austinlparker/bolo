/**
 * Server-authoritative simulation. Pure TypeScript with no Workers
 * dependencies so it can be unit-tested and reasoned about in isolation.
 * The Durable Object drives `tick()` at TICK_HZ and ships the returned
 * deltas to clients.
 *
 * The World class is now a thin orchestrator: it owns the entity
 * collections and per-tick accumulators, but delegates the simulation
 * logic to six subsystem classes (TankSystem, ShellSystem, PillSystem,
 * BaseSystem, BuilderSystem, DamageSystem) in ./systems/.
 */
import {
  MAP_SIZE,
  angleDelta,
  DT,
  type Faction,
  type Owner,
  type Base,
  type BuilderOrderKind,
  type GameEvent,
  type Pillbox,
  type Shell,
  type Tank,
  type TankTuning,
  type WarInfo,
  BASE_MAX_HP,
  BASE_NEUTRAL_START_HP,
  DEFAULT_TANK_TUNING,
  DOMINANCE_BASES,
  DOMINANCE_MINUTES,
  FACTIONS,
  SHELL_RANGE,
  TANK_START_ARMOR,
  TANK_START_MINES,
  TANK_START_SHELLS,
  TICK_HZ,
  TICK_MS,
  WAR_MIN_MINUTES,
} from '@bolo/shared';
import {
  generateMap,
  idx,
  MineState,
  Terrain,
} from '@bolo/shared';
import type { WorldHost } from './world-host';
import { resetAccumulators } from './context';
import { clamp, canBuildOn } from './utils';
import { TankSystem } from './systems/tank-system';
import { ShellSystem } from './systems/shell-system';
import { PillSystem } from './systems/pill-system';
import { BaseSystem } from './systems/base-system';
import { BuilderSystem } from './systems/builder-system';
import { DamageSystem } from './systems/damage-system';

export interface TickResult {
  events: GameEvent[];
  terrainChanges: [number, number, number][];
  /** mine layer changes: [x, y, newState] (MineState) */
  mineChanges: [number, number, number][];
  pillsChanged: boolean;
  basesChanged: boolean;
  warEnded: Faction | null;
  /** balance-tuning telemetry accumulated this tick */
  stats: StatEvent[];
}

export interface TankInput {
  /** -1..1; negative brakes harder */
  accel: number;
  /** -1..1; fractional values allow fine aiming (bots use this) */
  turn: number;
  fire: boolean;
}

/** A balance-tuning telemetry event, shipped by the DO (see stats.ts). */
export interface ShotStat {
  name: 'shot';
  outcome: 'tank' | 'builder' | 'pill' | 'base' | 'wall' | 'expired';
  shooter: 'tank' | 'pillbox';
  shooter_npc?: boolean;
  shooter_client?: string;
  shooter_faction: string;
  travel_tiles: number;
  target_npc?: boolean;
  target_client?: string;
}

export interface KillStat {
  name: 'kill';
  cause: 'shell' | 'mine' | 'pillbox' | 'sea';
  ttk_s?: number;
  victim_npc: boolean;
  victim_client?: string;
  victim_faction: string;
  killer_npc?: boolean;
  killer_client?: string;
  killer_faction?: string;
  kill_dist_tiles?: number;
}

export interface BaseCaptureStat {
  name: 'base_capture';
  base_id: number;
  by_faction: string;
  capturer_npc?: boolean;
  capturer_client?: string;
  base_was_neutral: boolean;
}

export interface WarStat {
  name: 'war_end';
  winner: string;
  duration_minutes: number;
  total_kills: number;
  total_captures: number;
}

export interface NpcStateStat {
  name: 'npc_state';
  faction: string;
  decision: string;
  goal_key?: string;
  goal_owner?: string;
  dist_to_goal?: number;
  shells: number;
  armor: number;
  at_friendly_base: boolean;
  on_boat: boolean;
  stuck: boolean;
  path_failed: boolean;
}

export type StatEvent = ShotStat | KillStat | BaseCaptureStat | WarStat | NpcStateStat;

const W = MAP_SIZE;

export class World implements WorldHost {
  warNumber: number;
  seed: number;
  startedAt: number;
  tick = 0;

  terrain: Uint8Array;
  mines: Uint8Array;
  bases: Base[];
  pills: Pillbox[];
  tanks = new Map<number, Tank>();
  shells: Shell[] = [];

  /** Tank-handling parameters (defaults from constants); the /rig dev tool
   * overrides them per-pane to compare handling variants. */
  readonly tuning: TankTuning = { ...DEFAULT_TANK_TUNING };

  nextId = 1;
  inputs = new Map<number, TankInput>();
  /** queued fine-aim rotation per tank, drained at the turn-rate cap (see addNudge) */
  nudges = new Map<number, number>();
  refuelTimers = new Map<number, number>(); // baseId -> seconds until next transfer
  regenTimers = new Map<number, number>();
  fortifyTimers = new Map<number, number>();

  // dominance-victory bookkeeping (see checkVictory)
  private dominantFaction: Faction | null = null;
  private dominantSinceTick = 0;

  // accumulated during a tick
  events: GameEvent[] = [];
  stats: StatEvent[] = [];
  terrainChanges: [number, number, number][] = [];
  mineChanges: [number, number, number][] = [];
  pillsChanged = false;
  basesChanged = false;

  // subsystems
  private tankSys: TankSystem;
  private shellSys: ShellSystem;
  private pillSys: PillSystem;
  private baseSys: BaseSystem;
  builderSys: BuilderSystem;
  private damageSys: DamageSystem;

  constructor(warNumber: number, seed: number, startedAt = Date.now()) {
    this.warNumber = warNumber;
    this.seed = seed;
    this.startedAt = startedAt;
    const gen = generateMap(seed);
    this.terrain = gen.terrain;
    this.mines = gen.mines;
    this.bases = gen.bases;
    this.pills = gen.pills;

    // instantiate subsystems with a reference to this world
    this.tankSys = new TankSystem(this);
    this.shellSys = new ShellSystem(this);
    this.pillSys = new PillSystem(this);
    this.baseSys = new BaseSystem(this);
    this.builderSys = new BuilderSystem(this);
    this.damageSys = new DamageSystem(this);
  }

  // ---------- WorldHost delegation: queries ----------

  tileAt(x: number, y: number): Terrain {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= W) return Terrain.DeepSea;
    return this.terrain[idx(xi, yi)] as Terrain;
  }

  // ---------- WorldHost delegation: mutation helpers ----------

  setTerrain(x: number, y: number, t: Terrain): void {
    this.terrain[idx(x, y)] = t;
    this.terrainChanges.push([x, y, t]);
  }

  setMine(x: number, y: number, m: MineState): void {
    this.mines[idx(x, y)] = m;
    this.mineChanges.push([x, y, m]);
  }

  // ---------- WorldHost delegation: damage system ----------

  damageTank(tank: Tank, amount: number, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void {
    this.damageSys.damageTank(tank, amount, cause, killer);
  }

  killTank(tank: Tank, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void {
    this.damageSys.killTank(tank, cause, killer);
  }

  detonateMine(x: number, y: number): void {
    this.damageSys.detonateMine(x, y);
  }

  handleTileTransitions(tank: Tank, prevX: number, prevY: number): void {
    this.damageSys.handleTileTransitions(tank, prevX, prevY);
  }

  dropCarriedPill(tank: Tank): void {
    this.damageSys.dropCarriedPill(tank);
  }

  // ---------- WorldHost delegation: pill system ----------

  pillCooldownFor(pill: Pillbox): number {
    return this.pillSys.cooldownFor(pill);
  }

  // ---------- WorldHost delegation: builder system ----------

  killBuilder(tank: Tank): void {
    this.builderSys.killBuilder(tank);
  }

  // ---------- queries ----------

  warInfo(phase: 'active' | 'intermission', nextWarAt: number | null): WarInfo {
    const counts: Record<Owner, number> = { dawn: 0, dusk: 0, neutral: 0 };
    for (const b of this.bases) counts[b.owner]++;
    return {
      warNumber: this.warNumber,
      seed: this.seed,
      startedAt: this.startedAt,
      phase,
      nextWarAt,
      baseCounts: counts,
      dominance: this.dominantFaction
        ? {
            faction: this.dominantFaction,
            endsAt:
              Date.now() +
              (DOMINANCE_MINUTES * 60 * TICK_HZ - (this.tick - this.dominantSinceTick)) * TICK_MS,
          }
        : null,
    };
  }

  factionCounts(): Record<Faction, number> {
    const counts: Record<Faction, number> = { dawn: 0, dusk: 0 };
    for (const t of this.tanks.values()) counts[t.faction]++;
    return counts;
  }

  // ---------- player lifecycle ----------

  addTank(did: string, handle: string, faction: Faction, npc: boolean, client = npc ? 'npc' : 'unknown'): Tank {
    const id = this.nextId++;
    const tank: Tank = {
      id,
      did,
      handle,
      faction,
      npc,
      client,
      x: 0,
      y: 0,
      dir: 0,
      speed: 0,
      turnSpeed: 0,
      armor: TANK_START_ARMOR,
      shells: TANK_START_SHELLS,
      mines: TANK_START_MINES,
      trees: 0,
      onBoat: false,
      alive: true,
      respawnTick: 0,
      fireCooldown: 0,
      carriedPill: null,
      gunRange: SHELL_RANGE,
      builder: { phase: 'in_tank', x: 0, y: 0, order: null, workLeft: 0, respawnTick: 0 },
      kills: 0,
      deaths: 0,
      caps: 0,
      bountyKills: 0,
      revengeKills: 0,
      paybackKills: 0,
      treesChopped: 0,
      roadsBuilt: 0,
      wallsBuilt: 0,
      pillsBuilt: 0,
    };
    this.placeAtSpawn(tank);
    this.tanks.set(id, tank);
    this.inputs.set(id, { accel: 0, turn: 0, fire: false });
    return tank;
  }

  removeTank(id: number): void {
    const tank = this.tanks.get(id);
    if (!tank) return;
    if (tank.carriedPill !== null) this.dropCarriedPill(tank);
    this.tanks.delete(id);
    this.inputs.delete(id);
    this.nudges.delete(id);
  }

  setInput(id: number, input: TankInput): void {
    if (!this.tanks.has(id)) return;
    // Sanitize at the sim boundary: input arrives from the network and from
    // NPC steering math, either of which can produce NaN/out-of-range values
    // that would otherwise poison tank.dir/speed for the rest of the war.
    this.inputs.set(id, {
      accel: clamp(Number.isFinite(input.accel) ? input.accel : 0, -1, 1),
      turn: clamp(Number.isFinite(input.turn) ? input.turn : 0, -1, 1),
      fire: !!input.fire,
    });
  }

  /** Classic Bolo range control: shells detonate at this distance. */
  setGunRange(id: number, range: number): void {
    const tank = this.tanks.get(id);
    if (!tank || !Number.isFinite(range)) return;
    tank.gunRange = clamp(range, 1, SHELL_RANGE);
  }

  /**
   * Set a player tank's heading from the client's authoritative value.
   * Rate-limited to turnRate per tick as an anti-cheat safety net —
   * in normal play the client respects the same limit, so this clamp
   * never triggers. The 1.5× margin absorbs tick-jitter.
   */
  setHeading(id: number, dir: number): void {
    const tank = this.tanks.get(id);
    if (!tank || !Number.isFinite(dir)) return;
    const delta = angleDelta(tank.dir, dir);
    const maxStep = this.tuning.turnRate * DT * 1.5;
    const clamped = clamp(delta, -maxStep, maxStep);
    tank.dir += clamped;
    if (tank.dir > Math.PI) tank.dir -= 2 * Math.PI;
    else if (tank.dir < -Math.PI) tank.dir += 2 * Math.PI;
  }

  /**
   * Queue a fine-aim rotation. Drained in tickTank at TANK_TURN_RATE, so taps
   * are never lost to tick quantization but also can't out-turn a held key.
   */
  addNudge(id: number, radians: number): void {
    if (!this.tanks.has(id) || !Number.isFinite(radians)) return;
    const pending = (this.nudges.get(id) ?? 0) + radians;
    this.nudges.set(id, clamp(pending, -Math.PI, Math.PI));
  }

  /** Spawn at a friendly base; with no bases left, fall back to a coastal boat spawn. */
  private placeAtSpawn(tank: Tank, baseId?: number): void {
    const friendly = this.bases.filter((b) => b.owner === tank.faction);
    let base = baseId !== undefined ? friendly.find((b) => b.id === baseId) : undefined;
    if (!base && friendly.length > 0) {
      base = friendly[Math.floor(Math.random() * friendly.length)];
    }
    if (base) {
      tank.x = base.x + 0.5 + (Math.random() * 2 - 1);
      tank.y = base.y + 0.5 + (Math.random() * 2 - 1);
      tank.onBoat = false;
    } else {
      // Bolo-style: come ashore on a boat from your faction's corner of the sea
      const corner = tank.faction === 'dawn' ? [8, 8] : [W - 8, W - 8];
      tank.x = corner[0] + Math.random() * 4;
      tank.y = corner[1] + Math.random() * 4;
      tank.onBoat = true;
    }
    tank.dir = Math.atan2(W / 2 - tank.y, W / 2 - tank.x);
    tank.speed = 0;
  }

  respawn(id: number, baseId?: number): void {
    const tank = this.tanks.get(id);
    if (!tank || tank.alive || this.tick < tank.respawnTick) return;
    tank.alive = true;
    tank.armor = TANK_START_ARMOR;
    tank.engagedTick = undefined;
    tank.lastDamagedTick = undefined;
    tank.turnSpeed = 0;
    tank.shells = TANK_START_SHELLS;
    tank.mines = TANK_START_MINES;
    tank.trees = 0;
    tank.carriedPill = null;
    tank.builder = { phase: 'in_tank', x: 0, y: 0, order: null, workLeft: 0, respawnTick: 0 };
    this.placeAtSpawn(tank, baseId);
  }

  // ---------- builder orders (public API → BuilderSystem) ----------

  builderOrder(id: number, kind: BuilderOrderKind, tx: number, ty: number): string | null {
    return this.builderSys.order(id, kind, tx, ty);
  }

  builderRecall(id: number): void {
    this.builderSys.recall(id);
  }

  // ---------- main tick ----------

  doTick(warMinutes: number): TickResult {
    this.tick++;
    resetAccumulators(this);

    for (const tank of this.tanks.values()) {
      if (!tank.alive) {
        // auto-respawn (humans can also request a specific base before this fires)
        if (this.tick >= tank.respawnTick) this.respawn(tank.id);
        continue;
      }
      this.tankSys.tick(tank);
      this.builderSys.tick(tank);
    }
    this.shellSys.tick();
    this.pillSys.tick();
    this.baseSys.tick(warMinutes);

    const warEnded = warMinutes >= WAR_MIN_MINUTES ? this.checkVictory() : null;

    return {
      events: this.events,
      terrainChanges: this.terrainChanges,
      mineChanges: this.mineChanges,
      pillsChanged: this.pillsChanged,
      basesChanged: this.basesChanged,
      warEnded,
      stats: this.stats,
    };
  }

  /** Fortifications breached: the base stands neutral until someone claims it. */
  neutralizeBase(base: Base, by: Owner): void {
    base.owner = 'neutral';
    base.hp = 0;
    this.basesChanged = true;
    this.events.push({ e: 'base_neutralized', baseId: base.id, by });
  }

  /**
   * Wars end by conquest only. DOMINANCE breaks the endgame turtle: a faction
   * holding >= DOMINANCE_BASES starts a visible countdown and wins after
   * DOMINANCE_MINUTES unless the grip is broken.
   */
  private checkVictory(): Faction | null {
    // total conquest ends the war at any time (past WAR_MIN_MINUTES)
    for (const f of FACTIONS) {
      if (this.bases.every((b) => b.owner === f)) return f;
    }

    let leader: Faction | null = null;
    for (const f of FACTIONS) {
      let held = 0;
      for (const b of this.bases) if (b.owner === f) held++;
      if (held >= DOMINANCE_BASES) leader = f;
    }
    if (leader !== this.dominantFaction) {
      this.dominantFaction = leader;
      this.dominantSinceTick = this.tick;
      this.events.push({
        e: 'dominance',
        faction: leader,
        endsAt: leader ? Date.now() + DOMINANCE_MINUTES * 60_000 : null,
      });
    }
    if (this.dominantFaction && this.tick - this.dominantSinceTick >= DOMINANCE_MINUTES * 60 * TICK_HZ) {
      return this.dominantFaction;
    }
    return null;
  }

  // ---------- persistence ----------

  serializeMeta(): Record<string, unknown> {
    return {
      warNumber: this.warNumber,
      seed: this.seed,
      startedAt: this.startedAt,
      tick: this.tick,
      nextId: this.nextId,
      bases: this.bases,
      pills: this.pills,
      dominantFaction: this.dominantFaction,
      dominantSinceTick: this.dominantSinceTick,
    };
  }

  static restore(meta: Record<string, unknown>, terrain: Uint8Array, mines: Uint8Array): World {
    const w = new World(meta.warNumber as number, meta.seed as number, meta.startedAt as number);
    w.tick = meta.tick as number;
    w.nextId = meta.nextId as number;
    w.bases = meta.bases as Base[];
    w.pills = meta.pills as Pillbox[];
    w.dominantFaction = (meta.dominantFaction as Faction | null) ?? null;
    w.dominantSinceTick = (meta.dominantSinceTick as number) ?? 0;
    // migrate pre-fortification saves: grant owned bases full hp
    for (const b of w.bases) {
      b.hp ??= b.owner === 'neutral' ? BASE_NEUTRAL_START_HP : BASE_MAX_HP;
    }
    w.terrain = terrain;
    w.mines = mines;
    return w;
  }
}
