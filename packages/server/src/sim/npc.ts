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
import { angleDelta } from '@bolo/shared';
import { SpatialIndex } from './spatial-index';
import { TypedMinHeap } from './typed-heap';
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
import type { TankInput, World, StatEvent } from './world';

const NPC_NAMES = [
  'patrol', 'lancer', 'bastion', 'vanguard', 'sentry', 'warden',
  'breaker', 'anvil', 'hammer', 'picket', 'outrider', 'sapper',
];

// --- Builder sub-goal state machine ---
type NpcBuilderGoal =
  | { kind: 'none' }
  | { kind: 'goto_coast'; targetTile: [number, number]; finalGoal: [number, number] }
  | { kind: 'harvest'; targetTile: [number, number]; finalGoal: [number, number] }
  | { kind: 'build_boat'; targetTile: [number, number]; finalGoal: [number, number] }
  | { kind: 'embark'; targetTile: [number, number]; finalGoal: [number, number] };

interface AiMemory {
  path: [number, number][]; // tile-center waypoints from A*
  pathIndex: number; // index into path[] for consumption (avoids O(n) shift)
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
  /** telemetry: which decision branch think() took this tick */
  decision: string;
  /** base being actively sieged; remembered across resupply trips so the NPC
   *  returns to finish a damaged base instead of picking a fresh one */
  siegeTargetId: number;
  siegeTargetHp: number;
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
// fired the same tick a target entered range — telemetry showed a 76% bot
// hit rate vs 39% for humans. A beat of reaction time plus a wandering aim
// error keeps them dangerous but beatable. Spread and reaction time were
// raised from 0.12/0.6s after the 76% rate proved too dominant.
const NPC_REACTION_TICKS = Math.round(TICK_HZ * 0.85);
const NPC_AIM_SPREAD = 0.22; // radians; ~12.6° max error, resampled at 2Hz
// After A* fails to reach a goal overland, skip re-selecting it for this long.
// Kept short (15s) so budget-exhausted paths retry soon — many "unreachable"
// results are the search hitting MAX_EXPANSIONS, not truly impassable terrain.
const NPC_UNREACHABLE_BACKOFF = TICK_HZ * 15;

// A* scratch buffers, allocated once.
const N_TILES = MAP_SIZE * MAP_SIZE;
/**
 * Search budget: raised from 12k to 20k after analysis showed ~13% of
 * generated seeds have base pairs needing >12k expansions (the deep-sea
 * edge penalty inflates cost gradients, forcing the search to explore
 * many alternatives before committing to a coastal route).
 */
const MAX_EXPANSIONS = 20000;
/** Weighted A* (h x 1.3): slightly suboptimal routes, far fewer expansions. */
const HEURISTIC_WEIGHT = 1.3;

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

/** Full 3×3 ring around a tile (cardinal + diagonal) for perimeter walls. */
const WALL_RING = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
  [1, 1], [1, -1], [-1, 1], [-1, -1],
] as const;

// Squared constants for hot-path distance comparisons (avoids Math.hypot)
const SHELL_RANGE_SQ = SHELL_RANGE * SHELL_RANGE;
const SHELL_THREAT_RANGE_SQ = 36; // 6² — shell dodge detection range

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
  // Typed-array binary heap (zero per-push allocations vs old tuple arrays)
  private heap = new TypedMinHeap(MAX_EXPANSIONS * 4 + 16);
  // Team awareness, rebuilt each tick by preTick()
  private team: TeamAwareness | null = null;
  // NPC behavioral telemetry, drained by the game DO after the think loop
  npcStats: StatEvent[] = [];
  // Spatial index of alive tanks — available for proximity queries.
  // Currently the shell system uses its own internal grid (built post-physics);
  // this index is built pre-physics during preTick for NPC awareness queries.
  private _spatial: SpatialIndex = new SpatialIndex();

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

    // Build spatial index of all alive tanks for O(1) proximity queries
    this._spatial.clear();

    for (const t of world.tanks.values()) {
      if (!t.alive) continue;
      this._spatial.insert(t);
      // Record friendly position + current goal for spreading
      if (t.npc) {
        const mem = this.memories.get(t.id);
        friendlyPos.get(t.faction)!.push({
          x: t.x, y: t.y, goalKey: mem?.goalKey ?? '',
        });
      }
    }

    // Detect sieged bases: enemy near a friendly base
    const siegeRangeSq = (BASE_REFUEL_RADIUS * 8) ** 2;
    for (const b of world.bases) {
      if (b.owner === 'neutral') continue;
      const faction = b.owner as Faction;
      const bx = b.x + 0.5;
      const by = b.y + 0.5;
      for (const t of world.tanks.values()) {
        if (!t.alive || t.faction === faction) continue;
        const dx = t.x - bx;
        const dy = t.y - by;
        if (dx * dx + dy * dy < siegeRangeSq) { // ~6 tiles — "near the base"
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
      mem.decision = 'dodge';
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
      mem.decision = 'retreat';
      return this.navigateStrategic(world, tank, mem, true);
    }

    // --- Siege commitment: if we're actively bombarding a base, don't bail
    //     just because shells dipped below 5. Keep firing until we're out,
    //     so we can actually finish a damaged base instead of retreating and
    //     letting it fully regenerate during the round trip. ---
    let inBombardRange = false;
    if (mem.siegeTargetId >= 0) {
      const siegeBase = world.bases.find((b) => b.id === mem.siegeTargetId);
      if (!siegeBase || siegeBase.owner === 'neutral' || siegeBase.owner === tank.faction || siegeBase.hp <= 0) {
        mem.siegeTargetId = -1; // base fell neutral or was captured — siege complete
      } else {
        mem.siegeTargetHp = siegeBase.hp;
        const sdx = siegeBase.x + 0.5 - tank.x;
        const sdy = siegeBase.y + 0.5 - tank.y;
        inBombardRange = sdx * sdx + sdy * sdy < (SHELL_RANGE * 0.9) ** 2;
      }
    }
    const committed = inBombardRange && tank.shells > 0;

    const needSupply = (tank.shells < (committed ? 1 : 5)) || tank.armor < 15;

    if (!needSupply) {
      // 1) duel the nearest visible enemy tank in range
      let enemy: Tank | null = null;
      let enemyD = SHELL_RANGE_SQ;
      for (const other of world.tanks.values()) {
        if (!other.alive || other.faction === tank.faction) continue;
        if (world.tileAt(other.x, other.y) === Terrain.Forest) continue; // can't see into trees
        const dx = other.x - tank.x;
        const dy = other.y - tank.y;
        const d = dx * dx + dy * dy;
        // Focus fire bias: prefer enemies a teammate is already engaging
        let effectiveD = d;
        if (this.team?.engagedEnemies.has(other.id)) {
          // bias: -5 distance. In squared space, subtract ~(2*d_actual*5 - 25)
          // but the bias is a heuristic tweak, not precision — just use sqrt here
          effectiveD = (Math.sqrt(d) - 5) ** 2;
        }
        if (effectiveD < enemyD) {
          enemyD = effectiveD;
          enemy = other;
        }
      }
      if (enemy) {
        // Use the actual distance for combat, not the biased effective distance
        const edx = enemy.x - tank.x;
        const edy = enemy.y - tank.y;
        const realDsq = edx * edx + edy * edy;
        if (mem.targetId !== enemy.id) {
          mem.targetId = enemy.id;
          mem.targetSince = world.tick;
        }
        const acquired = world.tick - mem.targetSince >= NPC_REACTION_TICKS;
        if (world.tick - mem.aimJitterTick >= TICK_HZ / 2) {
          mem.aimJitterTick = world.tick;
          mem.aimJitter = (Math.random() * 2 - 1) * NPC_AIM_SPREAD;
        }
        mem.decision = 'duel';
        return steerAndShoot(
          world, tank, enemy.x, enemy.y, realDsq > 9, acquired && tank.shells > 0, mem.aimJitter,
        );
      }
      mem.targetId = -1;

      // 2) soften a hostile pillbox from stand-off range
      let pill: Pillbox | null = null;
      let pillD = SHELL_RANGE_SQ;
      for (const p of world.pills) {
        if (p.inTank || p.hp <= 0 || p.owner === tank.faction) continue;
        const dx = p.x + 0.5 - tank.x;
        const dy = p.y + 0.5 - tank.y;
        const d = dx * dx + dy * dy;
        if (d < pillD) {
          pillD = d;
          pill = p;
        }
      }
      const pillDist = Math.sqrt(pillD);
      if (pill && tank.shells > 2) {
        mem.decision = 'pill';
        return steerAndShoot(world, tank, pill.x + 0.5, pill.y + 0.5, pillDist > PILL_RANGE * 0.8, true);
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
      const sdx = s.x - tank.x;
      const sdy = s.y - tank.y;
      if (sdx * sdx + sdy * sdy > SHELL_THREAT_RANGE_SQ) continue; // too far to worry
      // Dodge perpendicular to the shell's direction
      const ourOffset = angleDelta(s.dir, Math.atan2(tank.y - s.y, tank.x - s.x));
      dodgeDir = ourOffset > 0 ? 1 : -1; // turn away from the shell line
    }
    return dodgeDir;
  }

  // --- Threat assessment: returns true if we should retreat ---
  private checkThreatRetreat(world: World, tank: Tank): boolean {
    // Don't retreat if we're already at a friendly base — hold the line and
    // defend. Retreating from your own supply pad just sends you back to the
    // same base in a perpetual camp loop.
    const refuelRsq = BASE_REFUEL_RADIUS * BASE_REFUEL_RADIUS;
    for (const b of world.bases) {
      if (b.owner !== tank.faction) continue;
      const dx = b.x + 0.5 - tank.x;
      const dy = b.y + 0.5 - tank.y;
      if (dx * dx + dy * dy <= refuelRsq) return false;
    }

    let nearbyFriendlies = 0;
    let nearbyEnemies = 0;
    for (const other of world.tanks.values()) {
      if (!other.alive || other.id === tank.id) continue;
      const dx = other.x - tank.x;
      const dy = other.y - tank.y;
      if (dx * dx + dy * dy > SHELL_RANGE_SQ) continue;
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
          // Don't set builderGoal — this is tactical harvesting, not
          // part of the boat-building sub-goal.
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
          const fdx = friendlyBase.x + 0.5 - tank.x;
          const fdy = friendlyBase.y + 0.5 - tank.y;
          if (fdx * fdx + fdy * fdy < 16) { // 4²
            // Count blocked exits to avoid walling the base shut — tanks
            // spawn here and need at least 2 open sides to escape.
            let blockedExits = 0;
            for (const [dx, dy] of NEIGHBORS) {
              const nx = friendlyBase.x + dx;
              const ny = friendlyBase.y + dy;
              if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) { blockedExits++; continue; }
              if ((world.terrain[idx(nx, ny)] as Terrain) === Terrain.Building) blockedExits++;
            }
            // Only wall if at least 2 exits will remain open
            if (blockedExits < 2) {
              for (const [dx, dy] of WALL_RING) {
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
      }

      // Defensive mine laying near friendly bases
      if (world.tick - mem.lastMineTick >= MINE_COOLDOWN && tank.mines > 0) {
        const friendlyBase = findNearestFriendlyBase(world, tank);
        if (friendlyBase) {
          const fdx = friendlyBase.x + 0.5 - tank.x;
          const fdy = friendlyBase.y + 0.5 - tank.y;
          if (fdx * fdx + fdy * fdy < 25) { // 5²
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
        mem.decision = 'defend';
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
      const dx = b.x + 0.5 - tank.x;
      const dy = b.y + 0.5 - tank.y;
      const d = Math.sqrt(dx * dx + dy * dy);
      let bias = !resupplying && b.owner !== 'neutral' ? 40 : 0; // prefer free real estate
      // Supply check: when resupplying, prefer bases that actually have stock.
      // A depleted base (0 shells + 0 armor) can only trickle-supply (~1-3
      // units per 2s), so an NPC that picks the nearest depleted base camps
      // there uselessly while a fully-stocked base sits a few tiles further.
      if (resupplying) {
        const stock = b.shellStock + b.armorStock;
        if (stock === 0) bias += 50; // nothing to give — strong penalty
        else if (stock < 15) bias += 20; // nearly tapped — deprioritize
      }
      // Siege persistence: strongly prefer returning to a base we've already
      // damaged so we finish it off instead of spreading fire across many bases.
      if (!resupplying && mem.siegeTargetId === b.id) bias -= 80;
      // Goal spreading: penalize goals other friendlies are already heading toward
      const goalKey = `base:${b.id}:${b.owner}`;
      const teammates = this.team?.friendlyPositions.get(tank.faction) ?? [];
      for (const f of teammates) {
        if (f.goalKey === goalKey) {
          const tfx = f.x - (b.x + 0.5);
          const tfy = f.y - (b.y + 0.5);
          if (tfx * tfx + tfy * tfy < dx * dx + dy * dy) bias += 20; // a teammate is closer to this base
        }
      }
      if (d + bias < bestScore) {
        bestScore = d + bias;
        goal = b;
      }
    }
    if (!goal) { mem.decision = 'idle'; return { accel: 0, turn: 0, fire: false }; }

    // bombard an enemy base's fortifications until it falls neutral
    const gdx = goal.x + 0.5 - tank.x;
    const gdy = goal.y + 0.5 - tank.y;
    const goalDsq = gdx * gdx + gdy * gdy;
    if (!resupplying && goal.owner !== 'neutral' && goal.hp > 0 && goalDsq < (SHELL_RANGE * 0.9) ** 2) {
      const goalD = Math.sqrt(goalDsq);
      mem.siegeTargetId = goal.id; // remember across resupply trips
      mem.decision = 'bombard';
      return steerAndShoot(world, tank, goal.x + 0.5, goal.y + 0.5, goalD > 4, tank.shells > 0);
    }

    // --- Boat building sub-goal state machine ---
    if (!tank.onBoat && mem.builderGoal.kind !== 'none') {
      mem.decision = 'builder';
      return this.handleBuilderGoal(world, tank, mem);
    }

    mem.decision = resupplying ? 'resupply' : 'attack';
    return this.driveToGoal(world, tank, mem, goal, resupplying);
  }

  // --- Drive toward a specific base (for base defense) ---
  private driveToBase(world: World, tank: Tank, mem: AiMemory, base: Base): TankInput {
    return this.driveToGoal(world, tank, mem, base, false);
  }

  // --- Core A* navigation toward a goal base ---
  private driveToGoal(world: World, tank: Tank, mem: AiMemory, goal: Base, resupplying: boolean): TankInput {
    const goalKey = `base:${goal.id}:${goal.owner}`;
    const gdx = goal.x + 0.5 - tank.x;
    const gdy = goal.y + 0.5 - tank.y;
    const goalDsq = gdx * gdx + gdy * gdy;
    const goalD = Math.sqrt(goalDsq);
    mem.pathAge++;
    const stale = mem.pathAge > TICK_HZ * (8 + (tank.id % 5));
    const pathRemaining = mem.path.length - mem.pathIndex;
    // Repath when: goal changed, path is stale, or the path ran out but we're
    // still far from the goal. Don't repath on empty path when close.
    const needsPath = mem.goalKey !== goalKey || stale || (pathRemaining === 0 && goalD > 2);
    if (needsPath) {
      mem.path = this.findPath(world, tank.x, tank.y, goal.x + 0.5, goal.y + 0.5, tank.onBoat);
      mem.pathIndex = 0;
      mem.pathAge = 0;
      mem.goalKey = goalKey;

      if (mem.path.length === 0 && goalD > 6) {
        // Goal unreachable overland. Before building a new boat, check if
        // there's an existing BoatTile within reach — reuse it instead.
        if (!tank.onBoat && !resupplying) {
          const existingBoat = findNearestBoatTile(world, tank.x, tank.y, 60);
          if (existingBoat) {
            mem.builderGoal = {
              kind: 'embark',
              targetTile: existingBoat,
              finalGoal: [goal.x, goal.y],
            };
            return { accel: 0, turn: 0, fire: false };
          }
          // No existing boat — check if we should build one
          if (this.shouldBuildBoat(world, tank, goal)) {
            this.startBoatGoal(world, tank, mem, goal);
            return { accel: 0, turn: 0, fire: false };
          }
        }
        // Standard backoff
        mem.unreachableGoalKey = goalKey;
        mem.unreachableUntil = world.tick + NPC_UNREACHABLE_BACKOFF;
        const ang = Math.random() * Math.PI * 2;
        mem.path = [[tank.x + Math.cos(ang) * 8, tank.y + Math.sin(ang) * 8]];
        mem.pathIndex = 0;
      } else if (mem.path.length === 0 && goalD > 1.5) {
        mem.path = [[goal.x + 0.5, goal.y + 0.5]];
        mem.pathIndex = 0;
      }
    }

    let [wx, wy] = mem.path[mem.pathIndex] ?? [goal.x + 0.5, goal.y + 0.5];
    while (mem.pathIndex < mem.path.length && (wx - tank.x) ** 2 + (wy - tank.y) ** 2 < 2.25) { // 1.5²
      mem.pathIndex++;
      [wx, wy] = mem.path[mem.pathIndex] ?? [goal.x + 0.5, goal.y + 0.5];
    }

    // unstick
    if ((tank.x - mem.lastX) ** 2 + (tank.y - mem.lastY) ** 2 < 0.0025) { // 0.05²
      mem.stuckTicks++;
      if (mem.stuckTicks > TICK_HZ * 3) {
        // Sample 8 directions; prefer the one that reaches passable (non-water) terrain
        let bestDir: number | null = null;
        for (let i = 0; i < 8; i++) {
          const ang = (i / 8) * Math.PI * 2;
          const px = tank.x + Math.cos(ang) * 6;
          const py = tank.y + Math.sin(ang) * 6;
          const tile = world.tileAt(px, py) as Terrain;
          if (TERRAIN[tile].tankSpeed > 0 && tile !== Terrain.DeepSea) {
            bestDir = ang;
            break;
          }
        }
        const ang = bestDir ?? Math.random() * Math.PI * 2;
        mem.path = [[tank.x + Math.cos(ang) * 6, tank.y + Math.sin(ang) * 6]];
        mem.pathIndex = 0;
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
    const steps = 24;
    const gx = goal.x + 0.5;
    const gy = goal.y + 0.5;
    const dist = Math.sqrt((gx - tank.x) ** 2 + (gy - tank.y) ** 2);
    if (dist > 80) return false;
    let consecutiveRiver = 0;
    for (let i = 1; i <= steps; i++) {
      const fx = tank.x + (gx - tank.x) * (i / steps);
      const fy = tank.y + (gy - tank.y) * (i / steps);
      const t = world.tileAt(fx, fy);
      if (t === Terrain.DeepSea) return true;
      if (t === Terrain.River) {
        consecutiveRiver++;
        if (consecutiveRiver >= 4) return true; // ~4+ tiles of river → boat is faster
      } else {
        consecutiveRiver = 0;
      }
    }
    return false;
  }

  // --- Start the boat-building sub-goal ---
  private startBoatGoal(world: World, tank: Tank, mem: AiMemory, goal: Base): void {
    // Find the nearest water tile on the entire map — the NPC navigates
    // toward it, then builds the boat when within BUILDER_MAX_RANGE.
    const riverTile = findNearestWater(world, tank.x, tank.y);
    if (!riverTile) return;
    mem.builderGoal = {
      kind: 'goto_coast',
      targetTile: riverTile,
      finalGoal: [goal.x, goal.y],
    };
  }

  // --- Handle the builder sub-goal state machine ---
  private handleBuilderGoal(world: World, tank: Tank, mem: AiMemory): TankInput {
    const bg = mem.builderGoal;
    if (bg.kind === 'none') return { accel: 0, turn: 0, fire: false };

    // Once on a boat, the sub-goal is complete — let normal A* take over
    if (tank.onBoat) {
      mem.builderGoal = { kind: 'none' };
      return { accel: 0, turn: 0, fire: false };
    }

    switch (bg.kind) {
      case 'goto_coast': {
        // While heading to the coast, check for an existing boat nearby.
        const existingBoat = findNearestBoatTile(world, tank.x, tank.y, 15);
        if (existingBoat) {
          mem.builderGoal = { kind: 'embark', targetTile: existingBoat, finalGoal: bg.finalGoal };
          return steerAndShoot(world, tank, existingBoat[0] + 0.5, existingBoat[1] + 0.5, true, false);
        }
        // Navigate toward the nearest water tile.
        const [tx, ty] = bg.targetTile;
        const d = Math.sqrt((tx + 0.5 - tank.x) ** 2 + (ty + 0.5 - tank.y) ** 2);
        if (d <= BUILDER_MAX_RANGE) {
          // Close enough to start building. Do we have enough trees?
          if (tank.trees < COST_BOAT) {
            const forest = findNearestTerrain(world, tank.x, tank.y, Terrain.Forest, BUILDER_MAX_RANGE);
            if (forest) {
              const err = world.builderOrder(tank.id, 'harvest', forest[0], forest[1]);
              if (!err) {
                mem.builderGoal = { kind: 'harvest', targetTile: forest, finalGoal: bg.finalGoal };
              } else if (tank.trees >= COST_BOAT) {
                this.tryBoatOrder(world, tank, mem, [tx, ty], bg.finalGoal);
              } else {
                mem.builderGoal = { kind: 'none' };
              }
            } else if (tank.trees >= COST_BOAT) {
              this.tryBoatOrder(world, tank, mem, [tx, ty], bg.finalGoal);
            } else {
              mem.builderGoal = { kind: 'none' };
            }
          } else {
            this.tryBoatOrder(world, tank, mem, [tx, ty], bg.finalGoal);
          }
          return { accel: 0, turn: 0, fire: false };
        }
        // Not close enough — drive toward the coast tile.
        return steerAndShoot(world, tank, tx + 0.5, ty + 0.5, true, false);
      }

      case 'harvest': {
        if (tank.builder.phase === 'in_tank') {
          if (tank.trees >= COST_BOAT) {
            const riverTile = findNearestWater(world, tank.x, tank.y);
            if (riverTile) {
              const rd = Math.sqrt((riverTile[0] + 0.5 - tank.x) ** 2 + (riverTile[1] + 0.5 - tank.y) ** 2);
              if (rd <= BUILDER_MAX_RANGE) {
                this.tryBoatOrder(world, tank, mem, riverTile, bg.finalGoal);
              } else {
                mem.builderGoal = { kind: 'goto_coast', targetTile: riverTile, finalGoal: bg.finalGoal };
              }
            } else {
              mem.builderGoal = { kind: 'none' };
            }
          } else {
            // Need more trees
            const forest = findNearestTerrain(world, tank.x, tank.y, Terrain.Forest, BUILDER_MAX_RANGE);
            if (forest) {
              const err = world.builderOrder(tank.id, 'harvest', forest[0], forest[1]);
              if (!err) {
                mem.builderGoal = { kind: 'harvest', targetTile: forest, finalGoal: bg.finalGoal };
              } else {
                mem.builderGoal = { kind: 'none' };
              }
            } else {
              mem.builderGoal = { kind: 'none' };
            }
          }
        }
        return { accel: 0, turn: 0, fire: false };
      }

      case 'build_boat': {
        if (tank.builder.phase === 'in_tank') {
          const [bx, by] = bg.targetTile;
          const t = world.terrain[idx(bx, by)] as Terrain;
          if (t === Terrain.BoatTile) {
            mem.builderGoal = { kind: 'embark', targetTile: [bx, by], finalGoal: bg.finalGoal };
          } else {
            mem.builderGoal = { kind: 'none' };
          }
        }
        return { accel: 0, turn: 0, fire: false };
      }

      case 'embark': {
        // Navigate to the BoatTile. The tile-transition system sets
        // tank.onBoat when the tank drives onto a BoatTile; that clears
        // the sub-goal (checked above) and normal A* takes over.
        const [bx, by] = bg.targetTile;
        return steerAndShoot(world, tank, bx + 0.5, by + 0.5, true, false);
      }
    }
  }

  /** Dispatch a boat build order, transitioning to build_boat or giving up. */
  private tryBoatOrder(
    world: World, tank: Tank, mem: AiMemory,
    riverTile: [number, number], finalGoal: [number, number],
  ): void {
    if (tank.builder.phase !== 'in_tank') return;
    const err = world.builderOrder(tank.id, 'boat', riverTile[0], riverTile[1]);
    if (!err) {
      mem.builderGoal = { kind: 'build_boat', targetTile: riverTile, finalGoal };
    } else {
      mem.builderGoal = { kind: 'none' };
    }
  }

  // --- Find a sieged friendly base to defend ---
  private findSiegedBase(world: World, tank: Tank): Base | null {
    if (!this.team || this.team.siegedBases.size === 0) return null;
    let best: Base | null = null;
    let bestD = 900; // 30² — response radius
    for (const b of world.bases) {
      if (b.owner !== tank.faction) continue;
      if (!this.team.siegedBases.has(b.id)) continue;
      const dx = b.x + 0.5 - tank.x;
      const dy = b.y + 0.5 - tank.y;
      const dsq = dx * dx + dy * dy;
      if (dsq < bestD) {
        bestD = dsq;
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
    this._spatial.clear();
  }

  /**
   * Emit periodic NPC behavioral telemetry. Called once per tick after the
   * think() loop. Each NPC emits every ~5s, staggered by tank.id to avoid
   * all NPCs emitting on the same tick.
   */
  emitState(world: World): void {
    const period = TICK_HZ * 5; // 5 seconds
    for (const tank of world.tanks.values()) {
      if (!tank.alive || !tank.npc) continue;
      if (world.tick % period !== tank.id % period) continue;
      const mem = this.memories.get(tank.id);
      if (!mem) continue;

      // Parse goal info from goalKey ("base:<id>:<owner>" or other)
      let goalOwner: string | undefined;
      let distToGoal: number | undefined;
      if (mem.goalKey.startsWith('base:')) {
        const parts = mem.goalKey.split(':');
        goalOwner = parts[2];
        // find the base to measure distance
        const baseId = Number(parts[1]);
        const base = world.bases.find((b) => b.id === baseId);
        if (base) {
          const dx = base.x + 0.5 - tank.x;
          const dy = base.y + 0.5 - tank.y;
          distToGoal = Math.round(Math.sqrt(dx * dx + dy * dy) * 10) / 10;
        }
      }

      // Is the tank currently within refuel range of a friendly base?
      const refuelRsq = BASE_REFUEL_RADIUS * BASE_REFUEL_RADIUS;
      let atFriendlyBase = false;
      for (const b of world.bases) {
        if (b.owner !== tank.faction) continue;
        const dx = b.x + 0.5 - tank.x;
        const dy = b.y + 0.5 - tank.y;
        if (dx * dx + dy * dy <= refuelRsq) { atFriendlyBase = true; break; }
      }

      this.npcStats.push({
        name: 'npc_state',
        faction: tank.faction,
        decision: mem.decision || 'unknown',
        goal_key: mem.goalKey || undefined,
        goal_owner: goalOwner,
        dist_to_goal: distToGoal,
        shells: tank.shells,
        armor: tank.armor,
        at_friendly_base: atFriendlyBase,
        on_boat: tank.onBoat,
        stuck: mem.stuckTicks > TICK_HZ * 2,
        path_failed: mem.path.length === 0 && mem.goalKey.startsWith('base:'),
      });
    }
  }

  /** Drain accumulated NPC stats so the game DO can ship them. */
  drainStats(): StatEvent[] {
    if (this.npcStats.length === 0) return [];
    const out = this.npcStats;
    this.npcStats = [];
    return out;
  }

  private getMemory(tank: Tank): AiMemory {
    let mem = this.memories.get(tank.id);
    if (!mem) {
      mem = {
        path: [],
        pathIndex: 0,
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
        decision: '',
        siegeTargetId: -1,
        siegeTargetHp: 0,
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
    const heap = this.heap;
    heap.clear();
    heap.push(heur(start % MAP_SIZE, (start / MAP_SIZE) | 0), start);
    this.gScore[start] = 0;
    this.cameFrom[start] = start;
    this.stamp[start] = this.generation;
    let found = false;
    let expansions = 0;
    while (!heap.isEmpty()) {
      const { fScore: f, nodeId: cur } = heap.pop();
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
          heap.push(ng + heur(nx, ny), n);
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
  const trueDelta = angleDelta(tank.dir, Math.atan2(ty - tank.y, tx - tank.x));
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

  // facing uses the true (unjittered) angle so aim jitter doesn't suppress fire
  const facing = Math.abs(trueDelta) < 0.1;
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
  // Extra aversion for river: it's passable but slow and often signals a
  // water-crossing situation. Penalize so A* prefers land detours.
  if (t === Terrain.River) cost *= 1.5; // effective cost ~6 instead of ~4
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
          if ((nx + 0.5 - x) ** 2 + (ny + 0.5 - y) ** 2 <= maxRange * maxRange) return [nx, ny];
        }
      }
    }
  }
  return null;
}

/**
 * Find the nearest water tile (River or BoatTile) on the entire map.
 * Used when a tank needs to reach the coast for boat building but may
 * be deep inland. Only runs when A* already failed (once per backoff).
 */
function findNearestWater(world: World, x: number, y: number): [number, number] | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  const maxR = Math.max(tx, ty, MAP_SIZE - tx, MAP_SIZE - ty);
  for (let r = 1; r <= maxR; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) < r - 1) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
        const t = world.terrain[idx(nx, ny)] as Terrain;
        if (t === Terrain.River || t === Terrain.BoatTile) return [nx, ny];
      }
    }
  }
  return null;
}

/** Find the nearest built BoatTile within range. */
function findNearestBoatTile(world: World, x: number, y: number, maxRange: number): [number, number] | null {
  const tx = Math.floor(x);
  const ty = Math.floor(y);
  for (let r = 1; r <= maxRange; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        if (Math.max(Math.abs(dx), Math.abs(dy)) !== r) continue;
        const nx = tx + dx;
        const ny = ty + dy;
        if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
        if ((world.terrain[idx(nx, ny)] as Terrain) === Terrain.BoatTile) return [nx, ny];
      }
    }
  }
  return null;
}

/** Find the nearest friendly base to a tank. */
function findNearestFriendlyBase(world: World, tank: Tank): Base | null {
  let best: Base | null = null;
  let bestDsq = Infinity;
  for (const b of world.bases) {
    if (b.owner !== tank.faction) continue;
    const dx = b.x + 0.5 - tank.x;
    const dy = b.y + 0.5 - tank.y;
    const dsq = dx * dx + dy * dy;
    if (dsq < bestDsq) {
      bestDsq = dsq;
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

// The old tuple-array heapPush/heapPop functions have been replaced by
// the TypedMinHeap class (see typed-heap.ts) which uses parallel typed arrays
// for zero per-push allocations.

// angleDelta is now imported from @bolo/shared (deduplicated from math.ts)
