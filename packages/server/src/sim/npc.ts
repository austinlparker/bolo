/**
 * Garrison AI: server-side tanks that keep each faction populated so the
 * persistent war grinds on even when no humans are online. Deliberately
 * beatable — external bots connecting over the public protocol should be
 * able to outplay them.
 *
 * Capabilities:
 *  - Weighted A* pathfinding with boat-aware water traversal
 *  - Duel targeting with reaction delay + aim jitter
 *  - Threat assessment (retreat when outnumbered and fragile)
 *  - Shell dodging (perpendicular evasion)
 *  - Mine avoidance (hostile mines steered around)
 *  - Team awareness (focus fire, base defense, goal spreading)
 *  - Boat building (harvest → build boat → embark → cross water)
 *  - Tactical builder usage (roads on slow terrain, walls around bases,
 *    mines on approach lanes, pillbox placement, proactive harvesting)
 *
 * Navigation uses weighted A* over the tile grid, recomputed only when a
 * path is consumed or its goal changes, with local steering between
 * waypoints.
 */
import {
  type Faction,
  FACTIONS,
  idx,
  MAP_SIZE,
  MineState,
  NPC_MIN_PER_FACTION,
  NPC_MAX_TOTAL,
  PILL_RANGE,
  SHELL_RANGE,
  Terrain,
  TERRAIN,
  TICK_HZ,
} from '@bolo/shared';
import {
  BASE_REFUEL_RADIUS,
  BOAT_SPEED,
  BUILDER_MAX_RANGE,
  COST_BOAT,
  COST_ROAD,
  COST_WALL,
  TANK_START_ARMOR,
  TREES_PER_FOREST_TILE,
} from '@bolo/shared';
import type { Base, Pillbox, Tank } from '@bolo/shared';
import type { TankInput, World } from './world';

const NPC_NAMES = [
  'patrol', 'lancer', 'bastion', 'vanguard', 'sentry', 'warden',
  'breaker', 'anvil', 'hammer', 'picket', 'outrider', 'sapper',
];

// --- Builder sub-goal state machine ---
type NpcBuilderGoal =
  | { kind: 'none' }
  | { kind: 'harvest'; targetTile: [number, number] }
  | { kind: 'build_boat'; targetTile: [number, number] };

interface AiMemory {
  path: [number, number][]; // tile-center waypoints from A*
  pathAge: number; // ticks since computed
  goalKey: string;
  stuckTicks: number;
  lastX: number;
  lastY: number;
  /** current duel target, for reaction delay on a fresh acquisition */
  targetId: number;
  targetSince: number;
  /** wandering aim error (radians), resampled every half second */
  aimJitter: number;
  aimJitterTick: number;
  /** a goalKey that A* couldn't reach overland, skipped until unreachableUntil */
  unreachableGoalKey: string;
  unreachableUntil: number;
  // --- New fields ---
  /** builder sub-goal: harvesting trees or building a boat for water crossing */
  builderGoal: NpcBuilderGoal;
  /** tick stamp of last road build (cooldown) */
  lastRoadTick: number;
  /** tick stamp of last wall build (cooldown) */
  lastWallTick: number;
  /** tick stamp of last mine lay (cooldown) */
  lastMineTick: number;
  /** tick stamp of last forest harvest dispatch */
  lastHarvestTick: number;
  /** remaining dodge ticks; when > 0, override steering to dodge shells */
  dodgeTicks: number;
  dodgeDir: number;
}

// --- Team awareness context ---
interface TeamAwareness {
  /** enemy tank ids currently being engaged by a friendly NPC → count */
  engagedEnemies: Map<number, number>;
  /** friendly base ids under siege (enemy within BASE_REFUEL_RADIUS * 5) */
  siegedBases: Set<number>;
  /** friendly NPC positions for goal spreading */
  friendlyPositions: Map<Faction, { x: number; y: number; goalKey: string }[]>;
}

// Humanizers: garrison bots aimed with perfect server-side information and
// fired the same tick a target entered range — telemetry showed a 52% bot
// hit rate vs 7-10% for humans, and a 12:1 kill ratio. A beat of reaction
// time plus a wandering aim error keeps them dangerous but beatable.
const NPC_REACTION_TICKS = Math.round(TICK_HZ * 0.6);
const NPC_AIM_SPREAD = 0.12; // radians; ~7° max error, resampled at 2Hz
// After A* fails to reach a goal overland, skip re-selecting it for this long
// so a cut-off garrison doesn't re-run a full-budget search at the same
// impossible goal every couple of seconds. Kept short (15s) so that
// budget-exhausted paths retry soon — many "unreachable" results are just
// the search hitting MAX_EXPANSIONS, not truly impassable terrain.
const NPC_UNREACHABLE_BACKOFF = TICK_HZ * 15;

// A* scratch buffers, allocated once.
const N_TILES = MAP_SIZE * MAP_SIZE;
/**
 * Search budget: an unreachable goal would otherwise exhaust all 65k tiles
 * on every repath. Raised from 12k to 20k after analysis showed ~13% of
 * generated seeds have base pairs that need >12k expansions (the deep-sea
 * edge penalty inflates cost gradients, forcing the search to explore
 * many alternatives before committing to a coastal route).
 */
const MAX_EXPANSIONS = 20000;
/** Weighted A* (h x 1.3): slightly suboptimal routes, far fewer expansions. */
const HEURISTIC_WEIGHT = 1.3;

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

// Tactical builder cooldowns (ticks)
const ROAD_COOLDOWN = TICK_HZ * 4; // 4 seconds between road builds per NPC
const WALL_COOLDOWN = TICK_HZ * 8;
const MINE_COOLDOWN = TICK_HZ * 10;
const HARVEST_COOLDOWN = TICK_HZ * 5;

// --- Terrain helpers ---
const SLOW_TERRAINS = new Set<number>([
  Terrain.Swamp, Terrain.Crater, Terrain.Rubble, Terrain.ShotBuilding,
]);

/**
 * Encapsulates all per-instance NPC state: the name counter, per-tank AI
 * memories, and A* scratch buffers. One instance per World (GameDO).
 */
export class NpcController {
  private npcCounter = 0;
  private memories = new Map<number, AiMemory>();
  // A* scratch
  private gScore = new Float64Array(N_TILES);
  private cameFrom = new Int32Array(N_TILES);
  private stamp = new Int32Array(N_TILES);
  private generation = 0;
  // Team awareness, rebuilt each tick by preTick()
  private team: TeamAwareness | null = null;

  /** Top up factions to the minimum population; cull extras when humans show up. */
  balanceNpcs(world: World): void {
    const npcsByFaction: Record<Faction, Tank[]> = { dawn: [], dusk: [] };
    const totals: Record<Faction, number> = { dawn: 0, dusk: 0 };
    let npcTotal = 0;
    for (const t of world.tanks.values()) {
      totals[t.faction]++;
      if (t.npc) {
        npcsByFaction[t.faction].push(t);
        npcTotal++;
      }
    }
    for (const f of FACTIONS) {
      while (totals[f] < NPC_MIN_PER_FACTION && npcTotal < NPC_MAX_TOTAL) {
        const name = `${NPC_NAMES[this.npcCounter % NPC_NAMES.length]}-${++this.npcCounter}`;
        world.addTank(`npc:${name}`, `[${f}] ${name}`, f, true);
        totals[f]++;
        npcTotal++;
      }
      while (totals[f] > NPC_MIN_PER_FACTION && npcsByFaction[f].length > 0) {
        const t = npcsByFaction[f].pop()!;
        this.memories.delete(t.id);
        world.removeTank(t.id);
        totals[f]--;
        npcTotal--;
      }
    }
  }

  /**
   * Build per-tick team awareness context. Called once before the think()
   * loop so individual NPC decisions can reference shared team state
   * (engaged enemies, sieged bases, friendly positions for spreading).
   */
  preTick(world: World): void {
    const engaged = new Map<number, number>();
    const sieged = new Set<number>();
    const friendlyPos: Map<Faction, { x: number; y: number; goalKey: string }[]> = new Map([
      ['dawn', []], ['dusk', []],
    ]);

    for (const t of world.tanks.values()) {
      if (!t.alive) continue;
      // Record friendly position + current goal for spreading
      if (t.npc) {
        const mem = this.memories.get(t.id);
        friendlyPos.get(t.faction)!.push({
          x: t.x, y: t.y, goalKey: mem?.goalKey ?? '',
        });
      }
    }

    // Detect sieged bases: enemy near a friendly base
    for (const b of world.bases) {
      if (b.owner === 'neutral') continue;
      const faction = b.owner as Faction;
      for (const t of world.tanks.values()) {
        if (!t.alive || t.faction === faction) continue;
        const d = Math.hypot(t.x - (b.x + 0.5), t.y - (b.y + 0.5));
        if (d < BASE_REFUEL_RADIUS * 8) { // ~6 tiles — "near the base"
          sieged.add(b.id);
          break;
        }
      }
    }

    // Engaged enemies: mark targets of friendly NPCs from the previous tick's memory
    for (const [tid, mem] of this.memories) {
      const t = world.tanks.get(tid);
      if (!t || !t.alive || !t.npc) continue;
      if (mem.targetId > 0) {
        engaged.set(mem.targetId, (engaged.get(mem.targetId) ?? 0) + 1);
      }
    }

    this.team = {
      engagedEnemies: engaged,
      siegedBases: sieged,
      friendlyPositions: friendlyPos,
    };
  }

  think(world: World, tank: Tank): TankInput {
    if (!tank.alive) return { accel: 0, turn: 0, fire: false };
    const mem = this.getMemory(tank);

    // --- Shell dodging (highest priority below "don't be dead") ---
    const dodge = this.checkShellThreat(world, tank);
    if (dodge) {
      mem.dodgeTicks = 3; // dodge for ~0.3 seconds
      mem.dodgeDir = dodge;
    }
    if (mem.dodgeTicks > 0) {
      mem.dodgeTicks--;
      return {
        accel: 1,
        turn: mem.dodgeDir,
        fire: false,
      };
    }

    // --- Threat assessment: retreat when badly outnumbered and fragile ---
    const retreating = this.checkThreatRetreat(world, tank);
    if (retreating) {
      // Act like we need supply: skip combat, head for a friendly base
      return this.navigateStrategic(world, tank, mem, true);
    }

    const needSupply = tank.shells < 5 || tank.armor < 15;

    if (!needSupply) {
      // 1) duel the nearest visible enemy tank in range
      let enemy: Tank | null = null;
      let enemyD = SHELL_RANGE;
      for (const other of world.tanks.values()) {
        if (!other.alive || other.faction === tank.faction) continue;
        if (world.tileAt(other.x, other.y) === Terrain.Forest) continue; // can't see into trees
        const d = Math.hypot(other.x - tank.x, other.y - tank.y);
        // Focus fire bias: prefer enemies a teammate is already engaging
        let effectiveD = d;
        if (this.team?.engagedEnemies.has(other.id)) {
          effectiveD -= 5; // bias toward focus-fired targets
        }
        if (effectiveD < enemyD) {
          enemyD = effectiveD;
          enemy = other;
        }
      }
      if (enemy) {
        // Use the actual distance for combat, not the biased effective distance
        const realD = Math.hypot(enemy.x - tank.x, enemy.y - tank.y);
        if (mem.targetId !== enemy.id) {
          mem.targetId = enemy.id;
          mem.targetSince = world.tick;
        }
        const acquired = world.tick - mem.targetSince >= NPC_REACTION_TICKS;
        if (world.tick - mem.aimJitterTick >= TICK_HZ / 2) {
          mem.aimJitterTick = world.tick;
          mem.aimJitter = (Math.random() * 2 - 1) * NPC_AIM_SPREAD;
        }
        return steerAndShoot(
          world, tank, enemy.x, enemy.y, realD > 3, acquired && tank.shells > 0, mem.aimJitter,
        );
      }
      mem.targetId = -1;

      // 2) soften a hostile pillbox from stand-off range
      let pill: Pillbox | null = null;
      let pillD = SHELL_RANGE;
      for (const p of world.pills) {
        if (p.inTank || p.hp <= 0 || p.owner === tank.faction) continue;
        const d = Math.hypot(p.x + 0.5 - tank.x, p.y + 0.5 - tank.y);
        if (d < pillD) {
          pillD = d;
          pill = p;
        }
      }
      if (pill && tank.shells > 2) {
        return steerAndShoot(world, tank, pill.x + 0.5, pill.y + 0.5, pillD > PILL_RANGE * 0.8, true);
      }
    }

    // 3) tactical builder usage (non-combat): proactive harvest + road/wall/mine/pill
    if (!needSupply || tank.trees < 5) {
      this.tryTacticalBuilder(world, tank, mem, needSupply);
    }

    // 4) strategic goal: resupply when low, otherwise march on a base
    return this.navigateStrategic(world, tank, mem, needSupply);
  }

  // --- Shell dodging ---
  private checkShellThreat(world: World, tank: Tank): number {
    let dodgeDir = 0;
    for (const s of world.shells) {
      if (s.faction === tank.faction) continue; // friendly fire isn't a threat
      // Is this shell heading roughly toward us?
      const toUs = Math.atan2(tank.y - s.y, tank.x - s.x);
      const headingDiff = Math.abs(angleDelta(s.dir, toUs));
      if (headingDiff > 0.3) continue; // not aimed at us
      const d = Math.hypot(s.x - tank.x, s.y - tank.y);
      if (d > 6) continue; // too far to worry
      // Dodge perpendicular to the shell's direction
      const ourOffset = angleDelta(s.dir, Math.atan2(tank.y - s.y, tank.x - s.x));
      dodgeDir = ourOffset > 0 ? 1 : -1; // turn away from the shell line
    }
    return dodgeDir;
  }

  // --- Threat assessment: returns true if we should retreat ---
  private checkThreatRetreat(world: World, tank: Tank): boolean {
    let nearbyFriendlies = 0;
    let nearbyEnemies = 0;
    for (const other of world.tanks.values()) {
      if (!other.alive || other.id === tank.id) continue;
      const d = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (d > SHELL_RANGE) continue;
      if (other.faction === tank.faction) nearbyFriendlies++;
      else nearbyEnemies++;
    }
    const outnumbered = nearbyEnemies > nearbyFriendlies + 1;
    const fragile = tank.armor < TANK_START_ARMOR * 0.5 || tank.shells < 5;
    return outnumbered && fragile;
  }

  // --- Tactical builder usage ---
  private tryTacticalBuilder(world: World, tank: Tank, mem: AiMemory, needSupply: boolean): void {
    if (tank.builder.phase !== 'in_tank') return; // builder is busy

    // Proactive forest harvesting: keep trees topped up for roads/walls/boats
    if (tank.trees < 5 && world.tick - mem.lastHarvestTick >= HARVEST_COOLDOWN) {
      const forest = findNearestTerrain(world, tank.x, tank.y, Terrain.Forest, BUILDER_MAX_RANGE);
      if (forest) {
        const err = world.builderOrder(tank.id, 'harvest', forest[0], forest[1]);
        if (!err) {
          mem.lastHarvestTick = world.tick;
          mem.builderGoal = { kind: 'harvest', targetTile: forest };
        }
      }
    }

    // When not in urgent need of supply (not rushing back), do base fortification
    if (!needSupply && tank.trees >= 5) {
      // Road building on slow terrain the NPC is driving over
      if (world.tick - mem.lastRoadTick >= ROAD_COOLDOWN && tank.trees >= COST_ROAD) {
        const myTileX = Math.floor(tank.x);
        const myTileY = Math.floor(tank.y);
        const t = world.terrain[idx(myTileX, myTileY)] as Terrain;
        if (SLOW_TERRAINS.has(t)) {
          const err = world.builderOrder(tank.id, 'road', myTileX, myTileY);
          if (!err) mem.lastRoadTick = world.tick;
        }
      }

      // Defensive walls near friendly bases
      if (world.tick - mem.lastWallTick >= WALL_COOLDOWN && tank.trees >= COST_WALL + 2) {
        const friendlyBase = findNearestFriendlyBase(world, tank);
        if (friendlyBase) {
          const d = Math.hypot(friendlyBase.x + 0.5 - tank.x, friendlyBase.y + 0.5 - tank.y);
          if (d < 4) {
            // Try to wall an adjacent tile to the base
            for (const [dx, dy] of NEIGHBORS) {
              const wx = friendlyBase.x + dx;
              const wy = friendlyBase.y + dy;
              if (wx < 0 || wy < 0 || wx >= MAP_SIZE || wy >= MAP_SIZE) continue;
              const wt = world.terrain[idx(wx, wy)] as Terrain;
              if (canBuildOn(wt)) {
                const err = world.builderOrder(tank.id, 'wall', wx, wy);
                if (!err) {
                  mem.lastWallTick = world.tick;
                  break;
                }
              }
            }
          }
        }
      }

      // Defensive mine laying near friendly bases
      if (world.tick - mem.lastMineTick >= MINE_COOLDOWN && tank.mines > 0) {
        const friendlyBase = findNearestFriendlyBase(world, tank);
        if (friendlyBase) {
          const d = Math.hypot(friendlyBase.x + 0.5 - tank.x, friendlyBase.y + 0.5 - tank.y);
          if (d < 5) {
            // Lay a mine on the tile we're on, if it's safe
            const mx = Math.floor(tank.x);
            const my = Math.floor(tank.y);
            if (mx >= 0 && my >= 0 && mx < MAP_SIZE && my < MAP_SIZE) {
              const mt = world.terrain[idx(mx, my)] as Terrain;
              if (canBuildOn(mt) && world.mines[idx(mx, my)] === MineState.None) {
                const err = world.builderOrder(tank.id, 'mine', mx, my);
                if (!err) mem.lastMineTick = world.tick;
              }
            }
          }
        }
      }
    }
  }

  // --- Strategic navigation (base selection + A* pathfinding + boat building) ---
  private navigateStrategic(world: World, tank: Tank, mem: AiMemory, needSupply: boolean): TankInput {
    const haveHomeBase = world.bases.some((b) => b.owner === tank.faction);
    const resupplying = needSupply && haveHomeBase;

    // --- Base defense: redirect to a sieged friendly base ---
    if (this.team && !resupplying) {
      const defended = this.findSiegedBase(world, tank);
      if (defended) {
        return this.driveToBase(world, tank, mem, defended);
      }
    }

    // --- Select a strategic goal base ---
    let goal: Base | null = null;
    let bestScore = Infinity;
    for (const b of world.bases) {
      const isMine = b.owner === tank.faction;
      if (resupplying ? !isMine : isMine) continue;
      if (!resupplying && world.tick < mem.unreachableUntil && mem.unreachableGoalKey === `base:${b.id}:${b.owner}`) {
        continue;
      }
      const d = Math.hypot(b.x + 0.5 - tank.x, b.y + 0.5 - tank.y);
      let bias = !resupplying && b.owner !== 'neutral' ? 40 : 0; // prefer free real estate
      // Goal spreading: penalize goals other friendlies are already heading toward
      const goalKey = `base:${b.id}:${b.owner}`;
      const teammates = this.team?.friendlyPositions.get(tank.faction) ?? [];
      for (const f of teammates) {
        if (f.goalKey === goalKey) {
          const fd = Math.hypot(f.x - (b.x + 0.5), f.y - (b.y + 0.5));
          if (fd < d) bias += 20; // a teammate is closer to this base
        }
      }
      if (d + bias < bestScore) {
        bestScore = d + bias;
        goal = b;
      }
    }
    if (!goal) return { accel: 0, turn: 0, fire: false };

    // bombard an enemy base's fortifications until it falls neutral
    const goalD = Math.hypot(goal.x + 0.5 - tank.x, goal.y + 0.5 - tank.y);
    if (!resupplying && goal.owner !== 'neutral' && goal.hp > 0 && goalD < SHELL_RANGE * 0.9) {
      return steerAndShoot(world, tank, goal.x + 0.5, goal.y + 0.5, goalD > 4, tank.shells > 0);
    }

    // --- Boat building sub-goal state machine ---
    if (!tank.onBoat && mem.builderGoal.kind !== 'none') {
      return this.handleBuilderGoal(world, tank, mem, goal);
    }

    return this.driveToGoal(world, tank, mem, goal, resupplying);
  }

  // --- Drive toward a specific base (for base defense) ---
  private driveToBase(world: World, tank: Tank, mem: AiMemory, base: Base): TankInput {
    return this.driveToGoal(world, tank, mem, base, false);
  }

  // --- Core A* navigation toward a goal base ---
  private driveToGoal(world: World, tank: Tank, mem: AiMemory, goal: Base, resupplying: boolean): TankInput {
    const goalKey = `base:${goal.id}:${goal.owner}`;
    const goalD = Math.hypot(goal.x + 0.5 - tank.x, goal.y + 0.5 - tank.y);
    mem.pathAge++;
    const stale = mem.pathAge > TICK_HZ * (8 + (tank.id % 5));
    // Repath when: goal changed, path is stale, or the path ran out but we're
    // still far from the goal (consumed all waypoints). Don't repath on empty
    // path when we're close — just drive straight at it.
    const needsPath = mem.goalKey !== goalKey || stale || (mem.path.length === 0 && goalD > 2);
    if (needsPath) {
      mem.path = this.findPath(world, tank.x, tank.y, goal.x + 0.5, goal.y + 0.5, tank.onBoat);
      mem.pathAge = 0;
      mem.goalKey = goalKey;

      if (mem.path.length === 0 && goalD > 6) {
        // Goal unreachable overland — check if we should try boat building
        if (!tank.onBoat && !resupplying && this.shouldBuildBoat(world, tank, goal)) {
          this.startBoatGoal(world, tank, mem);
          return { accel: 0, turn: 0, fire: false }; // wait while builder dispatches
        }
        // Standard backoff
        mem.unreachableGoalKey = goalKey;
        mem.unreachableUntil = world.tick + NPC_UNREACHABLE_BACKOFF;
        const ang = Math.random() * Math.PI * 2;
        mem.path = [[tank.x + Math.cos(ang) * 8, tank.y + Math.sin(ang) * 8]];
      } else if (mem.path.length === 0 && goalD > 1.5) {
        mem.path = [[goal.x + 0.5, goal.y + 0.5]];
      }
    }

    let [wx, wy] = mem.path[0] ?? [goal.x + 0.5, goal.y + 0.5];
    while (mem.path.length > 0 && Math.hypot(wx - tank.x, wy - tank.y) < 1.5) {
      mem.path.shift();
      [wx, wy] = mem.path[0] ?? [goal.x + 0.5, goal.y + 0.5];
    }

    // unstick
    if (Math.hypot(tank.x - mem.lastX, tank.y - mem.lastY) < 0.05) {
      mem.stuckTicks++;
      if (mem.stuckTicks > TICK_HZ * 3) {
        const ang = Math.random() * Math.PI * 2;
        mem.path = [[tank.x + Math.cos(ang) * 6, tank.y + Math.sin(ang) * 6]];
        mem.goalKey = 'wander';
        mem.pathAge = 0;
        mem.stuckTicks = 0;
      }
    } else {
      mem.stuckTicks = 0;
    }
    mem.lastX = tank.x;
    mem.lastY = tank.y;

    return steerAndShoot(world, tank, wx, wy, true, false);
  }

  // --- Check if the goal is across deep water ---
  private shouldBuildBoat(world: World, tank: Tank, goal: Base): boolean {
    // First check: is there deep water on the straight-line path?
    const steps = 24;
    const gx = goal.x + 0.5;
    const gy = goal.y + 0.5;
    const dist = Math.hypot(gx - tank.x, gy - tank.y);
    if (dist > 80) return false; // too far to bother
    let deepWaterOnPath = false;
    for (let i = 1; i <= steps; i++) {
      const fx = tank.x + (gx - tank.x) * (i / steps);
      const fy = tank.y + (gy - tank.y) * (i / steps);
      const t = world.tileAt(fx, fy);
      if (t === Terrain.DeepSea) { deepWaterOnPath = true; break; }
    }
    if (!deepWaterOnPath) return false;

    // Deep water is on the path. Now verify there's actually a river tile
    // nearby to build a boat on (otherwise boat-building is futile).
    const riverTile = findRiverNearWater(world, tank.x, tank.y, BUILDER_MAX_RANGE);
    return riverTile !== null;
  }

  // --- Start the boat-building sub-goal ---
  private startBoatGoal(world: World, tank: Tank, mem: AiMemory): void {
    if (tank.builder.phase !== 'in_tank') return;
    if (tank.trees < COST_BOAT) {
      // Need to harvest first
      const forest = findNearestTerrain(world, tank.x, tank.y, Terrain.Forest, BUILDER_MAX_RANGE);
      if (forest) {
        const err = world.builderOrder(tank.id, 'harvest', forest[0], forest[1]);
        if (!err) {
          mem.builderGoal = { kind: 'harvest', targetTile: forest };
        }
      }
    } else {
      // Have enough trees — find a river tile near water to build the boat
      const riverTile = findRiverNearWater(world, tank.x, tank.y, BUILDER_MAX_RANGE);
      if (riverTile) {
        const err = world.builderOrder(tank.id, 'boat', riverTile[0], riverTile[1]);
        if (!err) {
          mem.builderGoal = { kind: 'build_boat', targetTile: riverTile };
        }
      }
    }
  }

  // --- Handle the builder sub-goal state machine while builder is active ---
  private handleBuilderGoal(world: World, tank: Tank, mem: AiMemory, goal: Base): TankInput {
    const bg = mem.builderGoal;

    // If the builder has returned to the tank, process the result
    if (tank.builder.phase === 'in_tank') {
      if (bg.kind === 'harvest') {
        // Trees harvested. Do we have enough for a boat now?
        if (tank.trees >= COST_BOAT) {
          const riverTile = findRiverNearWater(world, tank.x, tank.y, BUILDER_MAX_RANGE);
          if (riverTile) {
            const err = world.builderOrder(tank.id, 'boat', riverTile[0], riverTile[1]);
            if (!err) {
              mem.builderGoal = { kind: 'build_boat', targetTile: riverTile };
            } else {
              mem.builderGoal = { kind: 'none' }; // give up
            }
          } else {
            mem.builderGoal = { kind: 'none' };
          }
        } else {
          // Need more trees — harvest again if available
          const forest = findNearestTerrain(world, tank.x, tank.y, Terrain.Forest, BUILDER_MAX_RANGE);
          if (forest) {
            const err = world.builderOrder(tank.id, 'harvest', forest[0], forest[1]);
            if (!err) {
              mem.builderGoal = { kind: 'harvest', targetTile: forest };
            } else {
              mem.builderGoal = { kind: 'none' };
            }
          } else {
            mem.builderGoal = { kind: 'none' };
          }
        }
        return { accel: 0, turn: 0, fire: false };
      }

      if (bg.kind === 'build_boat') {
        // Boat was built — check if BoatTile exists at the target
        const [bx, by] = bg.targetTile;
        const t = world.terrain[idx(bx, by)] as Terrain;
        if (t === Terrain.BoatTile) {
          // Navigate to the boat tile to embark
          mem.builderGoal = { kind: 'none' };
          // Drive toward the boat tile
          return steerAndShoot(world, tank, bx + 0.5, by + 0.5, true, false);
        }
        // Boat wasn't built (something went wrong) — give up
        mem.builderGoal = { kind: 'none' };
        return { accel: 0, turn: 0, fire: false };
      }
    }

    // Builder is out — wait (don't issue movement commands)
    return { accel: 0, turn: 0, fire: false };
  }

  // --- Find a sieged friendly base to defend ---
  private findSiegedBase(world: World, tank: Tank): Base | null {
    if (!this.team || this.team.siegedBases.size === 0) return null;
    let best: Base | null = null;
    let bestD = 30; // response radius
    for (const b of world.bases) {
      if (b.owner !== tank.faction) continue;
      if (!this.team.siegedBases.has(b.id)) continue;
      const d = Math.hypot(b.x + 0.5 - tank.x, b.y + 0.5 - tank.y);
      if (d < bestD) {
        bestD = d;
        best = b;
      }
    }
    return best;
  }

  /**
   * Drop all AI memory. A new war builds a fresh World whose tank ids restart
   * at 1; without this, new NPCs would inherit stale paths/goals from the
   * discarded world (and the memory map would grow unbounded across wars).
   */
  reset(): void {
    this.memories.clear();
    this.team = null;
  }

  private getMemory(tank: Tank): AiMemory {
    let mem = this.memories.get(tank.id);
    if (!mem) {
      mem = {
        path: [],
        pathAge: Infinity,
        goalKey: '',
        stuckTicks: 0,
        lastX: tank.x,
        lastY: tank.y,
        targetId: -1,
        targetSince: 0,
        aimJitter: 0,
        aimJitterTick: -Infinity,
        unreachableGoalKey: '',
        unreachableUntil: 0,
        builderGoal: { kind: 'none' },
        lastRoadTick: -Infinity,
        lastWallTick: -Infinity,
        lastMineTick: -Infinity,
        lastHarvestTick: -Infinity,
        dodgeTicks: 0,
        dodgeDir: 0,
      };
      this.memories.set(tank.id, mem);
    }
    return mem;
  }

  /**
   * Tile-level weighted A* (4-connected) over drivable terrain, weighted by
   * terrain speed so routes prefer roads and open ground. When allowDeepSea
   * is true (tank is on a boat), deep-sea tiles become passable at boat
   * speed cost. Tiles bordering deep sea carry a heavy penalty for ground
   * travel to avoid wedging against the coastline.
   */
  private findPath(
    world: World, x0: number, y0: number, x1: number, y1: number,
    allowDeepSea = false,
  ): [number, number][] {
    const start = tileOf(x0, y0);
    const goal = tileOf(x1, y1);
    if (start === goal) return [];
    this.generation++;
    const gx = goal % MAP_SIZE;
    const gy = (goal / MAP_SIZE) | 0;
    const heur = (x: number, y: number) => (Math.abs(gx - x) + Math.abs(gy - y)) * HEURISTIC_WEIGHT;
    const heap: [number, number][] = [[heur(start % MAP_SIZE, (start / MAP_SIZE) | 0), start]];
    this.gScore[start] = 0;
    this.cameFrom[start] = start;
    this.stamp[start] = this.generation;
    let found = false;
    let expansions = 0;
    while (heap.length > 0) {
      const [f, cur] = heapPop(heap);
      if (cur === goal) {
        found = true;
        break;
      }
      const cx = cur % MAP_SIZE;
      const cy = (cur / MAP_SIZE) | 0;
      if (f > this.gScore[cur] + heur(cx, cy)) continue; // stale heap entry
      if (++expansions > MAX_EXPANSIONS) break;
      for (const [dx, dy] of NEIGHBORS) {
        const nx = cx + dx;
        const ny = cy + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
        const n = ny * MAP_SIZE + nx;
        const c = tileCost(world, nx, ny, allowDeepSea);
        if (c === Infinity) continue;
        const ng = this.gScore[cur] + c;
        if (this.stamp[n] !== this.generation || ng < this.gScore[n]) {
          this.stamp[n] = this.generation;
          this.gScore[n] = ng;
          this.cameFrom[n] = cur;
          heapPush(heap, [ng + heur(nx, ny), n]);
        }
      }
    }
    if (!found) return []; // unreachable or over budget; caller falls back
    const path: [number, number][] = [];
    let cur = goal;
    while (cur !== start) {
      path.push([(cur % MAP_SIZE) + 0.5, ((cur / MAP_SIZE) | 0) + 0.5]);
      cur = this.cameFrom[cur];
    }
    return path.reverse();
  }
}

// --- Module-level facade (backward compatibility for game.ts) ---

let _default: NpcController | null = null;
export function defaultNpcController(): NpcController {
  return (_default ??= new NpcController());
}

/** Top up factions to the minimum population; cull extras when humans show up. */
export function balanceNpcs(world: World): void {
  defaultNpcController().balanceNpcs(world);
}

export function npcThink(world: World, tank: Tank): TankInput {
  return defaultNpcController().think(world, tank);
}

// --- Pure functions (no instance state needed) ---

function steerAndShoot(
  world: World,
  tank: Tank,
  tx: number,
  ty: number,
  advance: boolean,
  wantFire: boolean,
  aimError = 0,
): TankInput {
  const want = Math.atan2(ty - tank.y, tx - tank.x) + aimError;
  const delta = angleDelta(tank.dir, want);

  // local avoidance: probe ahead, veer away from walls, open sea, and hostile mines
  const probe = (ang: number) => {
    const t = world.tileAt(tank.x + Math.cos(ang) * 1.6, tank.y + Math.sin(ang) * 1.6);
    return t === Terrain.Building || (t === Terrain.DeepSea && !tank.onBoat);
  };

  // Mine probe: detect hostile mines ahead and steer around them
  const mineProbe = (ang: number) => {
    const px = Math.floor(tank.x + Math.cos(ang) * 1.6);
    const py = Math.floor(tank.y + Math.sin(ang) * 1.6);
    if (px < 0 || py < 0 || px >= MAP_SIZE || py >= MAP_SIZE) return false;
    const m = world.mines[idx(px, py)] as MineState;
    if (m === MineState.None) return false;
    // Neutral mines are hostile to everyone; faction mines hostile to the other faction
    if (m === MineState.Neutral) return true;
    return m === (tank.faction === 'dawn' ? MineState.Dusk : MineState.Dawn);
  };

  // proportional steering
  let turn = Math.max(-1, Math.min(1, delta * 3));
  let blocked = false;
  if (probe(tank.dir) || mineProbe(tank.dir)) {
    blocked = true;
    // pick the clearer side
    turn = (probe(tank.dir + 0.7) || mineProbe(tank.dir + 0.7)) ? -1 : 1;
  }

  const facing = Math.abs(delta) < 0.1;
  const hardTurn = Math.abs(delta) > 0.9 && !blocked;
  return {
    accel: (advance || blocked) && !hardTurn ? 1 : 0,
    turn,
    fire: wantFire && facing && !blocked,
  };
}

function tileOf(x: number, y: number): number {
  const cx = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(x)));
  const cy = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(y)));
  return cy * MAP_SIZE + cx;
}

function tileCost(world: World, x: number, y: number, allowDeepSea: boolean): number {
  const t = world.terrain[idx(x, y)] as Terrain;
  if (t === Terrain.Building) return Infinity;
  if (t === Terrain.DeepSea) {
    if (!allowDeepSea) return Infinity;
    // Boat travel: BOAT_SPEED is 5.8 tiles/sec, faster than most land
    return 1 / BOAT_SPEED;
  }
  if (TERRAIN[t].tankSpeed === 0) return Infinity;
  let cost = 1 / TERRAIN[t].tankSpeed; // road 1, grass 1.33, river/swamp 4
  // Deep-sea-edge penalty only when not on water (avoid coastal wedging for ground tanks)
  if (!allowDeepSea) {
    for (const [dx, dy] of NEIGHBORS) {
      const nx = x + dx;
      const ny = y + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
      if ((world.terrain[idx(nx, ny)] as Terrain) === Terrain.DeepSea) {
        cost += 4; // mild coastal aversion; steerAndShoot handles physical wall-hugging
        break;
      }
    }
  }
  return cost;
}

/** Find the nearest tile of a given terrain type within maxRange (tile units). */
function findNearestTerrain(
  world: World, x: number, y: number, terrain: Terrain, maxRange: number,
): [number, number] | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (let r = 1; r <= maxRange; r++) {
    // Spiral search at radius r
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue; // ring at radius r
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
        if ((world.terrain[idx(nx, ny)] as Terrain) === terrain) {
          const d = Math.hypot(nx + 0.5 - x, ny + 0.5 - y);
          if (d <= maxRange) return [nx, ny];
        }
      }
    }
  }
  return null;
}

/**
 * Find a river tile suitable for boat building, within range. Prefers river
 * tiles adjacent to deep sea (so the boat opens directly onto open water),
 * but falls back to any river tile (the tank can navigate through shallow
 * water to reach deep sea after embarking).
 */
function findRiverNearWater(
  world: World, x: number, y: number, maxRange: number,
): [number, number] | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  let best: [number, number] | null = null;
  let bestD = Infinity;
  let fallback: [number, number] | null = null;
  let fallbackD = Infinity;
  for (let r = 1; r <= maxRange; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
        if ((world.terrain[idx(nx, ny)] as Terrain) !== Terrain.River) continue;
        const d = Math.hypot(nx + 0.5 - x, ny + 0.5 - y);
        if (d > maxRange) continue;
        // Check if any neighbor is deep sea (preferred — direct ocean access)
        let nearSea = false;
        for (const [ddx, ddy] of NEIGHBORS) {
          const sx = nx + ddx;
          const sy = ny + ddy;
          if (sx < 0 || sy < 0 || sx >= MAP_SIZE || sy >= MAP_SIZE) continue;
          if ((world.terrain[idx(sx, sy)] as Terrain) === Terrain.DeepSea) {
            nearSea = true;
            break;
          }
        }
        if (nearSea) {
          if (d < bestD) { bestD = d; best = [nx, ny]; }
        } else {
          if (d < fallbackD) { fallbackD = d; fallback = [nx, ny]; }
        }
      }
    }
  }
  return best ?? fallback;
}

/** Find the nearest friendly base to a tank. */
function findNearestFriendlyBase(world: World, tank: Tank): Base | null {
  let best: Base | null = null;
  let bestD = Infinity;
  for (const b of world.bases) {
    if (b.owner !== tank.faction) continue;
    const d = Math.hypot(b.x + 0.5 - tank.x, b.y + 0.5 - tank.y);
    if (d < bestD) {
      bestD = d;
      best = b;
    }
  }
  return best;
}

/** Whether a builder can construct on this terrain type (duplicated from utils for pure-function access). */
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

function heapPush(heap: [number, number][], item: [number, number]): void {
  heap.push(item);
  let i = heap.length - 1;
  while (i > 0) {
    const parent = (i - 1) >> 1;
    if (heap[parent][0] <= heap[i][0]) break;
    [heap[parent], heap[i]] = [heap[i], heap[parent]];
    i = parent;
  }
}

function heapPop(heap: [number, number][]): [number, number] {
  const top = heap[0];
  const last = heap.pop()!;
  if (heap.length > 0) {
    heap[0] = last;
    let i = 0;
    for (;;) {
      const l = i * 2 + 1;
      const r = l + 1;
      let m = i;
      if (l < heap.length && heap[l][0] < heap[m][0]) m = l;
      if (r < heap.length && heap[r][0] < heap[m][0]) m = r;
      if (m === i) break;
      [heap[m], heap[i]] = [heap[i], heap[m]];
      i = m;
    }
  }
  return top;
}

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}
