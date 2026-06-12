/**
 * Server-authoritative simulation. Pure TypeScript with no Workers
 * dependencies so it can be unit-tested and reasoned about in isolation.
 * The Durable Object drives `tick()` at TICK_HZ and ships the returned
 * deltas to clients.
 */
import {
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_MINE_STOCK,
  BASE_MAX_SHELL_STOCK,
  BASE_REFUEL_INTERVAL,
  BASE_REFUEL_RADIUS,
  BASE_REGEN_INTERVAL,
  BASE_SIEGE_DAMAGE,
  BASE_SIEGE_DRAIN_INTERVAL,
  BOAT_SPEED,
  BUILDER_MAX_RANGE,
  BUILDER_RESPAWN_SECONDS,
  BUILDER_SPEED,
  BUILDER_WATER_SPEED,
  BUILDER_WORK_SECONDS,
  COST_BOAT,
  COST_PILL_PLACE,
  COST_ROAD,
  COST_WALL,
  COST_WALL_REPAIR,
  DT,
  FACTIONS,
  type Faction,
  MAP_SIZE,
  MINE_DAMAGE,
  type Owner,
  PILL_COOLDOWN_ANGRY,
  PILL_COOLDOWN_CALM,
  PILL_MAX_HP,
  PILL_RANGE,
  PILL_REGEN_SECONDS,
  PILL_REPAIR_HP,
  PILL_REPAIR_TREES,
  SHELL_DAMAGE,
  SHELL_RANGE,
  SHELL_SPEED,
  TANK_ACCEL,
  TANK_BRAKE,
  TANK_FIRE_COOLDOWN,
  TANK_MAX_ARMOR,
  TANK_MAX_MINES,
  TANK_MAX_SHELLS,
  TANK_MAX_TREES,
  TANK_RADIUS,
  TANK_RESPAWN_SECONDS,
  TANK_START_ARMOR,
  TANK_START_MINES,
  TANK_START_SHELLS,
  TANK_TURN_ACCEL,
  TANK_TURN_RATE,
  TANK_MAX_SPEED,
  TICK_HZ,
  TREES_PER_FOREST_TILE,
  WAR_MIN_MINUTES,
} from '@bolo/shared';
import {
  type Base,
  type BuilderOrderKind,
  type GameEvent,
  type Pillbox,
  type Shell,
  type Tank,
  type WarInfo,
  generateMap,
  idx,
  MineState,
  minedTerrain,
  shelledTerrain,
  Terrain,
  TERRAIN,
} from '@bolo/shared';

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
export type StatEvent = { name: 'shot' | 'kill' } & Record<string, string | number | boolean | undefined>;

const W = MAP_SIZE;

export class World {
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

  private nextId = 1;
  private inputs = new Map<number, TankInput>();
  /** queued fine-aim rotation per tank, drained at TANK_TURN_RATE (see addNudge) */
  private nudges = new Map<number, number>();
  private refuelTimers = new Map<number, number>(); // baseId -> seconds until next transfer
  private regenTimers = new Map<number, number>();

  // accumulated during a tick
  private events: GameEvent[] = [];
  private stats: StatEvent[] = [];
  private terrainChanges: [number, number, number][] = [];
  private mineChanges: [number, number, number][] = [];
  private pillsChanged = false;
  private basesChanged = false;

  constructor(warNumber: number, seed: number, startedAt = Date.now()) {
    this.warNumber = warNumber;
    this.seed = seed;
    this.startedAt = startedAt;
    const gen = generateMap(seed);
    this.terrain = gen.terrain;
    this.mines = gen.mines;
    this.bases = gen.bases;
    this.pills = gen.pills;
  }

  // ---------- queries ----------

  tileAt(x: number, y: number): Terrain {
    const xi = Math.floor(x);
    const yi = Math.floor(y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= W) return Terrain.DeepSea;
    return this.terrain[idx(xi, yi)] as Terrain;
  }

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
      builder: { phase: 'in_tank', x: 0, y: 0, order: null, workLeft: 0, respawnTick: 0 },
      kills: 0,
      deaths: 0,
      caps: 0,
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
    if (this.tanks.has(id)) this.inputs.set(id, input);
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
    tank.turnSpeed = 0;
    tank.shells = TANK_START_SHELLS;
    tank.mines = TANK_START_MINES;
    tank.trees = 0;
    tank.carriedPill = null;
    tank.builder = { phase: 'in_tank', x: 0, y: 0, order: null, workLeft: 0, respawnTick: 0 };
    this.placeAtSpawn(tank, baseId);
  }

  // ---------- builder orders ----------

  builderOrder(id: number, kind: BuilderOrderKind, tx: number, ty: number): string | null {
    const tank = this.tanks.get(id);
    if (!tank || !tank.alive) return 'not alive';
    const b = tank.builder;
    if (b.phase !== 'in_tank') return 'builder is out';
    if (tx < 0 || ty < 0 || tx >= W || ty >= W) return 'out of bounds';
    const dist = Math.hypot(tx + 0.5 - tank.x, ty + 0.5 - tank.y);
    if (dist > BUILDER_MAX_RANGE) return 'too far away';

    const t = this.terrain[idx(tx, ty)] as Terrain;
    switch (kind) {
      case 'harvest':
        if (t !== Terrain.Forest) return 'no trees there';
        break;
      case 'road':
        if (!canBuildOn(t) && t !== Terrain.River) return 'cannot pave that';
        if (tank.trees < COST_ROAD) return 'not enough trees';
        tank.trees -= COST_ROAD;
        break;
      case 'wall': {
        const cost = t === Terrain.ShotBuilding ? COST_WALL_REPAIR : COST_WALL;
        if (!canBuildOn(t)) return 'cannot build there';
        if (tank.trees < cost) return 'not enough trees';
        tank.trees -= cost;
        break;
      }
      case 'boat':
        if (t !== Terrain.River) return 'boats are built on river';
        if (tank.trees < COST_BOAT) return 'not enough trees';
        tank.trees -= COST_BOAT;
        break;
      case 'pillbox': {
        const pillHere = this.pills.find((p) => !p.inTank && p.x === tx && p.y === ty);
        if (pillHere) {
          if (pillHere.owner !== tank.faction && pillHere.hp > 0) return 'hostile pillbox';
          if (tank.trees < PILL_REPAIR_TREES) return 'not enough trees';
          tank.trees -= PILL_REPAIR_TREES;
        } else {
          if (tank.carriedPill === null) return 'no pillbox carried';
          if (!canBuildOn(t)) return 'cannot place there';
          if (tank.trees < COST_PILL_PLACE) return 'not enough trees';
          tank.trees -= COST_PILL_PLACE;
        }
        break;
      }
      case 'mine':
        if (t === Terrain.DeepSea || t === Terrain.River || t === Terrain.BoatTile) return 'cannot mine water';
        if (this.mines[idx(tx, ty)] !== MineState.None) return 'already mined';
        if (tank.mines < 1) return 'no mines';
        tank.mines -= 1;
        break;
    }

    b.order = { kind, tx, ty };
    b.phase = 'outbound';
    b.x = tank.x;
    b.y = tank.y;
    return null;
  }

  builderRecall(id: number): void {
    const tank = this.tanks.get(id);
    if (!tank) return;
    const b = tank.builder;
    if (b.phase === 'outbound' || b.phase === 'working') {
      this.refundOrder(tank);
      b.order = null;
      b.phase = 'returning';
    }
  }

  private refundOrder(tank: Tank): void {
    const o = tank.builder.order;
    if (!o) return;
    switch (o.kind) {
      case 'road':
        tank.trees = Math.min(TANK_MAX_TREES, tank.trees + COST_ROAD);
        break;
      case 'wall':
        tank.trees = Math.min(TANK_MAX_TREES, tank.trees + COST_WALL);
        break;
      case 'boat':
        tank.trees = Math.min(TANK_MAX_TREES, tank.trees + COST_BOAT);
        break;
      case 'mine':
        tank.mines = Math.min(TANK_MAX_MINES, tank.mines + 1);
        break;
      default:
        break;
    }
  }

  // ---------- main tick ----------

  doTick(warMinutes: number): TickResult {
    this.tick++;
    this.events = [];
    this.stats = [];
    this.terrainChanges = [];
    this.mineChanges = [];
    this.pillsChanged = false;
    this.basesChanged = false;

    for (const tank of this.tanks.values()) {
      if (!tank.alive) {
        // auto-respawn (humans can also request a specific base before this fires)
        if (this.tick >= tank.respawnTick) this.respawn(tank.id);
        continue;
      }
      this.tickTank(tank);
      this.tickBuilder(tank);
    }
    this.tickShells();
    this.tickPills();
    this.tickBases();

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

  private tickTank(tank: Tank): void {
    const input = this.inputs.get(tank.id) ?? { accel: 0, turn: 0, fire: false };

    // rotational inertia: the turn rate ramps UP toward the input's target
    // (a tank has mass), but slowing, releasing or reversing is instant so
    // aim never overshoots the moment you let go
    const targetRate = clamp(input.turn, -1, 1) * TANK_TURN_RATE;
    if (targetRate * tank.turnSpeed < 0) tank.turnSpeed = 0; // reversal restarts the ramp
    if (Math.abs(targetRate) <= Math.abs(tank.turnSpeed)) {
      tank.turnSpeed = targetRate;
    } else {
      tank.turnSpeed =
        targetRate > 0
          ? Math.min(targetRate, tank.turnSpeed + TANK_TURN_ACCEL * DT)
          : Math.max(targetRate, tank.turnSpeed - TANK_TURN_ACCEL * DT);
    }
    // held turn + queued fine-aim nudges, under one per-tick rotation budget:
    // the held key takes priority, nudges drain from whatever budget remains
    const turnStep = tank.turnSpeed * DT;
    const pending = this.nudges.get(tank.id) ?? 0;
    const budget = TANK_TURN_RATE * DT - Math.abs(turnStep);
    const nudgeStep = clamp(pending, -budget, budget);
    tank.dir += turnStep + nudgeStep;
    if (Math.abs(pending - nudgeStep) > 1e-6) this.nudges.set(tank.id, pending - nudgeStep);
    else this.nudges.delete(tank.id);
    if (tank.dir > Math.PI) tank.dir -= 2 * Math.PI;
    else if (tank.dir < -Math.PI) tank.dir += 2 * Math.PI;

    const here = this.tileAt(tank.x, tank.y);
    const onWater = here === Terrain.DeepSea || here === Terrain.River || here === Terrain.BoatTile;
    let maxSpeed: number;
    if (tank.onBoat && onWater) {
      maxSpeed = BOAT_SPEED;
    } else {
      maxSpeed = TANK_MAX_SPEED * TERRAIN[here].tankSpeed;
    }

    const target = input.accel > 0 ? maxSpeed : 0;
    const rate = input.accel < 0 ? TANK_BRAKE : TANK_ACCEL;
    if (tank.speed < target) tank.speed = Math.min(target, tank.speed + TANK_ACCEL * DT);
    else tank.speed = Math.max(target, tank.speed - rate * DT);

    if (tank.speed > 0) {
      const nx = tank.x + Math.cos(tank.dir) * tank.speed * DT;
      const ny = tank.y + Math.sin(tank.dir) * tank.speed * DT;
      const nextTile = this.tileAt(nx, ny);
      const blocked =
        nextTile === Terrain.Building ||
        (!tank.onBoat && nextTile === Terrain.DeepSea && here !== Terrain.DeepSea);
      if (blocked) {
        tank.speed = 0;
      } else {
        const prevTileX = Math.floor(tank.x);
        const prevTileY = Math.floor(tank.y);
        tank.x = clamp(nx, 0.5, W - 0.5);
        tank.y = clamp(ny, 0.5, W - 0.5);
        this.handleTileTransitions(tank, prevTileX, prevTileY);
      }
    }

    // sinking: in deep sea with no boat
    if (!tank.onBoat && this.tileAt(tank.x, tank.y) === Terrain.DeepSea) {
      this.killTank(tank, 'sea', null);
      return;
    }

    // firing
    tank.fireCooldown = Math.max(0, tank.fireCooldown - DT);
    if (input.fire && tank.fireCooldown <= 0 && tank.shells > 0) {
      tank.shells--;
      tank.fireCooldown = TANK_FIRE_COOLDOWN;
      this.shells.push({
        id: this.nextId++,
        x: tank.x + Math.cos(tank.dir) * (TANK_RADIUS + 0.1),
        y: tank.y + Math.sin(tank.dir) * (TANK_RADIUS + 0.1),
        dir: tank.dir,
        faction: tank.faction,
        ownerTank: tank.id,
        range: SHELL_RANGE,
      });
    }

    // squash enemy builders under the treads
    for (const other of this.tanks.values()) {
      const b = other.builder;
      if (other.faction === tank.faction) continue;
      if (b.phase === 'outbound' || b.phase === 'working' || b.phase === 'returning') {
        if (Math.hypot(b.x - tank.x, b.y - tank.y) < TANK_RADIUS) {
          this.killBuilder(other);
        }
      }
    }
  }

  private handleTileTransitions(tank: Tank, prevX: number, prevY: number): void {
    const xi = Math.floor(tank.x);
    const yi = Math.floor(tank.y);
    if (xi === prevX && yi === prevY) return;
    const t = this.terrain[idx(xi, yi)] as Terrain;

    // embark: drive onto a built boat
    if (t === Terrain.BoatTile && !tank.onBoat) {
      tank.onBoat = true;
      this.setTerrain(xi, yi, Terrain.River);
    }
    // disembark: boat -> land leaves the boat moored on the water tile behind you
    if (tank.onBoat && TERRAIN[t].tankSpeed > 0 && t !== Terrain.River && t !== Terrain.DeepSea && t !== Terrain.BoatTile) {
      tank.onBoat = false;
      const prevT = this.terrain[idx(prevX, prevY)] as Terrain;
      if (prevT === Terrain.River) this.setTerrain(prevX, prevY, Terrain.BoatTile);
    }

    // mines
    const m = this.mines[idx(xi, yi)];
    if (m !== MineState.None) this.detonateMine(xi, yi);

    // pick up a dead pillbox
    const pill = this.pills.find((p) => !p.inTank && p.hp <= 0 && p.x === xi && p.y === yi);
    if (pill && tank.carriedPill === null) {
      pill.inTank = true;
      pill.owner = tank.faction;
      tank.carriedPill = pill.id;
      tank.caps++;
      this.pillsChanged = true;
      this.events.push({ e: 'pill_captured', pillId: pill.id, by: tank.faction, handle: tank.handle });
    }
  }

  private detonateMine(x: number, y: number): void {
    if (this.mines[idx(x, y)] === MineState.None) return;
    this.setMine(x, y, MineState.None);
    this.events.push({ e: 'boom', x: x + 0.5, y: y + 0.5, kind: 'mine' });
    const nt = minedTerrain(this.terrain[idx(x, y)] as Terrain);
    if (nt !== null) this.setTerrain(x, y, nt);

    for (const tank of this.tanks.values()) {
      if (!tank.alive) continue;
      if (Math.abs(tank.x - (x + 0.5)) < 1 && Math.abs(tank.y - (y + 0.5)) < 1) {
        this.damageTank(tank, MINE_DAMAGE, 'mine', null);
      }
      const b = tank.builder;
      if (b.phase !== 'in_tank' && b.phase !== 'dead' && Math.hypot(b.x - (x + 0.5), b.y - (y + 0.5)) < 1) {
        this.killBuilder(tank);
      }
    }

    // chain reaction with adjacent mines, classic Bolo
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ax = x + dx;
      const ay = y + dy;
      if (ax >= 0 && ay >= 0 && ax < W && ay < W && this.mines[idx(ax, ay)] !== MineState.None) {
        this.detonateMine(ax, ay);
      }
    }
  }

  // ---------- shells ----------

  /** One telemetry event per shell, emitted when it resolves (hit or expired). */
  private shotResolved(shell: Shell, outcome: string, victim?: Tank): void {
    const fromPill = shell.ownerTank < 0;
    const shooter = fromPill ? undefined : this.tanks.get(shell.ownerTank);
    this.stats.push({
      name: 'shot',
      outcome, // 'tank' | 'builder' | 'pill' | 'base' | 'wall' | 'expired'
      shooter: fromPill ? 'pillbox' : 'tank',
      shooter_npc: shooter?.npc,
      shooter_client: shooter?.client,
      shooter_faction: String(shell.faction),
      travel_tiles: round2stat((fromPill ? PILL_RANGE : SHELL_RANGE) - shell.range),
      target_npc: victim?.npc,
      target_client: victim?.client,
    });
  }

  private tickShells(): void {
    const step = 0.25; // substep length in tiles, to avoid tunnelling
    const survivors: Shell[] = [];
    for (const shell of this.shells) {
      let travel = SHELL_SPEED * DT;
      let dead = false;
      while (travel > 0 && !dead) {
        const d = Math.min(step, travel, shell.range);
        shell.x += Math.cos(shell.dir) * d;
        shell.y += Math.sin(shell.dir) * d;
        shell.range -= d;
        travel -= d;
        dead = this.shellCollide(shell);
        if (!dead && shell.range <= 0) {
          this.shellDetonateTerrain(shell);
          this.shotResolved(shell, 'expired');
          dead = true;
        }
      }
      if (!dead) survivors.push(shell);
    }
    this.shells = survivors;
  }

  private shellCollide(shell: Shell): boolean {
    if (shell.x < 0 || shell.y < 0 || shell.x >= W || shell.y >= W) {
      this.shotResolved(shell, 'expired');
      return true;
    }
    const xi = Math.floor(shell.x);
    const yi = Math.floor(shell.y);
    const t = this.terrain[idx(xi, yi)] as Terrain;

    if (TERRAIN[t].blocksShells) {
      this.shellDetonateTerrain(shell);
      this.shotResolved(shell, 'wall');
      return true;
    }

    // bombardment: shells drain a hostile base's armor stock until it can be overrun
    const base = this.bases.find((b) => b.x === xi && b.y === yi);
    if (base && base.owner !== shell.faction && base.armorStock > 0) {
      base.armorStock = Math.max(0, base.armorStock - SHELL_DAMAGE);
      this.basesChanged = true;
      this.events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
      this.shotResolved(shell, 'base');
      return true;
    }

    // pillboxes occupy their tile
    const pill = this.pills.find((p) => !p.inTank && p.hp > 0 && p.x === xi && p.y === yi);
    if (pill && pill.owner !== shell.faction) {
      pill.hp = Math.max(0, pill.hp - SHELL_DAMAGE);
      pill.cooldown = Math.min(pill.cooldown, this.pillCooldownFor(pill)); // freshly angry
      this.pillsChanged = true;
      this.events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
      this.shotResolved(shell, 'pill');
      return true;
    }

    for (const tank of this.tanks.values()) {
      if (!tank.alive || tank.faction === shell.faction || tank.id === shell.ownerTank) continue;
      if (Math.hypot(tank.x - shell.x, tank.y - shell.y) < TANK_RADIUS) {
        const killer = this.tanks.get(shell.ownerTank) ?? null;
        this.shotResolved(shell, 'tank', tank);
        this.damageTank(tank, SHELL_DAMAGE, shell.ownerTank < 0 ? 'pillbox' : 'shell', killer);
        this.events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
        return true;
      }
      const b = tank.builder;
      if (
        tank.faction !== shell.faction &&
        (b.phase === 'outbound' || b.phase === 'working' || b.phase === 'returning') &&
        Math.hypot(b.x - shell.x, b.y - shell.y) < 0.3
      ) {
        this.killBuilder(tank);
        this.shotResolved(shell, 'builder', tank);
        return true;
      }
    }
    return false;
  }

  private shellDetonateTerrain(shell: Shell): void {
    const xi = Math.floor(shell.x);
    const yi = Math.floor(shell.y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= W) return;
    const t = this.terrain[idx(xi, yi)] as Terrain;
    const nt = shelledTerrain(t);
    if (nt !== null) {
      this.setTerrain(xi, yi, nt);
      this.events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
    }
  }

  // ---------- pillboxes ----------

  private pillCooldownFor(pill: Pillbox): number {
    const anger = 1 - pill.hp / PILL_MAX_HP;
    return PILL_COOLDOWN_CALM + (PILL_COOLDOWN_ANGRY - PILL_COOLDOWN_CALM) * anger;
  }

  private tickPills(): void {
    for (const pill of this.pills) {
      if (pill.inTank || pill.hp <= 0) continue;

      // slow self-repair
      if (pill.hp < PILL_MAX_HP && this.tick % (PILL_REGEN_SECONDS * TICK_HZ) === 0) {
        pill.hp++;
        this.pillsChanged = true;
      }

      pill.cooldown = Math.max(0, pill.cooldown - DT);
      if (pill.cooldown > 0) continue;

      // neutral pillboxes hate everyone; owned ones hate the other faction
      let target: Tank | null = null;
      let bestD = PILL_RANGE;
      for (const tank of this.tanks.values()) {
        if (!tank.alive) continue;
        if (pill.owner !== 'neutral' && tank.faction === pill.owner) continue;
        // hidden in forest = safe from pillboxes too
        if (this.tileAt(tank.x, tank.y) === Terrain.Forest) continue;
        const d = Math.hypot(tank.x - (pill.x + 0.5), tank.y - (pill.y + 0.5));
        if (d < bestD) {
          bestD = d;
          target = tank;
        }
      }
      if (target) {
        const px = pill.x + 0.5;
        const py = pill.y + 0.5;
        // simple leading: aim at where the target will be in flight-time
        const t = bestD / SHELL_SPEED;
        const ax = target.x + Math.cos(target.dir) * target.speed * t;
        const ay = target.y + Math.sin(target.dir) * target.speed * t;
        const dir = Math.atan2(ay - py, ax - px);
        this.shells.push({
          id: this.nextId++,
          x: px + Math.cos(dir) * 0.5,
          y: py + Math.sin(dir) * 0.5,
          dir,
          faction: pill.owner,
          ownerTank: -1 - pill.id,
          range: PILL_RANGE,
        });
        pill.cooldown = this.pillCooldownFor(pill);
      }
    }
  }

  /** A killed tank's carried pillbox is dumped on the ground, battered but salvageable. */
  private dropCarriedPill(tank: Tank): void {
    if (tank.carriedPill === null) return;
    const pill = this.pills.find((p) => p.id === tank.carriedPill);
    tank.carriedPill = null;
    if (!pill) return;
    pill.inTank = false;
    pill.owner = 'neutral';
    pill.hp = 0;
    pill.x = clampInt(Math.floor(tank.x), 0, W - 1);
    pill.y = clampInt(Math.floor(tank.y), 0, W - 1);
    this.pillsChanged = true;
  }

  // ---------- bases ----------

  private tickBases(): void {
    for (const base of this.bases) {
      const cx = base.x + 0.5;
      const cy = base.y + 0.5;

      // passive restock for owned bases — paused while enemies contest the pad
      const contested = [...this.tanks.values()].some(
        (t) => t.alive && t.faction !== base.owner && Math.hypot(t.x - cx, t.y - cy) < 6,
      );
      if (base.owner !== 'neutral' && !contested) {
        const t = (this.regenTimers.get(base.id) ?? BASE_REGEN_INTERVAL) - DT;
        if (t <= 0) {
          this.regenTimers.set(base.id, BASE_REGEN_INTERVAL);
          base.armorStock = Math.min(BASE_MAX_ARMOR_STOCK, base.armorStock + 1);
          // shells are the war's working currency; restock them faster
          base.shellStock = Math.min(BASE_MAX_SHELL_STOCK, base.shellStock + 3);
          if (this.tick % (BASE_REGEN_INTERVAL * TICK_HZ * 4) === 0) {
            base.mineStock = Math.min(BASE_MAX_MINE_STOCK, base.mineStock + 1);
          }
        } else {
          this.regenTimers.set(base.id, t);
        }
      }

      const timer = (this.refuelTimers.get(base.id) ?? 0) - DT;
      this.refuelTimers.set(base.id, timer);

      for (const tank of this.tanks.values()) {
        if (!tank.alive) continue;
        if (Math.hypot(tank.x - cx, tank.y - cy) > BASE_REFUEL_RADIUS) continue;

        if (base.owner === 'neutral') {
          base.owner = tank.faction;
          tank.caps++;
          this.basesChanged = true;
          this.events.push({ e: 'base_captured', baseId: base.id, by: tank.faction, handle: tank.handle });
        } else if (base.owner === tank.faction) {
          if (timer <= 0) {
            this.refuelTimers.set(base.id, BASE_REFUEL_INTERVAL);
            let used = false;
            if (tank.armor < TANK_MAX_ARMOR && base.armorStock > 0) {
              tank.armor++;
              base.armorStock--;
              used = true;
              // patched back to full: the next damage starts a new engagement
              if (tank.armor >= TANK_MAX_ARMOR) tank.engagedTick = undefined;
            }
            if (tank.shells < TANK_MAX_SHELLS && base.shellStock > 0) {
              tank.shells++;
              base.shellStock--;
              used = true;
            }
            if (tank.mines < TANK_MAX_MINES && base.mineStock > 0) {
              tank.mines++;
              base.mineStock--;
              used = true;
            }
            if (used) this.basesChanged = true;
          }
        } else {
          // enemy on the pad: a siege. The base spends armor stock to repel.
          if (timer <= 0) {
            this.refuelTimers.set(base.id, BASE_SIEGE_DRAIN_INTERVAL);
            if (base.armorStock > 0) {
              base.armorStock--;
              this.damageTank(tank, BASE_SIEGE_DAMAGE, 'pillbox', null);
              this.basesChanged = true;
            } else {
              base.owner = tank.faction;
              tank.caps++;
              this.basesChanged = true;
              this.events.push({ e: 'base_captured', baseId: base.id, by: tank.faction, handle: tank.handle });
            }
          }
        }
      }
    }
  }

  private checkVictory(): Faction | null {
    for (const f of FACTIONS) {
      if (this.bases.every((b) => b.owner === f)) return f;
    }
    return null;
  }

  // ---------- builder ----------

  private tickBuilder(tank: Tank): void {
    const b = tank.builder;
    switch (b.phase) {
      case 'in_tank':
        return;
      case 'dead':
        if (this.tick >= b.respawnTick) b.phase = 'in_tank';
        return;
      case 'outbound': {
        if (!b.order) {
          b.phase = 'returning';
          return;
        }
        const tx = b.order.tx + 0.5;
        const ty = b.order.ty + 0.5;
        if (this.moveBuilder(b, tx, ty)) {
          b.phase = 'working';
          b.workLeft = BUILDER_WORK_SECONDS;
        }
        return;
      }
      case 'working': {
        b.workLeft -= DT;
        if (b.workLeft <= 0) {
          this.completeBuilderJob(tank);
          b.order = null;
          b.phase = 'returning';
        }
        return;
      }
      case 'returning': {
        if (!tank.alive) {
          this.killBuilder(tank);
          return;
        }
        if (this.moveBuilder(b, tank.x, tank.y)) {
          b.phase = 'in_tank';
        }
        return;
      }
    }
  }

  /** Move builder toward (tx, ty); returns true when arrived. */
  private moveBuilder(b: { x: number; y: number }, tx: number, ty: number): boolean {
    const dx = tx - b.x;
    const dy = ty - b.y;
    const dist = Math.hypot(dx, dy);
    if (dist < 0.15) return true;
    const here = this.tileAt(b.x, b.y);
    const props = TERRAIN[here];
    const speed = props.builderSpeed > 0 ? BUILDER_SPEED * props.builderSpeed : BUILDER_WATER_SPEED;
    const step = Math.min(dist, speed * DT);
    const nx = b.x + (dx / dist) * step;
    const ny = b.y + (dy / dist) * step;
    // builders walk around buildings rather than through them
    if (this.tileAt(nx, ny) === Terrain.Building) {
      // try sliding along one axis
      if (this.tileAt(nx, b.y) !== Terrain.Building) b.x = nx;
      else if (this.tileAt(b.x, ny) !== Terrain.Building) b.y = ny;
      return false;
    }
    b.x = nx;
    b.y = ny;
    return Math.hypot(tx - b.x, ty - b.y) < 0.15;
  }

  private completeBuilderJob(tank: Tank): void {
    const o = tank.builder.order;
    if (!o) return;
    const t = this.terrain[idx(o.tx, o.ty)] as Terrain;
    switch (o.kind) {
      case 'harvest':
        if (t === Terrain.Forest) {
          this.setTerrain(o.tx, o.ty, Terrain.Grass);
          tank.trees = Math.min(TANK_MAX_TREES, tank.trees + TREES_PER_FOREST_TILE);
        }
        break;
      case 'road':
        if (canBuildOn(t) || t === Terrain.River) this.setTerrain(o.tx, o.ty, Terrain.Road);
        else this.refundOrder(tank);
        break;
      case 'wall':
        if (canBuildOn(t)) this.setTerrain(o.tx, o.ty, Terrain.Building);
        else this.refundOrder(tank);
        break;
      case 'boat':
        if (t === Terrain.River) this.setTerrain(o.tx, o.ty, Terrain.BoatTile);
        else this.refundOrder(tank);
        break;
      case 'pillbox': {
        const pillHere = this.pills.find((p) => !p.inTank && p.x === o.tx && p.y === o.ty);
        if (pillHere && (pillHere.owner === tank.faction || pillHere.hp <= 0)) {
          pillHere.owner = tank.faction;
          pillHere.hp = Math.min(PILL_MAX_HP, pillHere.hp + PILL_REPAIR_HP);
          this.pillsChanged = true;
        } else if (tank.carriedPill !== null && canBuildOn(t)) {
          const pill = this.pills.find((p) => p.id === tank.carriedPill);
          if (pill) {
            pill.inTank = false;
            pill.owner = tank.faction;
            pill.hp = Math.floor(PILL_MAX_HP * 0.4);
            pill.x = o.tx;
            pill.y = o.ty;
            tank.carriedPill = null;
            this.pillsChanged = true;
            this.events.push({ e: 'pill_placed', pillId: pill.id, x: o.tx, y: o.ty, by: tank.faction });
          }
        } else {
          this.refundOrder(tank);
        }
        break;
      }
      case 'mine':
        if (this.mines[idx(o.tx, o.ty)] === MineState.None && t !== Terrain.River && t !== Terrain.DeepSea) {
          this.setMine(o.tx, o.ty, tank.faction === 'dawn' ? MineState.Dawn : MineState.Dusk);
        } else {
          this.refundOrder(tank);
        }
        break;
    }
  }

  private killBuilder(tank: Tank): void {
    const b = tank.builder;
    if (b.phase === 'dead' || b.phase === 'in_tank') return;
    this.refundOrder(tank);
    b.order = null;
    b.phase = 'dead';
    b.respawnTick = this.tick + BUILDER_RESPAWN_SECONDS * TICK_HZ;
    this.events.push({ e: 'builder_killed', tankId: tank.id });
  }

  // ---------- damage & death ----------

  private damageTank(tank: Tank, amount: number, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void {
    if (!tank.alive) return;
    if (tank.engagedTick === undefined) tank.engagedTick = this.tick;
    tank.armor -= amount;
    if (tank.armor <= 0) this.killTank(tank, cause, killer);
  }

  private killTank(tank: Tank, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void {
    if (!tank.alive) return;
    this.stats.push({
      name: 'kill',
      cause,
      ttk_s: tank.engagedTick !== undefined ? (this.tick - tank.engagedTick) / TICK_HZ : undefined,
      victim_npc: tank.npc,
      victim_client: tank.client,
      victim_faction: tank.faction,
      killer_npc: killer?.npc,
      killer_client: killer?.client,
      killer_faction: killer?.faction,
      kill_dist_tiles: killer ? round2stat(Math.hypot(killer.x - tank.x, killer.y - tank.y)) : undefined,
    });
    tank.engagedTick = undefined;
    tank.alive = false;
    tank.deaths++;
    tank.respawnTick = this.tick + TANK_RESPAWN_SECONDS * TICK_HZ;
    if (killer && killer.id !== tank.id) killer.kills++;
    this.dropCarriedPill(tank);
    if (tank.builder.phase !== 'in_tank' && tank.builder.phase !== 'dead') this.killBuilder(tank);
    tank.builder.phase = 'dead';
    tank.builder.respawnTick = tank.respawnTick;
    // a tank death scars the land
    const xi = clampInt(Math.floor(tank.x), 0, W - 1);
    const yi = clampInt(Math.floor(tank.y), 0, W - 1);
    const here = this.terrain[idx(xi, yi)] as Terrain;
    const nt = minedTerrain(here);
    if (nt !== null && here !== Terrain.Road) this.setTerrain(xi, yi, nt);
    this.events.push({
      e: 'kill',
      killer: killer?.handle ?? (cause === 'sea' ? 'the sea' : cause),
      victim: tank.handle,
      cause,
    });
    this.events.push({ e: 'boom', x: tank.x, y: tank.y, kind: 'shell' });
  }

  // ---------- mutation helpers ----------

  private setTerrain(x: number, y: number, t: Terrain): void {
    this.terrain[idx(x, y)] = t;
    this.terrainChanges.push([x, y, t]);
  }

  private setMine(x: number, y: number, m: MineState): void {
    this.mines[idx(x, y)] = m;
    this.mineChanges.push([x, y, m]);
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
    };
  }

  static restore(meta: Record<string, unknown>, terrain: Uint8Array, mines: Uint8Array): World {
    const w = new World(meta.warNumber as number, meta.seed as number, meta.startedAt as number);
    w.tick = meta.tick as number;
    w.nextId = meta.nextId as number;
    w.bases = meta.bases as Base[];
    w.pills = meta.pills as Pillbox[];
    w.terrain = terrain;
    w.mines = mines;
    return w;
  }
}

function canBuildOn(t: Terrain): boolean {
  return (
    t === Terrain.Grass ||
    t === Terrain.Swamp ||
    t === Terrain.Crater ||
    t === Terrain.Rubble ||
    t === Terrain.Road ||
    t === Terrain.ShotBuilding
  );
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

function round2stat(v: number): number {
  return Math.round(v * 100) / 100;
}

function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
