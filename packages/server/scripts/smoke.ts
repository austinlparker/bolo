/**
 * Headless sim smoke test: generates a map, lets the NPC garrisons fight,
 * and reports world health every simulated minute. Run with:
 *   pnpm --filter @bolo/server smoke
 */
import { MAP_SIZE, TICK_HZ, Terrain } from '@bolo/shared';
import { balanceNpcs, npcThink } from '../src/sim/npc';
import { World } from '../src/sim/world';

const seed = Number(process.argv[2] ?? 12345);
const minutes = Number(process.argv[3] ?? 30);

const world = new World(1, seed);

// map sanity
const counts = new Map<number, number>();
for (const t of world.terrain) counts.set(t, (counts.get(t) ?? 0) + 1);
const land = MAP_SIZE * MAP_SIZE - (counts.get(Terrain.DeepSea) ?? 0);
console.log(`map seed=${seed}: ${world.bases.length} bases, ${world.pills.length} pills, land=${((land / (MAP_SIZE * MAP_SIZE)) * 100).toFixed(0)}%`);
for (const [t, n] of [...counts.entries()].sort((a, b) => b[1] - a[1])) {
  console.log(`  terrain ${Terrain[t]}: ${n}`);
}
if (world.bases.length === 0 || world.pills.length === 0) {
  console.error('FAIL: no bases or pills placed');
  process.exit(1);
}

// symmetry check
let asym = 0;
for (let y = 0; y < MAP_SIZE; y++) {
  for (let x = 0; x < MAP_SIZE; x++) {
    const a = world.terrain[y * MAP_SIZE + x];
    const b = world.terrain[(MAP_SIZE - 1 - y) * MAP_SIZE + (MAP_SIZE - 1 - x)];
    if (a !== b) asym++;
  }
}
console.log(`symmetry violations: ${asym}`);

let totalEvents = 0;
let kills = 0;
let caps = 0;
const start = Date.now();
for (let tick = 0; tick < minutes * 60 * TICK_HZ; tick++) {
  if (tick % (TICK_HZ * 2) === 0) balanceNpcs(world);
  for (const tank of world.tanks.values()) {
    if (tank.npc) world.setInput(tank.id, npcThink(world, tank));
  }
  const result = world.doTick(tick / (60 * TICK_HZ));
  totalEvents += result.events.length;
  for (const e of result.events) {
    if (e.e === 'kill') kills++;
    if (e.e === 'base_captured') caps++;
  }
  if (tick % (60 * TICK_HZ) === 0) {
    const info = world.warInfo('active', null);
    const tanks = [...world.tanks.values()];
    console.log(
      `t+${(tick / (60 * TICK_HZ)).toFixed(0)}m  bases d/n/k: ${info.baseCounts.dawn}/${info.baseCounts.neutral}/${info.baseCounts.dusk}  tanks: ${tanks.length}  shells-in-flight: ${world.shells.length}  kills: ${kills}  caps: ${caps}`,
    );
  }
  if (result.warEnded) {
    console.log(`WAR ENDED at t+${(tick / (60 * TICK_HZ)).toFixed(1)}m — winner: ${result.warEnded}`);
    break;
  }
}
const wallMs = Date.now() - start;
const simTicks = world.tick;
console.log(
  `done: ${simTicks} ticks in ${wallMs}ms (${((simTicks / wallMs) * 1000).toFixed(0)} ticks/sec — ${(simTicks / wallMs / TICK_HZ * 1000).toFixed(0)}x realtime), ${totalEvents} events`,
);
