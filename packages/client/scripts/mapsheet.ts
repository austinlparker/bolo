/**
 * Map-generation contact sheet: renders whole-island terrain for a handful
 * of seeds at 2px/tile so mapgen tweaks can be eyeballed without a browser:
 *   pnpm --filter @bolo/client exec tsx scripts/mapsheet.ts 1 2 3 4 5 6
 * Writes /tmp/atbolo-mapsheet.png
 */
import { createCanvas } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { generateMap, MAP_SIZE, Terrain } from '@bolo/shared';

const seeds = process.argv.slice(2).map(Number);
if (seeds.length === 0) seeds.push(1, 2, 3, 4, 5, 6);

const COLORS: Record<Terrain, string> = {
  [Terrain.DeepSea]: '#0d1826',
  [Terrain.River]: '#2e547a',
  [Terrain.Swamp]: '#384e38',
  [Terrain.Crater]: '#4c3c29',
  [Terrain.Road]: '#b8b4a6', // bright so the road network pops
  [Terrain.Forest]: '#264628',
  [Terrain.Rubble]: '#525660',
  [Terrain.Grass]: '#4a683e',
  [Terrain.Building]: '#969ba8',
  [Terrain.ShotBuilding]: '#686c78',
  [Terrain.BoatTile]: '#7890aa',
};
const FACTION: Record<string, string> = { dawn: '#e8a33d', dusk: '#9b7df0', neutral: '#d8dee8' };

const PX = 2;
const COLS = Math.min(3, seeds.length);
const ROWS = Math.ceil(seeds.length / COLS);
const CELL = MAP_SIZE * PX;
const GAP = 12;
const canvas = createCanvas(COLS * CELL + (COLS + 1) * GAP, ROWS * (CELL + 18 + GAP) + GAP);
const ctx = canvas.getContext('2d');
ctx.fillStyle = '#07080c';
ctx.fillRect(0, 0, canvas.width, canvas.height);

seeds.forEach((seed, i) => {
  const gen = generateMap(seed);
  const ox = GAP + (i % COLS) * (CELL + GAP);
  const oy = GAP + Math.floor(i / COLS) * (CELL + 18 + GAP);
  for (let y = 0; y < MAP_SIZE; y++) {
    for (let x = 0; x < MAP_SIZE; x++) {
      ctx.fillStyle = COLORS[gen.terrain[y * MAP_SIZE + x] as Terrain];
      ctx.fillRect(ox + x * PX, oy + y * PX, PX, PX);
    }
  }
  for (const p of gen.pills) {
    ctx.fillStyle = '#e85d5d';
    ctx.fillRect(ox + p.x * PX - 1, oy + p.y * PX - 1, PX + 2, PX + 2);
  }
  for (const b of gen.bases) {
    ctx.fillStyle = FACTION[b.owner];
    ctx.fillRect(ox + b.x * PX - 2, oy + b.y * PX - 2, PX + 4, PX + 4);
    ctx.strokeStyle = '#000';
    ctx.strokeRect(ox + b.x * PX - 2, oy + b.y * PX - 2, PX + 4, PX + 4);
  }
  ctx.fillStyle = '#aab3c8';
  ctx.font = '12px monospace';
  ctx.fillText(`seed ${seed}`, ox, oy + CELL + 14);
});

writeFileSync('/tmp/atbolo-mapsheet.png', canvas.toBuffer('image/png'));
console.log('wrote /tmp/atbolo-mapsheet.png');
