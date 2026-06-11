/**
 * Headless render preview: shims the DOM bits the renderer needs, stages a
 * battle scene on a generated map, and writes PNG frames. Used to eyeball
 * visual changes without a browser:
 *   pnpm --filter @bolo/client exec tsx scripts/preview.ts
 */
import { createCanvas, loadImage } from '@napi-rs/canvas';
import { writeFileSync } from 'node:fs';
import { generateMap, MAP_SIZE } from '@bolo/shared';

// --- DOM shims (before importing render code) ---
(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error('only canvas supported');
    return createCanvas(300, 150);
  },
};
(globalThis as any).addEventListener = () => {};
(globalThis as any).innerWidth = 640;
(globalThis as any).innerHeight = 420;
(globalThis as any).performance = globalThis.performance ?? { now: () => Date.now() };

const { Renderer } = await import('../src/render');
const { GameState } = await import('../src/state');
const { loadSprites } = await import('../src/sprites');

// load the Kenney art from disk (same files the browser fetches from /assets)
const assetRoot = new URL('../public/assets/', import.meta.url).pathname;
await loadSprites(
  (url) => loadImage(url) as unknown as Promise<CanvasImageSource>,
  assetRoot,
);

const seed = Number(process.argv[2] ?? 12345);
const gen = generateMap(seed);

const state = new GameState();
state.terrain = gen.terrain as Uint8Array<ArrayBuffer>;
state.bases = gen.bases;
state.pills = gen.pills;
state.war = {
  warNumber: 3,
  seed,
  startedAt: Date.now(),
  phase: 'active',
  nextWarAt: null,
  baseCounts: { dawn: 5, dusk: 6, neutral: 3 },
};

// stage a scene near the first dawn base
const base = gen.bases.find((b) => b.owner === 'dawn') ?? gen.bases[0];
const cx = base.x + 3;
const cy = base.y + 1;

const mkTank = (id: number, handle: string, faction: 'dawn' | 'dusk', x: number, y: number, dir: number, extra = {}) => {
  const t = { id, handle, faction, npc: false, x, y, dir, speed: 2, alive: true, onBoat: false, ...extra };
  state.tanks.set(id, { cur: t as any, prev: t as any, lastUpdate: Date.now() });
};

state.you = { did: 'did:dev:you', handle: 'austin.dev', faction: 'dawn', tankId: 1 };
mkTank(1, 'austin.dev', 'dawn', cx, cy, 0.4, { armor: 32, shells: 18, mines: 4, trees: 9, carriedPill: null });
mkTank(2, '[dawn] anvil-3', 'dawn', cx - 4, cy + 2, 0.2, { npc: true });
mkTank(3, 'rival.bsky.social', 'dusk', cx + 9, cy + 4, Math.PI * 0.9);
mkTank(4, '[dusk] picket-7', 'dusk', cx + 11, cy - 3, Math.PI * 1.1, { npc: true });

state.builders.push({ tankId: 1, faction: 'dawn', phase: 'working', x: cx - 2.5, y: cy - 2 });
state.builders.push({ tankId: 3, faction: 'dusk', phase: 'outbound', x: cx + 7, y: cy + 6 });

state.shells = [
  { id: 90, x: cx + 4.5, y: cy + 2, dir: 0.35 },
  { id: 91, x: cx + 6.5, y: cy + 1.2, dir: Math.PI * 0.95 },
];
state.booms.push({ x: cx + 5.5, y: cy + 3.2, kind: 'shell', at: Date.now() - 120 });
state.booms.push({ x: cx - 1, y: cy + 5, kind: 'mine', at: Date.now() - 250 });

// a couple of visible friendly mines
state.mines.add(Math.floor(cy + 6) * MAP_SIZE + Math.floor(cx - 3));
state.mines.add(Math.floor(cy + 6) * MAP_SIZE + Math.floor(cx - 1));

// stage pillboxes near the camera: healthy dusk, angry neutral, dead husk
state.pills.push(
  { id: 90, x: Math.floor(cx + 6), y: Math.floor(cy - 4), owner: 'dusk', hp: 75, inTank: false, cooldown: 0 },
  { id: 91, x: Math.floor(cx - 5), y: Math.floor(cy - 3), owner: 'neutral', hp: 18, inTank: false, cooldown: 0 },
  { id: 92, x: Math.floor(cx + 2), y: Math.floor(cy + 5), owner: 'neutral', hp: 0, inTank: false, cooldown: 0 },
);
// a boat tile + a tank riding a boat
state.terrain[Math.floor(cy + 7) * MAP_SIZE + Math.floor(cx + 1)] = 10;
mkTank(5, 'marine.test', 'dusk', cx - 7, cy + 6.5, 0.9, { onBoat: true });

const canvas = createCanvas(640, 420) as unknown as HTMLCanvasElement;
const renderer = new Renderer(canvas);
renderer.scale = 48;
renderer.frame(state, Date.now());
writeFileSync('/tmp/bolo-preview-game.png', (canvas as any).toBuffer('image/png'));
console.log('wrote /tmp/bolo-preview-game.png');

// zoomed-out terrain overview (tile cache scaled down)
const over = createCanvas(1024, 1024);
const octx = over.getContext('2d');
const state2 = new GameState();
state2.terrain = gen.terrain as Uint8Array<ArrayBuffer>;
const { TileCache, TILE_PX } = await import('../src/tiles');
const cache = new TileCache();
cache.sync(state2 as any);
octx.imageSmoothingEnabled = true;
octx.drawImage(cache.canvas as any, 0, 0, MAP_SIZE * TILE_PX, MAP_SIZE * TILE_PX, 0, 0, 1024, 1024);
writeFileSync('/tmp/bolo-preview-island.png', over.toBuffer('image/png'));
console.log('wrote /tmp/bolo-preview-island.png');
