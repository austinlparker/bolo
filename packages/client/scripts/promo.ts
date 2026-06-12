/**
 * Promo renderer: runs the REAL server sim through the REAL client
 * renderer and writes a 28s vertical (1080x1920 @30fps) frame sequence
 * plus an sfx event timeline. Assemble with scripts/promo.sh.
 *
 *   npx tsx scripts/promo.ts
 *
 * Beats: island reveal -> FIGHT (hero charge) -> BUILD (base capture +
 * builder at work) -> CONQUER (brawl + mine chain) -> end card.
 */
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAP_SIZE, MineState, Terrain } from '@bolo/shared';
import type { Faction } from '@bolo/shared';

// --- output geometry ---
// default: 9:16 vertical (Shorts/Reels). `npx tsx scripts/promo.ts square`
// renders 1:1, which Bluesky's feed shows full-bleed instead of letterboxed.
const SQUARE = process.argv.includes('square');
const VW = 1080;
const VH = SQUARE ? 1080 : 1920;
const FPS = 30;
const DUR = 28; // seconds
const OUT = SQUARE ? '/tmp/atbolo-promo-sq' : '/tmp/atbolo-promo';

// vertical text layout per aspect (x is always centered on VW)
const Y = SQUARE
  ? { stamp: 270, titleMain: 330, titleSub: 436, titleTag: 492, capture: 360,
      cardMain: 450, cardSub: 560, cardTag: 630, cardUrl: 740, cardEnlist: 808, cardFree: 866 }
  : { stamp: 430, titleMain: 560, titleSub: 700, titleTag: 770, capture: 620,
      cardMain: 760, cardSub: 880, cardTag: 990, cardUrl: 1130, cardEnlist: 1210, cardFree: 1290 };
const CARD_MAIN_PX = SQUARE ? 140 : 170;

// --- DOM shims (before importing render code) ---
(globalThis as any).document = {
  createElement: (tag: string) => {
    if (tag !== 'canvas') throw new Error('only canvas supported');
    return createCanvas(300, 150);
  },
};
(globalThis as any).addEventListener = () => {};
(globalThis as any).innerWidth = VW;
(globalThis as any).innerHeight = VH;
(globalThis as any).devicePixelRatio = 1;
(globalThis as any).performance = globalThis.performance ?? { now: () => Date.now() };

const { Renderer } = await import('../src/render');
const { GameState } = await import('../src/state');
const { loadSprites } = await import('../src/sprites');
const { World } = await import('../../server/src/sim/world');
const { npcThink } = await import('../../server/src/sim/npc');

const assetRoot = new URL('../public/assets/', import.meta.url).pathname;
GlobalFonts.registerFromPath(`${assetRoot}fonts/kenney-future.ttf`, 'Kenney Future');
GlobalFonts.registerFromPath(`${assetRoot}fonts/kenney-future-narrow.ttf`, 'Kenney Future Narrow');
await loadSprites((url) => loadImage(url) as unknown as Promise<CanvasImageSource>, assetRoot);

// --- world + stage -----------------------------------------------------
const world = new World(7, 31337);
const C = 128;

// terraform a stage around the island center: open field, a road spine,
// forest clumps for cover, everything else stays the generated island
const setT = (x: number, y: number, t: Terrain) => {
  world.terrain[y * MAP_SIZE + x] = t;
};
for (let y = C - 26; y < C + 26; y++) {
  for (let x = C - 22; x < C + 24; x++) {
    setT(x, y, Terrain.Grass);
  }
}
for (let y = C - 26; y < C + 26; y++) setT(C, y, Terrain.Road); // road spine
const clump = (cx: number, cy: number, r: number) => {
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setT(x, y, Terrain.Forest);
};
clump(C - 10, C - 12, 3);
clump(C + 9, C - 6, 2);
clump(C - 11, C + 4, 2);
clump(C + 11, C + 10, 3);
// battle scars: this island has seen some things
for (const [sx, sy, st] of [
  [C - 4, C - 7, Terrain.Crater],
  [C + 3, C - 10, Terrain.Crater],
  [C - 2, C + 6, Terrain.Crater],
  [C + 5, C - 1, Terrain.Rubble],
  [C - 6, C - 14, Terrain.Rubble],
  [C + 2, C - 4, Terrain.Swamp],
  [C + 3, C - 4, Terrain.Swamp],
  [C - 13, C - 2, Terrain.Forest],
  [C + 4, C + 9, Terrain.Forest],
  [C - 3, C - 16, Terrain.Forest],
] as [number, number, Terrain][]) {
  setT(sx, sy, st);
}

// keep generated clutter off the stage
world.pills = world.pills.filter(
  (p) => Math.abs(p.x - C) > 18 || Math.abs(p.y - C) > 24,
);
// one neutral base on the road, south: the BUILD beat's prize
const prize = world.bases[0];
prize.owner = 'neutral';
prize.x = C;
prize.y = C + 12;
prize.armorStock = 0;
prize.shellStock = 20;
for (const b of world.bases.slice(1)) {
  if (Math.abs(b.x - C) < 20 && Math.abs(b.y - C) < 26) b.x = 40; // shove off-stage
}
for (let y = prize.y - 1; y <= prize.y + 1; y++)
  for (let x = prize.x - 1; x <= prize.x + 1; x++) setT(x, y, Terrain.Grass);
setT(prize.x, prize.y, Terrain.Road);

// the cast
const hero = world.addTank('did:promo:hero', 'you.bsky.social', 'dawn', false, 'keyboard');
const dawnA = world.addTank('npc:anvil', '[dawn] anvil-3', 'dawn', true);
const dawnB = world.addTank('npc:hammer', '[dawn] hammer-5', 'dawn', true);
const duskA = world.addTank('npc:picket', '[dusk] picket-7', 'dusk', true);
const duskB = world.addTank('npc:warden', '[dusk] warden-2', 'dusk', true);
const duskC = world.addTank('npc:sapper', '[dusk] sapper-9', 'dusk', true);
const runner = world.addTank('npc:outrider', '[dusk] outrider-4', 'dusk', true);

const place = (t: any, x: number, y: number, dir: number, armor = 40) => {
  t.x = x;
  t.y = y;
  t.dir = dir;
  t.speed = 0;
  t.armor = armor;
  t.shells = 40;
};
// FIGHT stage: dawn line west, dusk line east, ~11 tiles apart
place(hero, C - 6, C - 9, 0);
place(dawnA, C - 8, C - 6, 0.2);
place(dawnB, C - 8, C - 12, -0.2);
place(duskA, C + 6, C - 8, Math.PI, 20);
place(duskB, C + 7, C - 11, Math.PI, 20);
place(duskC, C + 7, C - 5, Math.PI, 20);
place(runner, C - 13, C + 3, 0, 20); // CONQUER's sacrificial mine-runner
hero.trees = 20;

// CONQUER minefield: a visible line of mines across the mid-field
const MINE_Y = C + 2;
const mineXs = [C - 7, C - 6, C - 5, C - 4, C - 3];
for (const mx of mineXs) world.mines[MINE_Y * MAP_SIZE + mx] = MineState.Dawn;

// --- client state + sync ------------------------------------------------
const state = new GameState();
state.terrain = new Uint8Array(world.terrain);
state.bases = world.bases as any;
state.pills = world.pills as any;
state.war = {
  warNumber: 7,
  seed: 31337,
  startedAt: 0,
  phase: 'active',
  nextWarAt: null,
  baseCounts: { dawn: 6, dusk: 7, neutral: 1 },
};
for (const mx of mineXs) state.mines.add(MINE_Y * MAP_SIZE + mx);

interface SfxEvent {
  t: number; // video seconds
  kind: 'fire' | 'boom' | 'bigboom' | 'capture';
}
const sfx: SfxEvent[] = [];
const seenShells = new Set<number>();
let captureAt = -1; // video time of the BUILD capture, for the overlay

const T0 = 200_000; // sim clock origin (ms)
let simTime = T0;
const vt = (sim: number) => (sim - T0) / 1000;

function syncTick(camX: number, camY: number): void {
  // hero plot armor: the camera star does not die on camera
  hero.armor = Math.max(hero.armor, 30);
  const result = world.doTick(1);

  for (const tank of world.tanks.values()) {
    const view = {
      id: tank.id,
      handle: tank.handle,
      faction: tank.faction,
      npc: tank.npc,
      x: tank.x,
      y: tank.y,
      dir: tank.dir,
      speed: tank.speed,
      alive: tank.alive,
      onBoat: tank.onBoat,
      armor: tank.armor,
      shells: tank.shells,
      mines: tank.mines,
      trees: tank.trees,
      carriedPill: tank.carriedPill,
      gunRange: tank.gunRange,
    };
    const it = state.tanks.get(tank.id);
    if (it) {
      it.cur = view as any;
      it.snaps.push({ view: view as any, at: simTime });
      if (it.snaps.length > 5) it.snaps.shift();
    } else {
      state.tanks.set(tank.id, { cur: view as any, snaps: [{ view: view as any, at: simTime }] });
    }
  }

  const near = (x: number, y: number, r = 26) => Math.hypot(x - camX, y - camY) < r;
  for (const s of world.shells) {
    if (!seenShells.has(s.id)) {
      seenShells.add(s.id);
      if (near(s.x, s.y)) sfx.push({ t: vt(simTime), kind: 'fire' });
    }
  }
  state.shells = world.shells
    .filter((s) => near(s.x, s.y, 40))
    .map((s) => ({ id: s.id, x: s.x, y: s.y, dir: s.dir, f: s.faction }));
  state.shellsAt = simTime;

  state.buildersPrev = new Map(state.builders.map((b) => [b.tankId, { x: b.x, y: b.y }]));
  state.builders = [];
  for (const tank of world.tanks.values()) {
    const b = tank.builder;
    if (b.phase !== 'in_tank' && b.phase !== 'dead') {
      state.builders.push({ tankId: tank.id, faction: tank.faction, phase: b.phase, x: b.x, y: b.y });
    }
  }
  state.buildersAt = simTime;

  for (const [x, y, t] of result.terrainChanges) {
    state.terrain[y * MAP_SIZE + x] = t;
    state.logTerrainChange(x, y);
  }
  for (const [x, y, m] of result.mineChanges) {
    if (m === MineState.None) state.mines.delete(y * MAP_SIZE + x);
  }
  for (const e of result.events) {
    if (e.e === 'boom') {
      state.booms.push({ x: e.x, y: e.y, kind: e.kind, at: simTime });
      if (near(e.x, e.y)) sfx.push({ t: vt(simTime), kind: e.kind === 'mine' ? 'bigboom' : 'boom' });
    } else if (e.e === 'kill') {
      if (near((e as any).x ?? camX, (e as any).y ?? camY)) sfx.push({ t: vt(simTime), kind: 'bigboom' });
    } else if (e.e === 'base_captured') {
      // only the hero's scripted BUILD-beat capture gets the fanfare
      if (e.handle === hero.handle && vt(simTime) > 12) {
        sfx.push({ t: vt(simTime), kind: 'capture' });
        if (captureAt < 0) captureAt = vt(simTime);
      }
    }
  }
  if (result.basesChanged) state.bases = [...world.bases] as any;
}

/** crude hero autopilot: face the nearest living enemy, close, shoot */
function heroInput(): { accel: number; turn: number; fire: boolean } {
  let best: any = null;
  let bestD = 14;
  for (const t of world.tanks.values()) {
    if (!t.alive || t.faction === 'dawn') continue;
    const d = Math.hypot(t.x - hero.x, t.y - hero.y);
    if (d < bestD) {
      bestD = d;
      best = t;
    }
  }
  if (!best) return { accel: 0, turn: 0.18, fire: false }; // scan, don't wander off-set
  let delta = Math.atan2(best.y - hero.y, best.x - hero.x) - hero.dir;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return {
    accel: bestD > 4.5 ? 1 : 0,
    turn: Math.max(-1, Math.min(1, delta * 3)),
    fire: Math.abs(delta) < 0.14 && bestD < 9,
  };
}

// --- beats ---------------------------------------------------------------
const ease = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));

interface Cam {
  x: number;
  y: number;
  scale: number;
  follow: boolean; // follow the hero instead of x/y
}

/** camera + scripted actions for video-time t (seconds) */
function direct(t: number): Cam {
  if (t < 4) {
    // A: island reveal, slow push-in
    const k = ease(t / 4);
    return { x: C, y: C - 4, scale: 4.3 + 2.2 * k, follow: false };
  }
  if (t < 12) {
    // B: FIGHT — ride with the hero
    return { x: 0, y: 0, scale: 34, follow: true };
  }
  if (t < 17.5) {
    // C: BUILD — hero is heading for the prize base
    return { x: 0, y: 0, scale: 32, follow: true };
  }
  if (t < 23) {
    // D: CONQUER — fixed shot of the brawl + minefield, slow push-in
    const k = (t - 17.5) / 5.5;
    return { x: C - 4, y: C + 2, scale: 22 + 6 * k, follow: false };
  }
  return { x: C, y: C, scale: 6, follow: false };
}

// FIGHT-stage posts: respawned or straying fighters redeploy here so the
// battle stays in front of the camera instead of dispersing across the island
const POSTS: [any, number, number, number][] = [
  [dawnA, C - 8, C - 6, 0.2],
  [dawnB, C - 8, C - 12, -0.2],
  [duskA, C + 6, C - 8, Math.PI],
  [duskB, C + 7, C - 11, Math.PI],
  [duskC, C + 7, C - 5, Math.PI],
];
function holdTheSet(): void {
  for (const [tk, sx, sy, dir] of POSTS) {
    if (tk.alive && Math.hypot(tk.x - sx, tk.y - sy) > 14) {
      tk.x = sx;
      tk.y = sy;
      tk.dir = dir;
      tk.speed = 0;
      tk.armor = Math.max(tk.armor, 20);
      tk.shells = 40;
      state.tanks.delete(tk.id); // hard cut, no cross-map lerp
    }
  }
}

let beatCDone = false;
let beatDDone = false;
function scriptedActions(t: number): void {
  // hero control
  if (t < 12) {
    holdTheSet();
    const inp = heroInput();
    world.setInput(hero.id, inp);
  } else if (t < 17.5) {
    holdTheSet();
    if (!beatCDone) {
      beatCDone = true;
      // hard cut: hero redeploys north of the prize base
      hero.x = prize.x - 0.2;
      hero.y = prize.y - 6;
      hero.dir = Math.PI / 2;
      hero.speed = 0;
      state.tanks.delete(hero.id); // reset interp so the cut doesn't lerp
    }
    // drive down the road onto the pad; order the builder once close
    const d = prize.y - hero.y;
    world.setInput(hero.id, { accel: d > 0.6 ? 0.8 : 0, turn: 0, fire: false });
    if (d < 3 && hero.builder.phase === 'in_tank' && hero.trees >= 2) {
      world.builderOrder(hero.id, 'road', prize.x - 3, prize.y - 1);
    }
  } else if (t < 23) {
    if (!beatDDone) {
      beatDDone = true;
      // stage the brawl around the minefield; everyone limps in damaged
      place(hero, C + 1, C + 4, Math.PI, 40);
      place(dawnA, C - 1, C - 1, -0.6, 25);
      place(dawnB, C + 3, C + 1, Math.PI * 0.8, 25);
      place(duskA, C - 9, C - 1, -0.4, 18);
      place(duskB, C - 10, C + 5, 0.3, 18);
      place(duskC, C - 6, C + 7, 0.8, 18);
      place(runner, C - 12, MINE_Y, 0, 18);
      if (!runner.alive) {
        runner.alive = true;
        runner.respawnTick = 0;
      }
      for (const id of [hero.id, dawnA.id, dawnB.id, duskA.id, duskB.id, duskC.id, runner.id]) {
        state.tanks.delete(id);
      }
    }
    // the runner charges straight across the minefield
    world.setInput(runner.id, { accel: 1, turn: 0, fire: false });
    world.setInput(hero.id, heroInput());
  }
}

// --- text overlays -------------------------------------------------------
function spaced(ctx: any, text: string, cx: number, y: number, font: string, gapEm: number, fill: string): void {
  ctx.font = font;
  const widths = [...text].map((ch: string) => ctx.measureText(ch).width);
  const gap = ctx.measureText('M').width * gapEm;
  const total = widths.reduce((a: number, b: number) => a + b, 0) + gap * (text.length - 1);
  let x = cx - total / 2;
  ctx.fillStyle = fill;
  for (let i = 0; i < text.length; i++) {
    ctx.fillText(text[i], x + widths[i] / 2, y);
    x += widths[i] + gap;
  }
}

function stamp(ctx: any, text: string, t: number, start: number, hold = 1.6): void {
  const a = t - start;
  if (a < 0 || a > hold + 0.4) return;
  const popIn = clamp01(a / 0.18);
  const fade = a > hold ? 1 - (a - hold) / 0.4 : 1;
  const size = 150 * (1.35 - 0.35 * ease(popIn));
  ctx.save();
  ctx.globalAlpha = popIn * fade;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${size}px "Kenney Future"`;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillText(text, VW / 2 + 6, Y.stamp + 6);
  ctx.fillStyle = '#e8e6df';
  ctx.fillText(text, VW / 2, Y.stamp);
  ctx.restore();
}

function overlays(ctx: any, t: number): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // A: title
  if (t < 4.2) {
    const inA = clamp01((t - 0.5) / 0.8);
    const outA = t > 3.4 ? 1 - clamp01((t - 3.4) / 0.6) : 1;
    ctx.save();
    ctx.globalAlpha = inA * outA;
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    spaced(ctx, 'ATBOLO', VW / 2 + 6, Y.titleMain + 6, '180px "Kenney Future"', 0.08, 'rgba(0,0,0,0.55)');
    spaced(ctx, 'ATBOLO', VW / 2, Y.titleMain, '180px "Kenney Future"', 0.08, '#e8a33d');
    spaced(ctx, 'THE FOREVER WAR', VW / 2, Y.titleSub, '54px "Kenney Future Narrow"', 0.18, '#e8e6df');
    ctx.globalAlpha = inA * outA * 0.85;
    ctx.font = '34px "Kenney Future Narrow"';
    ctx.fillStyle = '#9aa3ad';
    ctx.fillText('a persistent multiplayer tank war', VW / 2, Y.titleTag);
    ctx.restore();
  }

  stamp(ctx, 'FIGHT', t, 4.4);
  stamp(ctx, 'BUILD', t, 12.4);
  stamp(ctx, 'CONQUER', t, 19.6);

  // BUILD: capture confirmation
  if (captureAt > 0 && t > captureAt && t < captureAt + 2) {
    const a = clamp01((t - captureAt) / 0.2) * (t > captureAt + 1.5 ? 1 - (t - captureAt - 1.5) / 0.5 : 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = '52px "Kenney Future Narrow"';
    ctx.fillStyle = '#e8a33d';
    ctx.fillText('+1 BASE — DAWN CONCORD', VW / 2, Y.capture);
    ctx.restore();
  }

  // E: end card
  if (t >= 23) {
    const a = clamp01((t - 23) / 0.5);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, VW, VH);
    const g = ctx.createRadialGradient(VW / 2, VH * 0.42, 100, VW / 2, VH * 0.42, 900);
    g.addColorStop(0, 'rgba(232,163,61,0.08)');
    g.addColorStop(1, 'rgba(0,0,0,0)');
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, VW, VH);
    spaced(ctx, 'ATBOLO', VW / 2, Y.cardMain, `${CARD_MAIN_PX}px "Kenney Future"`, 0.08, '#e8a33d');
    spaced(ctx, 'THE FOREVER WAR', VW / 2, Y.cardSub, '50px "Kenney Future Narrow"', 0.18, '#e8e6df');
    ctx.font = '40px "Kenney Future Narrow"';
    ctx.fillStyle = '#9aa3ad';
    ctx.fillText('one island. two factions. no respite.', VW / 2, Y.cardTag);
    ctx.font = '64px "Kenney Future Narrow"';
    ctx.fillStyle = '#e8e6df';
    ctx.fillText('atbolo.aparker.io', VW / 2, Y.cardUrl);
    ctx.font = '38px "Kenney Future Narrow"';
    ctx.fillStyle = '#7fc46a';
    ctx.fillText('enlist with your bluesky handle', VW / 2, Y.cardEnlist);
    ctx.font = '32px "Kenney Future Narrow"';
    ctx.fillStyle = '#5d646b';
    ctx.fillText('free · in your browser · phone too', VW / 2, Y.cardFree);
    ctx.restore();
  }
}

// --- render loop -----------------------------------------------------------
mkdirSync(`${OUT}/frames`, { recursive: true });
const canvas = createCanvas(VW, VH) as unknown as HTMLCanvasElement;
const renderer = new Renderer(canvas);
const ctx = (canvas as any).getContext('2d');

// warm the sim for a second so tracks/builders look lived-in
for (let i = 0; i < 10; i++) {
  scriptedActions(0);
  for (const t of world.tanks.values()) if (t.npc) world.setInput(t.id, npcThink(world, t));
  syncTick(C, C);
  simTime += 100;
}

const FRAMES = DUR * FPS;
for (let f = 0; f < FRAMES; f++) {
  const t = f / FPS;
  const rt = T0 + 1000 + t * 1000; // +1s warmup offset
  while (simTime <= rt) {
    scriptedActions(t);
    for (const tk of world.tanks.values()) {
      if (tk.npc && !(tk.id === runner.id && t >= 17.5)) world.setInput(tk.id, npcThink(world, tk));
    }
    const cam = direct(t);
    syncTick(cam.follow ? hero.x : cam.x, cam.follow ? hero.y : cam.y);
    simTime += 100;
  }

  const cam = direct(t);
  state.you = cam.follow
    ? { did: 'did:promo:hero', handle: 'you.bsky.social', faction: 'dawn', tankId: hero.id }
    : null;
  renderer.scale = cam.scale;
  if (!cam.follow) {
    renderer.camX = cam.x;
    renderer.camY = cam.y;
  }
  renderer.frame(state, rt);
  overlays(ctx, t);

  writeFileSync(`${OUT}/frames/f${String(f).padStart(5, '0')}.png`, (canvas as any).toBuffer('image/png'));
  if (f % 60 === 0) console.log(`frame ${f}/${FRAMES} (t=${t.toFixed(1)}s)`);
}

writeFileSync(`${OUT}/events.json`, JSON.stringify(sfx, null, 1));
console.log(`wrote ${FRAMES} frames + ${sfx.length} sfx events to ${OUT}`);
