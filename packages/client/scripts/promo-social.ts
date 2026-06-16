/**
 * Social-update promo: runs the REAL server sim through the REAL client
 * renderer and writes a 28s vertical (1080x1920 @30fps) frame sequence
 * plus an sfx event timeline. Assemble with scripts/promo-social.sh.
 *
 *   npx tsx scripts/promo-social.ts
 *
 * Beats (each a clean, controlled vignette):
 *   A: title reveal
 *   B: MUTUALS — 3v2 formation advance, green dots on friend tanks
 *   C: BOUNTY — enemy emerges from forest with gold coin, hero engages
 *   D: NEMESIS — clean 1v1 duel in open field
 *   E: BASE CAPTURE — hero takes a base, kill feed shows social events
 *   F: end card
 */
import { GlobalFonts, createCanvas, loadImage } from '@napi-rs/canvas';
import { mkdirSync, writeFileSync } from 'node:fs';
import { MAP_SIZE, Terrain } from '@bolo/shared';

// --- output geometry ---
const SQUARE = process.argv.includes('square');
const VW = 1080;
const VH = SQUARE ? 1080 : 1920;
const FPS = 30;
const DUR = 28;
const OUT = SQUARE ? '/tmp/atbolo-promo-social-sq' : '/tmp/atbolo-promo-social';

const Y = SQUARE
  ? { stamp: 240, titleMain: 310, titleSub: 416, titleTag: 472, feature: 500,
      cardMain: 430, cardSub: 540, cardTag: 610, cardUrl: 720, cardEnlist: 788, cardFree: 846 }
  : { stamp: 380, titleMain: 520, titleSub: 660, titleTag: 730, feature: 780,
      cardMain: 740, cardSub: 860, cardTag: 970, cardUrl: 1110, cardEnlist: 1190, cardFree: 1270 };
const CARD_MAIN_PX = SQUARE ? 130 : 160;

// --- DOM shims ---
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

// --- world + terrain -----------------------------------------------------
const world = new World(7, 7777); // different seed from the original promo
const C = 128;

const setT = (x: number, y: number, t: Terrain) => {
  world.terrain[y * MAP_SIZE + x] = t;
};
// Clear a generous stage around center — all grass
for (let y = C - 28; y < C + 28; y++) {
  for (let x = C - 24; x < C + 26; x++) setT(x, y, Terrain.Grass);
}
// Road spine running north-south
for (let y = C - 28; y < C + 28; y++) setT(C, y, Terrain.Road);

// Forest clumps — one big one for the BOUNTY ambush beat (east side)
const clump = (cx: number, cy: number, r: number) => {
  for (let y = cy - r; y <= cy + r; y++)
    for (let x = cx - r; x <= cx + r; x++)
      if ((x - cx) ** 2 + (y - cy) ** 2 <= r * r) setT(x, y, Terrain.Forest);
};
clump(C + 10, C - 8, 4);   // east forest — bounty ambush
clump(C - 12, C + 2, 3);   // west forest — scenery
clump(C + 8, C + 14, 2);   // near base

// A few craters for atmosphere
for (const [sx, sy] of [[C-3,C-4],[C+4,C-10],[C-6,C+8]] as [number,number][]) {
  setT(sx, sy, Terrain.Crater);
}
// Rubble near the base (evidence of prior fighting)
setT(C+1, C+13, Terrain.Rubble);
setT(C-2, C+11, Terrain.Rubble);

// Clear pills from the stage area
world.pills = world.pills.filter(
  (p) => Math.abs(p.x - C) > 20 || Math.abs(p.y - C) > 28,
);

// Neutral base for the capture beat — south on the road
const prize = world.bases[0];
prize.owner = 'neutral';
prize.x = C;
prize.y = C + 14;
prize.armorStock = 0;
prize.shellStock = 20;
for (const b of world.bases.slice(1)) {
  if (Math.abs(b.x - C) < 22 && Math.abs(b.y - C) < 30) b.x = 40;
}
for (let y = prize.y - 2; y <= prize.y + 2; y++)
  for (let x = prize.x - 2; x <= prize.x + 2; x++) setT(x, y, Terrain.Grass);
setT(prize.x, prize.y, Terrain.Road);
setT(prize.x, prize.y - 1, Terrain.Road);

// --- the cast ---
const hero   = world.addTank('did:plc:hero0000000000001', 'you.bsky.social',     'dawn', false, 'keyboard');
const buddyA = world.addTank('did:plc:buddy0000000000a', 'shield.bsky.social',   'dawn', true);
const buddyB = world.addTank('did:plc:buddy0000000000b', 'rex.bsky.social',      'dawn', true);
const foeA   = world.addTank('did:plc:foe000000000000a', 'reaper.bsky.social',   'dusk', true);  // nemesis + bounty target
const foeB   = world.addTank('did:plc:foe000000000000b', 'crow.bsky.social',     'dusk', true);

// Social flags
const MUTUAL_TANK_IDS = new Set([buddyA.id, buddyB.id]);
let BOUNTY_TANK_IDS = new Set<number>([foeA.id]);

const place = (t: any, x: number, y: number, dir: number, armor = 40) => {
  t.x = x; t.y = y; t.dir = dir; t.speed = 0; t.armor = armor; t.shells = 40;
};

// --- client state + sync ------------------------------------------------
const state = new GameState();
state.terrain = new Uint8Array(world.terrain);
state.bases = world.bases as any;
state.pills = world.pills as any;
state.war = {
  warNumber: 7, seed: 7777, startedAt: 0, phase: 'active',
  nextWarAt: null, baseCounts: { dawn: 6, dusk: 7, neutral: 1 },
};

state.mutuals = new Set(['did:plc:buddy0000000000a', 'did:plc:buddy0000000000b']);
state.socialProfiles = {
  'did:plc:hero0000000000001': { handle: 'you.bsky.social' },
  'did:plc:buddy0000000000a':  { handle: 'shield.bsky.social' },
  'did:plc:buddy0000000000b':  { handle: 'rex.bsky.social' },
  'did:plc:foe000000000000a':  { handle: 'reaper.bsky.social' },
  'did:plc:foe000000000000b':  { handle: 'crow.bsky.social' },
};
state.nemesis = { did: 'did:plc:foe000000000000a', handle: 'reaper', killedBy: 3, youKilled: 1, online: true };
state.bounties = [{ targetDid: 'did:plc:foe000000000000a', targetHandle: 'reaper', reward: 2, victimHandle: 'shield' }];

// --- fake profiles for kill feed avatars ---
interface FakeProfile { handle: string; faction: 'dawn' | 'dusk'; color: string; initial: string; }
const PROFILES: Record<string, FakeProfile> = {
  shield: { handle: 'shield.bsky.social', faction: 'dawn', color: '#5a9e5f', initial: 'S' },
  rex:    { handle: 'rex.bsky.social',    faction: 'dawn', color: '#3b8db8', initial: 'R' },
  reaper: { handle: 'reaper.bsky.social', faction: 'dusk', color: '#c4533a', initial: 'R' },
  crow:   { handle: 'crow.bsky.social',   faction: 'dusk', color: '#7d4ab8', initial: 'C' },
  you:    { handle: 'you.bsky.social',    faction: 'dawn', color: '#e8a33d', initial: 'Y' },
};

interface FeedEntry { t: number; text: string; handle?: string; mutual?: boolean; icon?: string; }
const FEED: FeedEntry[] = [
  { t: 19.8, text: 'your mutual @shield destroyed @crow',     handle: 'shield', mutual: true, icon: '⚠' },
  { t: 20.7, text: 'REVENGE! you struck back at @reaper',     handle: 'you',    icon: '★' },
  { t: 21.6, text: 'bounty claimed! @reaper +2 credits',     handle: 'reaper', icon: '💰' },
  { t: 22.4, text: 'your mutual @rex captured a base',       handle: 'rex',    mutual: true, icon: '🏠' },
];

// --- sim + sync ----------------------------------------------------------
interface SfxEvent { t: number; kind: 'fire' | 'boom' | 'bigboom' | 'capture'; }
const sfx: SfxEvent[] = [];
const seenShells = new Set<number>();
let captureAt = -1;

const T0 = 200_000;
let simTime = T0;
const vt = (sim: number) => (sim - T0) / 1000;

function syncTick(camX: number, camY: number): void {
  hero.armor = Math.max(hero.armor, 25);
  const result = world.doTick(1);

  for (const tank of world.tanks.values()) {
    const view = {
      id: tank.id, handle: '', faction: tank.faction, npc: tank.npc,
      x: tank.x, y: tank.y, dir: tank.dir, speed: tank.speed,
      alive: tank.alive, onBoat: tank.onBoat,
      armor: tank.armor, shells: tank.shells, mines: tank.mines, trees: tank.trees,
      carriedPill: tank.carriedPill, gunRange: tank.gunRange,
      mutual: MUTUAL_TANK_IDS.has(tank.id) || undefined,
      bounty: BOUNTY_TANK_IDS.has(tank.id) || undefined,
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
    if (b.phase !== 'in_tank' && b.phase !== 'dead')
      state.builders.push({ tankId: tank.id, faction: tank.faction, phase: b.phase, x: b.x, y: b.y });
  }
  state.buildersAt = simTime;

  for (const [x, y, t] of result.terrainChanges) {
    state.terrain[y * MAP_SIZE + x] = t;
    state.logTerrainChange(x, y);
  }
  for (const e of result.events) {
    if (e.e === 'boom') {
      state.booms.push({ x: e.x, y: e.y, kind: e.kind, at: simTime });
      if (near(e.x, e.y)) sfx.push({ t: vt(simTime), kind: 'boom' });
    } else if (e.e === 'kill') {
      if (near((e as any).x ?? camX, (e as any).y ?? camY)) sfx.push({ t: vt(simTime), kind: 'bigboom' });
    } else if (e.e === 'base_captured') {
      if (e.handle === hero.handle && vt(simTime) > 19) {
        sfx.push({ t: vt(simTime), kind: 'capture' });
        if (captureAt < 0) captureAt = vt(simTime);
      }
    }
  }
  if (result.basesChanged) state.bases = [...world.bases] as any;
}

/** Hero autopilot: aim at nearest enemy, close distance, fire when aligned. */
function heroInput(): { accel: number; turn: number; fire: boolean } {
  let best: any = null;
  let bestD = 14;
  for (const t of world.tanks.values()) {
    if (!t.alive || t.faction === 'dawn') continue;
    const d = Math.hypot(t.x - hero.x, t.y - hero.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best) return { accel: 0, turn: 0.12, fire: false };
  let delta = Math.atan2(best.y - hero.y, best.x - hero.x) - hero.dir;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return {
    accel: bestD > 4.5 ? 1 : 0,
    turn: Math.max(-1, Math.min(1, delta * 3)),
    fire: Math.abs(delta) < 0.14 && bestD < 9,
  };
}

/** Drive a tank toward a target position (simple seek). */
function seekTo(t: any, tx: number, ty: number): { accel: number; turn: number; fire: boolean } {
  const d = Math.hypot(tx - t.x, ty - t.y);
  if (d < 0.8) return { accel: 0, turn: 0, fire: false };
  let delta = Math.atan2(ty - t.y, tx - t.x) - t.dir;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return { accel: 1, turn: Math.max(-1, Math.min(1, delta * 3)), fire: false };
}

// --- camera ---------------------------------------------------------------
const ease = (x: number) => 1 - (1 - x) ** 3;
const clamp01 = (x: number) => Math.max(0, Math.min(1, x));
interface Cam { x: number; y: number; scale: number; follow: boolean; }

// Beat boundaries: A 0-3.5, B 3.5-9, C 9-14.5, D 14.5-19.5, E 19.5-24, F 24-28
// follow=true means "camera tracks hero world position" — we set camX/camY
// from hero.x/hero.y each frame, bypassing the client prediction system
// (which is never seeded correctly in a headless render).
function direct(t: number): Cam {
  if (t < 3.5) {
    const k = ease(t / 3.5);
    return { x: C, y: C - 4, scale: 4.3 + 2.2 * k, follow: false };
  }
  if (t < 9) {
    // B: FRIENDS — follow hero, tight enough for green dots
    return { x: 0, y: 0, scale: 52, follow: true };
  }
  if (t < 14.5) {
    // C: BOUNTY — follow hero through forest approach
    return { x: 0, y: 0, scale: 52, follow: true };
  }
  if (t < 19.5) {
    // D: NEMESIS — follow hero for the duel (camera moves with the action)
    return { x: 0, y: 0, scale: 50, follow: true };
  }
  if (t < 24) {
    // E: BASE CAPTURE — follow hero driving south to the base
    return { x: 0, y: 0, scale: 40, follow: true };
  }
  return { x: C, y: C, scale: 6, follow: false };
}

// --- scripted actions: full manual control, no NPC AI -------------------
let beatBDone = false, beatCDone = false, beatDDone = false, beatEDone = false;
let deathMarkerData: { x: number; y: number; at: number; victim: string; killer: string }[] = [];

/** Revive + reposition a tank (works even if dead from a prior beat). */
const revive = (t: any, x: number, y: number, dir: number, armor = 40) => {
  if (!t.alive) { t.alive = true; t.respawnTick = 0; }
  t.x = x; t.y = y; t.dir = dir; t.speed = 0; t.armor = armor; t.shells = 40;
  state.tanks.delete(t.id);
};

/** Aim at a specific target tank and fire when aligned. Advances if far. */
function aimFire(tank: any, target: any, maxRange = 6): { accel: number; turn: number; fire: boolean } {
  if (!target?.alive) return { accel: 0, turn: 0.1, fire: false };
  const d = Math.hypot(target.x - tank.x, target.y - tank.y);
  let delta = Math.atan2(target.y - tank.y, target.x - tank.x) - tank.dir;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return {
    accel: d > maxRange ? 0.7 : 0,
    turn: Math.max(-1, Math.min(1, delta * 3)),
    fire: Math.abs(delta) < 0.14 && d < 9,
  };
}

/** Hold position, find nearest enemy, and fire. */
function holdFire(tank: any): { accel: number; turn: number; fire: boolean } {
  let best: any = null, bestD = 12;
  for (const t of world.tanks.values()) {
    if (!t.alive || t.faction === tank.faction) continue;
    const d = Math.hypot(t.x - tank.x, t.y - tank.y);
    if (d < bestD) { bestD = d; best = t; }
  }
  if (!best) return { accel: 0, turn: 0, fire: false };
  let delta = Math.atan2(best.y - tank.y, best.x - tank.x) - tank.dir;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;
  return { accel: 0, turn: Math.max(-1, Math.min(1, delta * 2.5)), fire: Math.abs(delta) < 0.14 && bestD < 10 };
}

function scriptedActions(t: number): void {
  if (t < 3.5) return; // warmup: idle

  // === B: FRIENDS — 3v2 formation advance (3.5–9s) ====================
  if (t < 9) {
    if (!beatBDone) {
      beatBDone = true;
      revive(hero,   C - 4, C - 6, 0);
      revive(buddyA, C - 5, C - 4, 0.1);
      revive(buddyB, C - 5, C - 8, -0.1);
      revive(foeA,   C + 4, C - 5, Math.PI, 25);
      revive(foeB,   C + 4, C - 8, Math.PI, 10); // low armor — dies first
    }
    // Hero advances east toward enemies
    world.setInput(hero.id, aimFire(hero, foeB.alive ? foeB : foeA, 6));
    // Mutuals hold formation and fire at nearest enemy
    world.setInput(buddyA.id, holdFire(buddyA));
    world.setInput(buddyB.id, holdFire(buddyB));
    // Enemies hold position and fire back
    world.setInput(foeA.id, holdFire(foeA));
    world.setInput(foeB.id, holdFire(foeB));
    return;
  }

  // === C: BOUNTY — engage bounty target near forest (9–14.5s) =========
  if (t < 14.5) {
    if (!beatCDone) {
      beatCDone = true;
      BOUNTY_TANK_IDS = new Set([foeA.id]);
      revive(hero,   C - 5, C - 8, 0);
      revive(buddyA, C - 7, C - 6, 0.3);
      revive(foeA,   C + 5, C - 8, Math.PI, 15); // bounty target, will die
      foeB.alive = false;
      buddyB.alive = false;
      for (const id of [hero.id, buddyA.id, foeA.id, foeB.id, buddyB.id]) state.tanks.delete(id);
    }
    // Hero advances and engages the bounty target
    world.setInput(hero.id, aimFire(hero, foeA, 5));
    world.setInput(buddyA.id, holdFire(buddyA));
    if (foeA.alive) world.setInput(foeA.id, aimFire(foeA, hero, 4));
    // When bounty target dies, clear the bounty marker
    if (!foeA.alive && BOUNTY_TANK_IDS.size > 0) BOUNTY_TANK_IDS = new Set();
    return;
  }

  // === D: NEMESIS — clean 1v1 duel (14.5–19.5s) ======================
  if (t < 19.5) {
    if (!beatDDone) {
      beatDDone = true;
      BOUNTY_TANK_IDS = new Set();
      revive(hero, C - 5, C - 4, 0, 40);
      revive(foeA, C + 5, C - 4, Math.PI, 15); // nemesis — dies in the duel
      buddyA.alive = false;
      buddyB.alive = false;
      foeB.alive = false;
      state.tanks.clear();
    }
    // Both advance toward each other and fire
    world.setInput(hero.id, aimFire(hero, foeA, 4));
    if (foeA.alive) world.setInput(foeA.id, aimFire(foeA, hero, 4));
    return;
  }

  // === E: CONQUER — drive to base + capture (19.5–24s) ================
  if (t < 24) {
    if (!beatEDone) {
      beatEDone = true;
      // Death marker from the nemesis kill
      deathMarkerData = [
        { x: C + 3, y: C - 4, at: T0 + (t - 1.5) * 1000, victim: 'reaper', killer: 'you' },
      ];
      revive(hero, C, C + 4, Math.PI / 2, 40);
      foeA.alive = false;
      state.tanks.delete(hero.id);
    }
    // Drive hero south to the base
    world.setInput(hero.id, seekTo(hero, prize.x, prize.y));
    return;
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

function stamp(ctx: any, text: string, t: number, start: number, hold = 1.6, color = '#e8e6df'): void {
  const a = t - start;
  if (a < 0 || a > hold + 0.4) return;
  const popIn = clamp01(a / 0.18);
  const fade = a > hold ? 1 - (a - hold) / 0.4 : 1;
  const size = 140 * (1.35 - 0.35 * ease(popIn));
  ctx.save();
  ctx.globalAlpha = popIn * fade;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${size}px "Kenney Future"`;
  ctx.fillStyle = 'rgba(0,0,0,0.65)';
  ctx.fillText(text, VW / 2 + 6, Y.stamp + 6);
  ctx.fillStyle = color;
  ctx.fillText(text, VW / 2, Y.stamp);
  ctx.restore();
}

function featureLine(ctx: any, text: string, t: number, start: number, hold = 1.6, color = '#9aa3ad'): void {
  const a = t - start;
  if (a < 0 || a > hold + 0.4) return;
  const popIn = clamp01(a / 0.3);
  const fade = a > hold ? 1 - (a - hold) / 0.4 : 1;
  const fontPx = SQUARE ? 28 : 38;
  ctx.save();
  ctx.globalAlpha = popIn * fade;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.font = `${fontPx}px "Kenney Future Narrow"`;
  const maxW = VW - (SQUARE ? 80 : 120);
  const words = text.split(' ');
  const lines: string[] = [];
  let line = '';
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxW && line) { lines.push(line); line = w; }
    else line = test;
  }
  if (line) lines.push(line);
  const lh = fontPx * 1.3;
  const startY = Y.feature - ((lines.length - 1) * lh) / 2;
  for (let i = 0; i < lines.length; i++) {
    ctx.fillStyle = 'rgba(0,0,0,0.6)';
    ctx.fillText(lines[i], VW / 2 + 3, startY + i * lh + 3);
    ctx.fillStyle = color;
    ctx.fillText(lines[i], VW / 2, startY + i * lh);
  }
  ctx.restore();
}

function roundRect(ctx: any, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.lineTo(x + w - r, y);
  ctx.quadraticCurveTo(x + w, y, x + w, y + r);
  ctx.lineTo(x + w, y + h - r);
  ctx.quadraticCurveTo(x + w, y + h, x + w - r, y + h);
  ctx.lineTo(x + r, y + h);
  ctx.quadraticCurveTo(x, y + h, x, y + h - r);
  ctx.lineTo(x, y + r);
  ctx.quadraticCurveTo(x, y, x + r, y);
  ctx.closePath();
}

function socialBadge(ctx: any, t: number, start: number, text: string, color: string, hold = 2.0): void {
  const a = t - start;
  if (a < 0 || a > hold + 0.5) return;
  const slideIn = clamp01(a / 0.3);
  const fade = a > hold ? 1 - (a - hold) / 0.5 : 1;
  const alpha = slideIn * fade;
  const yOff = (1 - ease(slideIn)) * -60;
  ctx.save();
  ctx.globalAlpha = alpha;
  const x = VW / 2;
  const y = (SQUARE ? 80 : 120) + yOff;
  const fontPx = SQUARE ? 32 : 42;
  ctx.font = `${fontPx}px "Kenney Future Narrow"`;
  const tw = ctx.measureText(text).width;
  const padX = SQUARE ? 22 : 32;
  const maxBW = VW - 40;
  const bw = Math.min(tw + padX * 2 + 44, maxBW);
  const bh = SQUARE ? 56 : 66;
  ctx.fillStyle = 'rgba(7,8,12,0.88)';
  roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, 14);
  ctx.fill();
  ctx.strokeStyle = color;
  ctx.lineWidth = 2.5;
  roundRect(ctx, x - bw / 2, y - bh / 2, bw, bh, 14);
  ctx.stroke();
  ctx.fillStyle = color;
  ctx.beginPath();
  ctx.arc(x - bw / 2 + padX + 6, y, 8, 0, Math.PI * 2);
  ctx.fill();
  const availW = bw - padX * 2 - 34;
  let textFontPx = fontPx;
  if (tw > availW) textFontPx = Math.max(16, fontPx * (availW / tw));
  ctx.font = `${textFontPx}px "Kenney Future Narrow"`;
  ctx.fillStyle = '#e8e6df';
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(text, x + 18, y);
  ctx.restore();
}

/** Draw a fake Bsky avatar: gradient circle with initials */
function drawAvatar(ctx: any, x: number, y: number, size: number, p: FakeProfile): void {
  const r = size / 2;
  ctx.save();
  ctx.beginPath();
  ctx.arc(x, y, r, 0, Math.PI * 2);
  const g = ctx.createRadialGradient(x - r * 0.3, y - r * 0.3, r * 0.1, x, y, r);
  g.addColorStop(0, p.color);
  g.addColorStop(1, p.faction === 'dawn' ? '#3a2a10' : '#1a1030');
  ctx.fillStyle = g;
  ctx.fill();
  // faction-colored ring
  ctx.strokeStyle = p.faction === 'dawn' ? '#e8a33d' : '#b69cff';
  ctx.lineWidth = 2;
  ctx.stroke();
  // bold initial
  ctx.fillStyle = '#fff';
  ctx.font = `bold ${Math.round(size * 0.55)}px "Kenney Future Narrow"`;
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';
  ctx.fillText(p.initial, x, y + 1);
  ctx.restore();
}

/** Kill feed panel at bottom of screen */
function killFeed(ctx: any, t: number): void {
  if (t < 19.6 || t > 24) return;
  const fadeIn = clamp01((t - 19.6) / 0.3);
  const fadeOut = t > 23.5 ? 1 - clamp01((t - 23.5) / 0.5) : 1;
  const alpha = fadeIn * fadeOut;
  if (alpha <= 0) return;

  const entries = FEED.filter((e) => t >= e.t);
  if (entries.length === 0) return;

  const avSize = SQUARE ? 38 : 46;
  const fontPx = SQUARE ? 24 : 30;
  const lineH = SQUARE ? 52 : 60;
  const padH = 20;
  const padV = 14;
  const panelW = VW - 2 * (SQUARE ? 50 : 80);
  const panelH = entries.length * lineH + padV * 2;
  const panelX = (VW - panelW) / 2;
  const panelY = VH - panelH - (SQUARE ? 40 : 100);

  ctx.save();
  ctx.globalAlpha = alpha;
  ctx.fillStyle = 'rgba(7,8,12,0.85)';
  roundRect(ctx, panelX, panelY, panelW, panelH, 12);
  ctx.fill();
  ctx.strokeStyle = 'rgba(255,255,255,0.08)';
  ctx.lineWidth = 1;
  roundRect(ctx, panelX, panelY, panelW, panelH, 12);
  ctx.stroke();

  ctx.font = `${fontPx}px "Kenney Future Narrow"`;
  ctx.textBaseline = 'middle';

  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    const age = t - e.t;
    const slideIn = clamp01(age / 0.25);
    const xOff = (1 - ease(slideIn)) * -30;
    const ly = panelY + padV + i * lineH + lineH / 2;
    const lx = panelX + padH + avSize / 2 + xOff;

    if (e.mutual) {
      ctx.fillStyle = 'rgba(100,200,100,0.12)';
      ctx.fillRect(panelX + 2, panelY + padV + i * lineH, panelW - 4, lineH);
      ctx.fillStyle = '#6c8';
      ctx.fillRect(panelX + 2, panelY + padV + i * lineH, 3, lineH);
    }

    if (e.handle && PROFILES[e.handle]) drawAvatar(ctx, lx, ly, avSize, PROFILES[e.handle]);

    const textX = lx + avSize / 2 + 10;
    ctx.textAlign = 'left';
    if (e.icon) {
      ctx.font = `${fontPx}px sans-serif`;
      ctx.fillStyle = e.mutual ? '#e85d5d' : e.icon === '★' ? '#e8a33d' : e.icon === '💰' ? '#e8c75d' : '#9aa3ad';
      ctx.fillText(e.icon, textX, ly);
    }
    ctx.font = `${fontPx}px "Kenney Future Narrow"`;
    ctx.fillStyle = '#d0d4d8';
    let text = e.text;
    const maxW = panelX + panelW - textX - 20 - fontPx;
    while (ctx.measureText(text).width > maxW && text.length > 3) text = text.slice(0, -2) + '…';
    ctx.fillText(text, textX + fontPx + 6, ly);
  }
  ctx.restore();
}

/** Custom tank labels drawn on top of the renderer's output.
 *  Shows short handles, mini avatars for mutuals, gold coins for bounty targets. */
function tankOverlays(ctx: any, t: number, cam: Cam, now: number): void {
  if (t < 3.5 || t >= 24) return; // only during gameplay beats

  const labelFont = Math.round(Math.max(16, Math.min(26, cam.scale * 0.42)));
  const avSize = Math.round(Math.max(16, Math.min(28, cam.scale * 0.38)));
  const TANK_R = 1.5; // approximate tank radius in tiles
  // use the renderer's actual camera position (cam.x is 0 in follow mode)
  const camX = renderer.camX;
  const camY = renderer.camY;

  for (const tank of world.tanks.values()) {
    if (!tank.alive) continue;

    // interpolated position for smooth labels
    const it = state.tanks.get(tank.id);
    let wx = tank.x, wy = tank.y;
    if (it && it.snaps.length >= 2) {
      const p = state.lerpTank(it, now);
      wx = p.x; wy = p.y;
    }

    // world-to-screen using renderer's actual camera position
    const px = VW / 2 + (wx - camX) * cam.scale;
    const py = VH / 2 + (wy - camY) * cam.scale;
    // skip off-screen
    if (px < -100 || px > VW + 100 || py < -50 || py > VH + 50) continue;

    const labelY = py - TANK_R * cam.scale - labelFont * 0.7;
    const isHero = tank.id === hero.id;
    const isMutual = MUTUAL_TANK_IDS.has(tank.id);
    const isBounty = BOUNTY_TANK_IDS.has(tank.id);

    // short handle
    let name = tank.handle;
    if (name.includes('.bsky.social')) name = name.split('.')[0];
    else if (name.startsWith('[')) name = name.replace(/^\[[^\]]*\]\s*/, '').replace(/-\d+$/, '');
    const text = isHero ? 'YOU' : name;
    const avKey = isHero ? 'you' : name;

    // measure label first to know layout
    ctx.font = `${labelFont}px "Kenney Future Narrow"`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    const tw = ctx.measureText(text).width;
    const pillW = tw + 24;
    const pillH = labelFont + 10;
    const pillX = px - pillW / 2;
    const pillY = labelY - pillH / 2;
    const avR = pillH / 2 + 1; // avatar radius matches pill height

    // --- label pill background (drawn FIRST, avatars go on top) ---
    ctx.fillStyle = isMutual ? 'rgba(20,50,20,0.88)' : 'rgba(7,8,12,0.85)';
    roundRect(ctx, pillX, pillY, pillW, pillH, 8);
    ctx.fill();
    // mutual green left bar
    if (isMutual) {
      ctx.fillStyle = '#6c8';
      ctx.fillRect(pillX, pillY, 3, pillH);
    }
    // text
    const factionColor = tank.faction === 'dawn' ? '#ffc97d' : '#b69cff';
    ctx.fillStyle = isHero ? '#ffffff' : factionColor;
    ctx.fillText(text, px + 2, labelY);

    // --- avatar circle (drawn AFTER pill, positioned at left edge) ---
    if ((isMutual || isHero) && PROFILES[avKey]) {
      drawAvatar(ctx, pillX - avR + 4, labelY, avR * 2, PROFILES[avKey]);
    }

    // --- bounty gold coin (drawn AFTER pill, at right edge) ---
    if (isBounty) {
      ctx.save();
      const coinX = pillX + pillW + avR - 2;
      const coinY = labelY;
      ctx.fillStyle = '#e8c75d';
      ctx.beginPath();
      ctx.arc(coinX, coinY, avR, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a06b1c';
      ctx.lineWidth = 2;
      ctx.stroke();
      ctx.fillStyle = '#5a3a0a';
      ctx.font = `bold ${Math.round(avR * 1.1)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', coinX, coinY + 1);
      ctx.restore();
    }
  }
}

/** Large, bold death markers drawn in-world */
function deathMarkerOverlays(ctx: any, t: number, cam: Cam): void {
  if (t < 19.5 || t > 24) return;
  const now = T0 + 1000 + t * 1000;
  const camX = renderer.camX;
  const camY = renderer.camY;
  for (const d of deathMarkerData) {
    const age = now - d.at;
    if (age < 0 || age > 30000) continue;
    const fade = age > 25000 ? (30000 - age) / 5000 : age < 400 ? age / 400 : 1;
    const px = VW / 2 + (d.x - camX) * cam.scale;
    const py = VH / 2 + (d.y - camY) * cam.scale;
    if (px < -60 || px > VW + 60 || py < -60 || py > VH + 60) continue;

    ctx.save();
    ctx.globalAlpha = fade * 0.92;
    // Pulsing glow ring
    const pulse = 1 + Math.sin(now / 300) * 0.08;
    const ringR = cam.scale * 0.7 * pulse;
    ctx.strokeStyle = '#e85d5d';
    ctx.lineWidth = 3.5;
    ctx.beginPath();
    ctx.arc(px, py, ringR, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = 'rgba(232,93,93,0.06)';
    ctx.fill();
    // Inner cross-hair ring
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.arc(px, py, ringR * 0.65, 0, Math.PI * 2);
    ctx.stroke();
    // Skull — large, bold
    ctx.font = `${Math.round(ringR * 1.1)}px sans-serif`;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillStyle = '#e85d5d';
    ctx.fillText('☠', px, py + 2);
    // Label with background
    const labelFont = Math.max(13, Math.round(cam.scale * 0.26));
    ctx.font = `${labelFont}px monospace`;
    const label = `@${d.victim}`;
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(7,8,12,0.85)';
    roundRect(ctx, px - tw / 2 - 6, py + ringR + 6, tw + 12, labelFont + 8, 4);
    ctx.fill();
    ctx.fillStyle = '#e85d5d';
    ctx.fillText(label, px, py + ringR + 6 + labelFont / 2 + 4);
    ctx.restore();
  }
}

function overlays(ctx: any, t: number): void {
  ctx.textAlign = 'center';
  ctx.textBaseline = 'middle';

  // A: title
  if (t < 4) {
    const inA = clamp01((t - 0.5) / 0.8);
    const outA = t > 3.2 ? 1 - clamp01((t - 3.2) / 0.6) : 1;
    const titlePx = SQUARE ? 130 : 170;
    const subPx = SQUARE ? 40 : 52;
    const tagPx = SQUARE ? 26 : 34;
    ctx.save();
    ctx.globalAlpha = inA * outA;
    spaced(ctx, 'ATBOLO', VW / 2 + 6, Y.titleMain + 6, `${titlePx}px "Kenney Future"`, 0.08, 'rgba(0,0,0,0.55)');
    spaced(ctx, 'ATBOLO', VW / 2, Y.titleMain, `${titlePx}px "Kenney Future"`, 0.08, '#e8a33d');
    spaced(ctx, 'THE SOCIAL UPDATE', VW / 2, Y.titleSub, `${subPx}px "Kenney Future Narrow"`, 0.12, '#e8e6df');
    ctx.globalAlpha = inA * outA * 0.85;
    ctx.font = `${tagPx}px "Kenney Future Narrow"`;
    ctx.fillStyle = '#7fc46a';
    ctx.fillText('fight with your bluesky friends', VW / 2, Y.titleTag);
    ctx.restore();
  }

  // B: MUTUALS
  stamp(ctx, 'FRIENDS', t, 3.8, 1.6, '#7fc46a');
  featureLine(ctx, 'your bluesky mutuals fight by your side', t, 4.2);
  socialBadge(ctx, t, 4.8, '2 mutuals online', '#6c8', 2.0);

  // C: BOUNTY
  stamp(ctx, 'BOUNTY', t, 9.3, 1.6, '#e8c75d');
  featureLine(ctx, 'hunt enemy tank-killers for rewards', t, 9.7);
  socialBadge(ctx, t, 10.3, 'bounty: @reaper +2', '#e8c75d', 2.0);

  // D: NEMESIS
  stamp(ctx, 'NEMESIS', t, 14.7, 1.6, '#e85d5d');
  featureLine(ctx, 'your rival is online — settle the score', t, 15.1, 1.6, '#e85d5d');
  socialBadge(ctx, t, 15.7, 'nemesis: @reaper (3 kills)', '#e85d5d', 2.0);

  // E: BASE CAPTURE + FEED
  stamp(ctx, 'CONQUER', t, 19.7, 1.6, '#e8a33d');
  featureLine(ctx, 'capture bases · avenge your friends', t, 20.1);

  // Capture confirmation
  if (captureAt > 0 && t > captureAt && t < captureAt + 2) {
    const a = clamp01((t - captureAt) / 0.2) * (t > captureAt + 1.5 ? 1 - (t - captureAt - 1.5) / 0.5 : 1);
    ctx.save();
    ctx.globalAlpha = a;
    ctx.font = `${SQUARE ? 40 : 52}px "Kenney Future Narrow"`;
    ctx.fillStyle = '#e8a33d';
    ctx.textAlign = 'center';
    ctx.fillText('+1 BASE — DAWN CONCORD', VW / 2, SQUARE ? 380 : 620);
    ctx.restore();
  }

  // F: end card
  if (t >= 24) {
    const a = clamp01((t - 24) / 0.5);
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
    spaced(ctx, 'THE SOCIAL UPDATE', VW / 2, Y.cardSub, `${SQUARE ? 36 : 48}px "Kenney Future Narrow"`, 0.12, '#e8e6df');
    ctx.font = `${SQUARE ? 28 : 38}px "Kenney Future Narrow"`;
    ctx.fillStyle = '#9aa3ad';
    ctx.fillText('mutuals · bounties · nemeses · revenge', VW / 2, Y.cardTag);
    ctx.font = `${SQUARE ? 46 : 60}px "Kenney Future Narrow"`;
    ctx.fillStyle = '#e8e6df';
    ctx.fillText('atbolo.aparker.io', VW / 2, Y.cardUrl);
    ctx.font = `${SQUARE ? 28 : 36}px "Kenney Future Narrow"`;
    ctx.fillStyle = '#7fc46a';
    ctx.fillText('enlist with your bluesky handle', VW / 2, Y.cardEnlist);
    ctx.font = `${SQUARE ? 24 : 30}px "Kenney Future Narrow"`;
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

// warm the sim
for (let i = 0; i < 10; i++) {
  scriptedActions(0);
  syncTick(C, C);
  simTime += 100;
}

const FRAMES = DUR * FPS;
for (let f = 0; f < FRAMES; f++) {
  const t = f / FPS;
  const rt = T0 + 1000 + t * 1000;
  while (simTime <= rt) {
    scriptedActions(t); // sets ALL tank inputs manually — no NPC AI
    const cam = direct(t);
    syncTick(cam.follow ? hero.x : cam.x, cam.follow ? hero.y : cam.y);
    simTime += 100;
  }

  const cam = direct(t);
  // Always set camera directly from world position. We never set state.you
  // because the renderer's frame() method overrides camX/camY with the
  // client-side prediction when state.you is set — and prediction is never
  // seeded correctly in a headless render. Without state.you, the renderer
  // uses our camera coords, the hero is drawn via interpolation (like all
  // other tanks), and we get a clear view instead of fog-of-war.
  //
  // For follow mode, we interpolate the camera through lerpTank so it moves
  // smoothly at 30fps instead of stuttering at the 10Hz sim tick rate.
  renderer.scale = cam.scale;
  if (cam.follow) {
    const heroIt = state.tanks.get(hero.id);
    if (heroIt && heroIt.snaps.length >= 2) {
      const p = state.lerpTank(heroIt, rt);
      renderer.camX = p.x;
      renderer.camY = p.y;
    } else {
      renderer.camX = hero.x;
      renderer.camY = hero.y;
    }
  } else {
    renderer.camX = cam.x;
    renderer.camY = cam.y;
  }
  state.you = null;
  renderer.frame(state, rt);
  tankOverlays(ctx, t, cam, rt);
  deathMarkerOverlays(ctx, t, cam);
  overlays(ctx, t);
  killFeed(ctx, t);

  writeFileSync(`${OUT}/frames/f${String(f).padStart(5, '0')}.png`, (canvas as any).toBuffer('image/png'));
  if (f % 90 === 0) console.log(`frame ${f}/${FRAMES} (t=${t.toFixed(1)}s)`);
}

writeFileSync(`${OUT}/events.json`, JSON.stringify(sfx, null, 1));
console.log(`wrote ${FRAMES} frames + ${sfx.length} sfx events to ${OUT}`);
