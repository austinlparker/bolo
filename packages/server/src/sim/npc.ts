/**
 * Garrison AI: simple server-side tanks that keep each faction populated so
 * the persistent war grinds on even when no humans are online. Deliberately
 * beatable — external bots connecting over the public protocol should be
 * able to outplay them.
 *
 * Navigation uses weighted A* over the tile grid, recomputed only when a
 * path is consumed or its goal changes, with local steering between
 * waypoints.
 */
import {
  type Faction,
  FACTIONS,
  MAP_SIZE,
  NPC_MIN_PER_FACTION,
  NPC_MAX_TOTAL,
  PILL_RANGE,
  SHELL_RANGE,
  Terrain,
  TERRAIN,
  TICK_HZ,
} from '@bolo/shared';
import type { Base, Pillbox, Tank } from '@bolo/shared';
import type { TankInput, World } from './world';

const NPC_NAMES = [
  'patrol', 'lancer', 'bastion', 'vanguard', 'sentry', 'warden',
  'breaker', 'anvil', 'hammer', 'picket', 'outrider', 'sapper',
];

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
}

// Humanizers: garrison bots aimed with perfect server-side information and
// fired the same tick a target entered range — telemetry showed a 52% bot
// hit rate vs 7-10% for humans, and a 12:1 kill ratio. A beat of reaction
// time plus a wandering aim error keeps them dangerous but beatable.
const NPC_REACTION_TICKS = Math.round(TICK_HZ * 0.6);
const NPC_AIM_SPREAD = 0.12; // radians; ~7° max error, resampled at 2Hz

let npcCounter = 0;
const memories = new Map<number, AiMemory>();

/** Top up factions to the minimum population; cull extras when humans show up. */
export function balanceNpcs(world: World): void {
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
      const name = `${NPC_NAMES[npcCounter % NPC_NAMES.length]}-${++npcCounter}`;
      world.addTank(`npc:${name}`, `[${f}] ${name}`, f, true);
      totals[f]++;
      npcTotal++;
    }
    while (totals[f] > NPC_MIN_PER_FACTION && npcsByFaction[f].length > 0) {
      const t = npcsByFaction[f].pop()!;
      memories.delete(t.id);
      world.removeTank(t.id);
      totals[f]--;
      npcTotal--;
    }
  }
}

export function npcThink(world: World, tank: Tank): TankInput {
  if (!tank.alive) return { accel: 0, turn: 0, fire: false };
  const mem = getMemory(tank);

  // out of ammo (or badly mauled) means disengage and run for resupply —
  // duelling with an empty rack is how garrisons used to deadlock the war
  const needSupply = tank.shells < 5 || tank.armor < 15;

  if (!needSupply) {
    // 1) duel the nearest visible enemy tank in range
    let enemy: Tank | null = null;
    let enemyD = SHELL_RANGE;
    for (const other of world.tanks.values()) {
      if (!other.alive || other.faction === tank.faction) continue;
      if (world.tileAt(other.x, other.y) === Terrain.Forest) continue; // can't see into trees
      const d = Math.hypot(other.x - tank.x, other.y - tank.y);
      if (d < enemyD) {
        enemyD = d;
        enemy = other;
      }
    }
    if (enemy) {
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
        world, tank, enemy.x, enemy.y, enemyD > 3, acquired && tank.shells > 0, mem.aimJitter,
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

  // 3) strategic goal: resupply when low, otherwise march on a base we don't own
  let goal: Base | null = null;
  let bestScore = Infinity;
  const haveHomeBase = world.bases.some((b) => b.owner === tank.faction);
  const resupplying = needSupply && haveHomeBase;
  for (const b of world.bases) {
    const isMine = b.owner === tank.faction;
    if (resupplying ? !isMine : isMine) continue;
    const d = Math.hypot(b.x + 0.5 - tank.x, b.y + 0.5 - tank.y);
    const bias = !resupplying && b.owner !== 'neutral' ? 40 : 0; // prefer free real estate
    if (d + bias < bestScore) {
      bestScore = d + bias;
      goal = b;
    }
  }
  if (!goal) return { accel: 0, turn: 0, fire: false };

  // bombard a defended enemy base before driving onto the pad
  const goalD = Math.hypot(goal.x + 0.5 - tank.x, goal.y + 0.5 - tank.y);
  if (!resupplying && goal.owner !== 'neutral' && goal.armorStock > 0 && goalD < SHELL_RANGE * 0.9) {
    return steerAndShoot(world, tank, goal.x + 0.5, goal.y + 0.5, goalD > 4, tank.shells > 0);
  }

  // navigate via A* waypoints. Repath only when the goal changes or the
  // path is consumed, plus a slow per-tank-staggered staleness refresh so
  // terrain edits eventually reroute everyone. (The old fixed 4s cadence
  // meant every garrison repathing on the same ticks — synchronized
  // full-map searches were the main driver of the DO's CPU blowouts.)
  const goalKey = `base:${goal.id}:${goal.owner}`;
  mem.pathAge++;
  const stale = mem.pathAge > TICK_HZ * (8 + (tank.id % 5));
  if (mem.goalKey !== goalKey || stale || (mem.path.length === 0 && goalD > 1.5)) {
    mem.path = findPath(world, tank.x, tank.y, goal.x + 0.5, goal.y + 0.5);
    mem.pathAge = 0;
    mem.goalKey = goalKey;
    if (mem.path.length === 0 && goalD > 6) {
      // goal unreachable overland from here (cut off by sea/walls): wander
      // toward a random nearby spot and try again on the next recompute
      const ang = Math.random() * Math.PI * 2;
      mem.path = [[tank.x + Math.cos(ang) * 8, tank.y + Math.sin(ang) * 8]];
    } else if (mem.path.length === 0 && goalD > 1.5) {
      // nearby but no route found: drive straight at it and let local
      // steering cope, instead of re-searching the map every tick
      mem.path = [[goal.x + 0.5, goal.y + 0.5]];
    }
  }
  // reach radius must exceed the tank's full-speed turn radius (~0.94 tiles,
  // v/ω = 4.0/3.2 at top speed) or tanks orbit a waypoint forever
  let [wx, wy] = mem.path[0] ?? [goal.x + 0.5, goal.y + 0.5];
  while (mem.path.length > 0 && Math.hypot(wx - tank.x, wy - tank.y) < 1.5) {
    mem.path.shift();
    [wx, wy] = mem.path[0] ?? [goal.x + 0.5, goal.y + 0.5];
  }

  // unstick: wedged against geometry for 3s -> wander somewhere random,
  // then replan from the new position
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

function getMemory(tank: Tank): AiMemory {
  let mem = memories.get(tank.id);
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
    };
    memories.set(tank.id, mem);
  }
  return mem;
}

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

  // local avoidance: probe ahead, veer away from walls and open sea
  const probe = (ang: number) => {
    const t = world.tileAt(tank.x + Math.cos(ang) * 1.6, tank.y + Math.sin(ang) * 1.6);
    return t === Terrain.Building || (t === Terrain.DeepSea && !tank.onBoat);
  };
  // proportional steering: quantized ±1 turn oscillates around the firing
  // window forever; analog turn converges
  let turn = Math.max(-1, Math.min(1, delta * 3));
  let blocked = false;
  if (probe(tank.dir)) {
    blocked = true;
    // pick the clearer side
    turn = probe(tank.dir + 0.7) ? -1 : 1;
  }

  const facing = Math.abs(delta) < 0.1;
  // slow down for hard turns: a tank at speed can't corner tightly
  const hardTurn = Math.abs(delta) > 0.9 && !blocked;
  return {
    accel: (advance || blocked) && !hardTurn ? 1 : 0,
    turn,
    fire: wantFire && facing && !blocked,
  };
}

// A* scratch buffers, allocated once. findPath used to allocate ~768KB of
// typed arrays per call; with a dozen garrisons repathing, the allocation +
// zeroing churn was real CPU inside the DO's single budget (see the
// [limits] note in wrangler.toml). `stamp` marks which search generation
// initialized a cell, so the arrays never need clearing between calls.
const N_TILES = MAP_SIZE * MAP_SIZE;
const gScore = new Float64Array(N_TILES);
const cameFrom = new Int32Array(N_TILES);
const stamp = new Int32Array(N_TILES);
let generation = 0;
/**
 * Search budget: an unreachable goal would otherwise exhaust all 65k tiles
 * on every repath, which is exactly the pathological case that blew the DO's
 * CPU limit. A capped search reads as "unreachable" to the caller, which
 * falls back to wandering.
 */
const MAX_EXPANSIONS = 12000;
/** Weighted A* (h x 1.2): slightly suboptimal routes, far fewer expansions. */
const HEURISTIC_WEIGHT = 1.2;

const NEIGHBORS = [
  [1, 0], [-1, 0], [0, 1], [0, -1],
] as const;

/**
 * Tile-level weighted A* (4-connected) over drivable terrain, weighted by
 * terrain speed so routes prefer roads and open ground. Tiles bordering
 * deep sea carry a heavy penalty: an unweighted "shortest" path hugs the
 * coastline through shallow water, where local steering wedges tanks
 * against the sea edge. Tile resolution matters too — 1-tile bridges and
 * fords are real corridors a coarser grid would wall off.
 */
function findPath(world: World, x0: number, y0: number, x1: number, y1: number): [number, number][] {
  const start = tileOf(x0, y0);
  const goal = tileOf(x1, y1);
  if (start === goal) return [];
  generation++;
  const gx = goal % MAP_SIZE;
  const gy = (goal / MAP_SIZE) | 0;
  // manhattan distance, admissible since the cheapest tile (road) costs 1
  const heur = (x: number, y: number) => (Math.abs(gx - x) + Math.abs(gy - y)) * HEURISTIC_WEIGHT;
  // binary min-heap of [f = g + h, tile]
  const heap: [number, number][] = [[heur(start % MAP_SIZE, (start / MAP_SIZE) | 0), start]];
  gScore[start] = 0;
  cameFrom[start] = start;
  stamp[start] = generation;
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
    if (f > gScore[cur] + heur(cx, cy)) continue; // stale heap entry
    if (++expansions > MAX_EXPANSIONS) break;
    for (const [dx, dy] of NEIGHBORS) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
      const n = ny * MAP_SIZE + nx;
      const c = tileCost(world, nx, ny);
      if (c === Infinity) continue;
      const ng = gScore[cur] + c;
      if (stamp[n] !== generation || ng < gScore[n]) {
        stamp[n] = generation;
        gScore[n] = ng;
        cameFrom[n] = cur;
        heapPush(heap, [ng + heur(nx, ny), n]);
      }
    }
  }
  if (!found) return []; // unreachable or over budget; caller falls back
  const path: [number, number][] = [];
  let cur = goal;
  while (cur !== start) {
    path.push([(cur % MAP_SIZE) + 0.5, ((cur / MAP_SIZE) | 0) + 0.5]);
    cur = cameFrom[cur];
  }
  return path.reverse();
}

function tileOf(x: number, y: number): number {
  const cx = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(x)));
  const cy = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(y)));
  return cy * MAP_SIZE + cx;
}

function tileCost(world: World, x: number, y: number): number {
  const t = world.terrain[y * MAP_SIZE + x] as Terrain;
  if (t === Terrain.DeepSea || t === Terrain.Building || TERRAIN[t].tankSpeed === 0) return Infinity;
  let cost = 1 / TERRAIN[t].tankSpeed; // road 1, grass 1.33, river/swamp 4
  for (const [dx, dy] of NEIGHBORS) {
    const nx = x + dx;
    const ny = y + dy;
    if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
    if ((world.terrain[ny * MAP_SIZE + nx] as Terrain) === Terrain.DeepSea) {
      cost += 12; // stay off the sea cliff
      break;
    }
  }
  return cost;
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
