/**
 * Procedural island generator. Maps are 180°-rotationally symmetric so
 * neither faction gets a terrain advantage: tile (x, y) always mirrors
 * tile (W-1-x, H-1-y). Dawn starts near the north-west, Dusk near the
 * south-east.
 */
import {
  BASES_PER_FACTION_AT_START,
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_HP,
  BASE_NEUTRAL_START_HP,
  BASE_MAX_MINE_STOCK,
  BASE_MAX_SHELL_STOCK,
  BASE_START_STOCK,
  MAP_SIZE,
  PILL_MAX_HP,
  TOTAL_BASES,
  TOTAL_PILLS,
} from './constants';
import { fbm2, hash32, mulberry32 } from './rng';
import { MineState, Terrain } from './terrain';
import type { Base, Pillbox } from './types';

export interface GeneratedMap {
  size: number;
  terrain: Uint8Array;
  mines: Uint8Array;
  bases: Base[];
  pills: Pillbox[];
}

const W = MAP_SIZE;

export function idx(x: number, y: number): number {
  return y * W + x;
}

function mirror(x: number, y: number): [number, number] {
  return [W - 1 - x, W - 1 - y];
}

export function generateMap(seed: number): GeneratedMap {
  const terrain = new Uint8Array(W * W);
  const mines = new Uint8Array(W * W);
  const rand = mulberry32(hash32(seed, 0xb010));

  const elevSeed = hash32(seed, 1);
  const forestSeed = hash32(seed, 2);
  const riverSeed = hash32(seed, 3);
  const swampSeed = hash32(seed, 4);

  // Symmetric noise: average each field with its own 180°-rotated sample.
  // Symmetric by construction (and bit-exact: addition commutes), and smooth
  // everywhere — naively copying one half onto the other put two uncorrelated
  // noise fields edge to edge and left a visible seam along the equator.
  // Averaging halves the variance, so re-stretch around the mean.
  const sym = (s: number, freq: number, x: number, y: number, octaves: number): number => {
    const a = fbm2(s, (x / W) * freq, (y / W) * freq, octaves);
    const b = fbm2(s, ((W - 1 - x) / W) * freq, ((W - 1 - y) / W) * freq, octaves);
    return 0.5 + ((a + b) / 2 - 0.5) * 1.41;
  };

  // --- per-seed personality: macro knobs sampled once, so successive wars
  // read as different islands rather than re-rolls of the same one ---
  const falloffStart = 0.5 + rand() * 0.12; // how far land reaches toward the rim
  const elevFreq = 5 + rand() * 2.5; // continent blobbiness
  const forestThresh = 0.54 + rand() * 0.08; // lower = denser woods
  const swampThresh = 0.42 + rand() * 0.16;
  const riverFreq = 4 + rand() * 2.5;
  const riverHalfWidth = 0.006 + rand() * 0.014; // ridge-river thickness

  // --- terrain from noise, island falloff towards the edges ---
  const c = (W - 1) / 2;
  for (let y = 0; y < W; y++) {
    for (let x = 0; x < W; x++) {
      const dx = (x - c) / c;
      const dy = (y - c) / c;
      const r = Math.sqrt(dx * dx + dy * dy);
      const falloff = Math.max(0, r - falloffStart) * 1.8;
      const elev = sym(elevSeed, elevFreq, x, y, 5) - falloff;

      let t: Terrain;
      if (elev < 0.30) t = Terrain.DeepSea;
      else if (elev < 0.40) t = Terrain.River; // shallow coastal water (wider band = more crossings)
      else if (elev < 0.42 && sym(swampSeed, 10, x, y, 3) > swampThresh) t = Terrain.Swamp;
      else {
        // winding rivers along noise ridge lines, only on land
        const rn = sym(riverSeed, riverFreq, x, y, 4);
        if (Math.abs(rn - 0.5) < riverHalfWidth) t = Terrain.River;
        else if (sym(forestSeed, 9, x, y, 4) > forestThresh) t = Terrain.Forest;
        else t = Terrain.Grass;
      }
      terrain[idx(x, y)] = t;
    }
  }

  // --- base layout personality: where this war's fighting will live.
  // Weights bias site sampling; symmetry comes from mirroring as usual. ---
  const rNorm = (x: number, y: number) => {
    const dx = (x - c) / c;
    const dy = (y - c) / c;
    return Math.sqrt(dx * dx + dy * dy);
  };
  const layouts: ((x: number, y: number) => number)[] = [
    () => 1, // scatter: bases anywhere, the classic sprawl
    (x, y) => (rNorm(x, y) > 0.45 ? 1 : 0.12), // coastal ring: beach landings
    (x, y) => (rNorm(x, y) < 0.42 ? 1 : 0.15), // heartland: one central melee
    (x, y) => (Math.abs(x - y) < W * 0.2 ? 1 : 0.1), // spine: fight along the diagonal
  ];
  const layoutWeight = layouts[Math.floor(rand() * layouts.length)];

  // --- base sites: pick well-spaced land tiles in the canonical half, mirror them ---
  const pairCount = TOTAL_BASES / 2;
  const baseSites = pickSites(terrain, rand, pairCount, 24, 0.18, 0.5, [], layoutWeight);
  const bases: Base[] = [];
  // The BASES_PER_FACTION_AT_START sites closest to the NW corner start owned by Dawn.
  const ranked = [...baseSites].sort((a, b) => a[0] + a[1] - (b[0] + b[1]));
  const dawnStarters = new Set(ranked.slice(0, BASES_PER_FACTION_AT_START).map(([x, y]) => idx(x, y)));
  let baseId = 0;
  for (const [x, y] of baseSites) {
    const [mx, my] = mirror(x, y);
    const starter = dawnStarters.has(idx(x, y));
    const stock = (max: number) => Math.floor(max * (starter ? 1 : BASE_START_STOCK));
    for (const [bx, by, owner] of [
      [x, y, starter ? 'dawn' : 'neutral'],
      [mx, my, starter ? 'dusk' : 'neutral'],
    ] as const) {
      clearPad(terrain, bx, by);
      bases.push({
        id: baseId++,
        x: bx,
        y: by,
        owner,
        hp: starter ? BASE_MAX_HP : BASE_NEUTRAL_START_HP,
        armorStock: stock(BASE_MAX_ARMOR_STOCK),
        shellStock: stock(BASE_MAX_SHELL_STOCK),
        mineStock: stock(BASE_MAX_MINE_STOCK),
      });
    }
  }

  // --- pillboxes: neutral, scattered on land away from base pads ---
  const pillSites = pickSites(terrain, rand, TOTAL_PILLS / 2, 14, 0.12, 0.5, baseSites);
  const pills: Pillbox[] = [];
  let pillId = 0;
  for (const [x, y] of pillSites) {
    const [mx, my] = mirror(x, y);
    for (const [px, py] of [
      [x, y],
      [mx, my],
    ] as const) {
      terrain[idx(px, py)] = Terrain.Grass;
      pills.push({ id: pillId++, x: px, y: py, owner: 'neutral', hp: PILL_MAX_HP, inTank: false, cooldown: 0 });
    }
  }

  // --- roads: a minimum spanning tree over the bases, so the network is
  // CONNECTED (nearest-neighbour linking left isolated clusters), plus the
  // occasional extra cross-link so some islands get ring roads. Tile
  // symmetry is preserved by paveTile mirroring every tile it lays. ---
  const linked = new Set([bases[0].id]);
  while (linked.size < bases.length) {
    let from: Base | null = null;
    let to: Base | null = null;
    let bestD = Infinity;
    for (const a of bases) {
      if (!linked.has(a.id)) continue;
      for (const b of bases) {
        if (linked.has(b.id)) continue;
        const d = Math.abs(a.x - b.x) + Math.abs(a.y - b.y);
        if (d < bestD) {
          bestD = d;
          from = a;
          to = b;
        }
      }
    }
    if (!from || !to) break;
    linked.add(to.id);
    layRoad(terrain, from.x, from.y, to.x, to.y, rand);
  }
  const extraLoops = Math.floor(rand() * 3); // 0-2 redundant links
  for (let i = 0; i < extraLoops; i++) {
    const a = bases[Math.floor(rand() * bases.length)];
    const b = bases[Math.floor(rand() * bases.length)];
    if (a.id !== b.id) layRoad(terrain, a.x, a.y, b.x, b.y, rand);
  }

  // --- hidden neutral mines in the contested middle of the island ---
  const mineCount = 25 + Math.floor(rand() * 30);
  for (let placed = 0; placed < mineCount; ) {
    const x = 32 + Math.floor(rand() * (W - 64));
    const y = 32 + Math.floor(rand() * (W - 64));
    const t = terrain[idx(x, y)] as Terrain;
    if (t === Terrain.Grass || t === Terrain.Forest || t === Terrain.Swamp) {
      mines[idx(x, y)] = MineState.Neutral;
      const [mx, my] = mirror(x, y);
      mines[idx(mx, my)] = MineState.Neutral;
      placed++;
    }
  }

  return { size: W, terrain, mines, bases, pills };
}

/** Flatten a 3x3 pad of grass with the centre tile kept clear for a base. */
function clearPad(terrain: Uint8Array, cx: number, cy: number): void {
  for (let y = cy - 1; y <= cy + 1; y++) {
    for (let x = cx - 1; x <= cx + 1; x++) {
      if (x < 0 || y < 0 || x >= W || y >= W) continue;
      terrain[idx(x, y)] = Terrain.Grass;
    }
  }
  terrain[idx(cx, cy)] = Terrain.Road;
}

/**
 * Pick `count` mutually-distant land tiles inside the canonical (NW) half.
 * `inner`/`outer` bound the normalized distance from the map border.
 * `weight` (0..1) probabilistically biases where sites land (see the layout
 * personalities in generateMap); if the bias starves the search, it relaxes
 * to uniform rather than under-filling the map.
 */
function pickSites(
  terrain: Uint8Array,
  rand: () => number,
  count: number,
  minSpacing: number,
  inner: number,
  outer: number,
  avoid: [number, number][] = [],
  weight: (x: number, y: number) => number = () => 1,
): [number, number][] {
  const sites: [number, number][] = [];
  const lo = Math.floor(W * inner);
  const hi = Math.floor(W * (1 - inner));
  let attempts = 0;
  while (sites.length < count && attempts < 20000) {
    attempts++;
    const x = lo + Math.floor(rand() * (hi - lo));
    const y = lo + Math.floor(rand() * (hi - lo));
    // canonical half only (strictly above the anti-diagonal mirror line)
    if (y * W + x >= (W * W) / 2) continue;
    if (attempts < 12000 && rand() > weight(x, y)) continue;
    const t = terrain[idx(x, y)] as Terrain;
    if (t !== Terrain.Grass && t !== Terrain.Forest) continue;
    const tooClose = [...sites, ...avoid].some(
      ([sx, sy]) => Math.abs(sx - x) + Math.abs(sy - y) < minSpacing,
    );
    // also keep clear of the mirror images of already-picked sites
    const mirrorClose = sites.some(([sx, sy]) => {
      const [mx, my] = mirror(sx, sy);
      return Math.abs(mx - x) + Math.abs(my - y) < minSpacing;
    });
    if (!tooClose && !mirrorClose) sites.push([x, y]);
  }
  return sites;
}

/**
 * Wandering road: walks toward the target in straight runs of 3-7 tiles,
 * picking each run's axis at random in proportion to the remaining
 * distance. Routes meander with corners instead of tracing one rigid L,
 * but every segment is a straight, drivable stretch (a 1-tile zigzag would
 * bounce the tank's speed-boost tile check every step). Roads laid over
 * river tiles read as bridges, Bolo style.
 */
function layRoad(
  terrain: Uint8Array,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rand: () => number,
): void {
  let x = x0;
  let y = y0;
  paveTile(terrain, x, y);
  let guard = 0;
  while ((x !== x1 || y !== y1) && guard++ < 200) {
    const dx = x1 - x;
    const dy = y1 - y;
    const alongX = dy === 0 || (dx !== 0 && rand() < Math.abs(dx) / (Math.abs(dx) + Math.abs(dy)));
    const remaining = Math.abs(alongX ? dx : dy);
    const run = Math.min(remaining, 3 + Math.floor(rand() * 5));
    for (let i = 0; i < run; i++) {
      if (alongX) x += Math.sign(dx);
      else y += Math.sign(dy);
      paveTile(terrain, x, y);
    }
  }
}

function paveTile(terrain: Uint8Array, x: number, y: number): void {
  if (x < 0 || y < 0 || x >= W || y >= W) return;
  const t = terrain[idx(x, y)] as Terrain;
  if (t === Terrain.DeepSea) return; // no causeways across open sea
  terrain[idx(x, y)] = Terrain.Road;
  // mirror to preserve symmetry
  const [mx, my] = mirror(x, y);
  const mt = terrain[idx(mx, my)] as Terrain;
  if (mt !== Terrain.DeepSea) terrain[idx(mx, my)] = Terrain.Road;
}

/** The next war's seed chains off the previous one, so history shapes geography. */
export function nextWarSeed(prevSeed: number, warNumber: number): number {
  return hash32(prevSeed, warNumber, 0x5eed);
}
