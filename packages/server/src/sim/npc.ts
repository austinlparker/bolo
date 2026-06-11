/**
 * Garrison AI: simple server-side tanks that keep each faction populated so
 * the persistent war grinds on even when no humans are online. Deliberately
 * beatable — external bots connecting over the public protocol should be
 * able to outplay them.
 *
 * Navigation uses BFS over a coarse 4x4-tile grid, recomputed every few
 * seconds, with local steering between waypoints.
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
  path: [number, number][]; // tile-center waypoints from BFS
  pathAge: number; // ticks since computed
  goalKey: string;
  stuckTicks: number;
  lastX: number;
  lastY: number;
}

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
      return steerAndShoot(world, tank, enemy.x, enemy.y, enemyD > 3, tank.shells > 0);
    }

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

  // navigate via coarse BFS waypoints
  const goalKey = `base:${goal.id}:${goal.owner}`;
  mem.pathAge++;
  if (mem.goalKey !== goalKey || mem.pathAge > TICK_HZ * 4 || mem.path.length === 0) {
    mem.path = findPath(world, tank.x, tank.y, goal.x + 0.5, goal.y + 0.5);
    mem.pathAge = 0;
    mem.goalKey = goalKey;
    if (mem.path.length === 0 && Math.hypot(goal.x + 0.5 - tank.x, goal.y + 0.5 - tank.y) > 6) {
      // goal unreachable overland from here (cut off by sea/walls): wander
      // toward a random nearby spot and try again on the next recompute
      const ang = Math.random() * Math.PI * 2;
      mem.path = [[tank.x + Math.cos(ang) * 8, tank.y + Math.sin(ang) * 8]];
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
    mem = { path: [], pathAge: Infinity, goalKey: '', stuckTicks: 0, lastX: tank.x, lastY: tank.y };
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
): TankInput {
  const want = Math.atan2(ty - tank.y, tx - tank.x);
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

/**
 * Tile-level Dijkstra (4-connected) over drivable terrain, weighted by
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
  const N = MAP_SIZE * MAP_SIZE;
  const prev = new Int32Array(N).fill(-1);
  const dist = new Float64Array(N).fill(Infinity);
  // binary min-heap of [cost, tile]
  const heap: [number, number][] = [[0, start]];
  dist[start] = 0;
  prev[start] = start;
  while (heap.length > 0) {
    const [cost, cur] = heapPop(heap);
    if (cur === goal) break;
    if (cost > dist[cur]) continue;
    const cx = cur % MAP_SIZE;
    const cy = Math.floor(cur / MAP_SIZE);
    for (const [dx, dy] of [
      [1, 0], [-1, 0], [0, 1], [0, -1],
    ] as const) {
      const nx = cx + dx;
      const ny = cy + dy;
      if (nx < 0 || ny < 0 || nx >= MAP_SIZE || ny >= MAP_SIZE) continue;
      const n = ny * MAP_SIZE + nx;
      const c = tileCost(world, nx, ny);
      if (c === Infinity) continue;
      const nd = cost + c;
      if (nd < dist[n]) {
        dist[n] = nd;
        prev[n] = cur;
        heapPush(heap, [nd, n]);
      }
    }
  }
  if (prev[goal] === -1) return []; // unreachable; caller falls back/wanders
  const path: [number, number][] = [];
  let cur = goal;
  while (cur !== start) {
    path.unshift([(cur % MAP_SIZE) + 0.5, Math.floor(cur / MAP_SIZE) + 0.5]);
    cur = prev[cur];
  }
  return path;
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
  for (const [dx, dy] of [
    [1, 0], [-1, 0], [0, 1], [0, -1],
  ] as const) {
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
