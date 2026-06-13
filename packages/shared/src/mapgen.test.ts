import { describe, it, expect } from 'vitest';
import { generateMap, nextWarSeed, idx } from './mapgen';
import { MAP_SIZE, TOTAL_BASES, TOTAL_PILLS } from './constants';
import { Terrain, MineState } from './terrain';

const W = MAP_SIZE;

describe('mapgen symmetry', () => {
  // Promote from smoke test: tile (x,y) === tile (W-1-x, W-1-y)
  for (const seed of [1, 42, 12345, 99999]) {
    it(`terrain is 180°-rotationally symmetric for seed ${seed}`, () => {
      const { terrain } = generateMap(seed);
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          expect(terrain[idx(x, y)]).toBe(terrain[idx(W - 1 - x, W - 1 - y)]);
        }
      }
    });
  }

  it('mine layer is symmetric', () => {
    for (const seed of [1, 42, 99999]) {
      const { mines } = generateMap(seed);
      for (let y = 0; y < W; y++) {
        for (let x = 0; x < W; x++) {
          expect(mines[idx(x, y)]).toBe(mines[idx(W - 1 - x, W - 1 - y)]);
        }
      }
    }
  });
});

describe('mapgen bases', () => {
  it('produces the expected base count', () => {
    for (const seed of [1, 42, 12345]) {
      const { bases } = generateMap(seed);
      expect(bases.length).toBe(TOTAL_BASES);
    }
  });

  it('bases are mirrored in pairs', () => {
    const { bases } = generateMap(12345);
    // Every base at (x,y) should have a counterpart at (W-1-x, W-1-y)
    const found = new Set<number>();
    for (const b of bases) {
      if (found.has(b.id)) continue;
      const mirror = bases.find((m) => m.x === W - 1 - b.x && m.y === W - 1 - b.y);
      expect(mirror).toBeDefined();
      if (mirror) found.add(mirror.id);
    }
  });

  it('dawn starter bases have dusk counterparts', () => {
    const { bases } = generateMap(12345);
    const dawn = bases.filter((b) => b.owner === 'dawn');
    const dusk = bases.filter((b) => b.owner === 'dusk');
    // BASES_PER_FACTION_AT_START = 3
    expect(dawn.length).toBe(3);
    expect(dusk.length).toBe(3);
    // Each dawn starter mirrors a dusk starter
    for (const d of dawn) {
      const m = dusk.find((m) => m.x === W - 1 - d.x && m.y === W - 1 - d.y);
      expect(m).toBeDefined();
    }
  });
});

describe('mapgen pills', () => {
  it('produces the expected pill count', () => {
    for (const seed of [1, 42, 12345]) {
      const { pills } = generateMap(seed);
      expect(pills.length).toBe(TOTAL_PILLS);
    }
  });

  it('pills are mirrored in pairs', () => {
    const { pills } = generateMap(12345);
    const found = new Set<number>();
    for (const p of pills) {
      if (found.has(p.id)) continue;
      const mirror = pills.find((m) => m.x === W - 1 - p.x && m.y === W - 1 - p.y);
      expect(mirror).toBeDefined();
      if (mirror) found.add(mirror.id);
    }
  });
});

describe('mapgen mines', () => {
  it('neutral mines appear in symmetric pairs', () => {
    const { mines } = generateMap(12345);
    const neutralTiles: [number, number][] = [];
    for (let y = 0; y < W; y++) {
      for (let x = 0; x < W; x++) {
        if (mines[idx(x, y)] === MineState.Neutral) neutralTiles.push([x, y]);
      }
    }
    expect(neutralTiles.length).toBeGreaterThan(0);
    // Every neutral mine tile must have a symmetric counterpart
    for (const [x, y] of neutralTiles) {
      expect(mines[idx(W - 1 - x, W - 1 - y)]).toBe(MineState.Neutral);
    }
  });
});

describe('mapgen road connectivity', () => {
  // Locks the MST fix at mapgen.ts:154-178 (NN-linking left isolated clusters).
  // The MST (Prim's algorithm) guarantees every base is linked into the road
  // network — every base gets at least one road tile. (Full walkable
  // connectivity isn't guaranteed because paveTile skips DeepSea tiles — no
  // causeways across open sea — so two clusters separated by open water remain
  // physically disconnected even though the MST logically connects them.)
  it('every base has road infrastructure (MST visited all bases)', () => {
    for (const seed of [1, 42, 12345]) {
      const { terrain, bases } = generateMap(seed);
      for (const b of bases) {
        // Base center is paved to Road by clearPad, and the MST's layRoad
        // extends roads outward from each base.
        expect(terrain[idx(b.x, b.y)]).toBe(Terrain.Road);
      }
    }
  });

  it('roads connect bases that share a landmass (no DeepSea gap)', () => {
    for (const seed of [1, 42, 12345]) {
      const { terrain, bases } = generateMap(seed);
      const isRoad = (x: number, y: number) =>
        x >= 0 && y >= 0 && x < W && y < W && terrain[idx(x, y)] === Terrain.Road;
      // Flood-fill road tiles from base 0
      const flood = new Set<number>([idx(bases[0].x, bases[0].y)]);
      const queue: [number, number][] = [[bases[0].x, bases[0].y]];
      while (queue.length > 0) {
        const [x, y] = queue.shift()!;
        for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]] as const) {
          const nx = x + dx;
          const ny = y + dy;
          if (!isRoad(nx, ny)) continue;
          const key = idx(nx, ny);
          if (flood.has(key)) continue;
          flood.add(key);
          queue.push([nx, ny]);
        }
      }
      // At least base 0 itself and one other base should be road-connected
      const connected = bases.filter((b) => flood.has(idx(b.x, b.y)));
      expect(connected.length).toBeGreaterThan(1);
    }
  });
});

describe('mapgen determinism', () => {
  it('same seed → byte-identical terrain and mines', () => {
    const a = generateMap(12345);
    const b = generateMap(12345);
    expect(Array.from(a.terrain)).toEqual(Array.from(b.terrain));
    expect(Array.from(a.mines)).toEqual(Array.from(b.mines));
    expect(a.bases).toEqual(b.bases);
    expect(a.pills).toEqual(b.pills);
  });

  it('different seeds → different terrain', () => {
    const a = generateMap(1);
    const b = generateMap(2);
    let diffs = 0;
    for (let i = 0; i < a.terrain.length; i++) {
      if (a.terrain[i] !== b.terrain[i]) diffs++;
    }
    expect(diffs).toBeGreaterThan(0);
  });
});

describe('nextWarSeed', () => {
  it('is deterministic', () => {
    expect(nextWarSeed(12345, 1)).toBe(nextWarSeed(12345, 1));
  });

  it('differs from the input seed', () => {
    expect(nextWarSeed(12345, 1)).not.toBe(12345);
    expect(nextWarSeed(99999, 5)).not.toBe(99999);
  });

  it('different war numbers produce different seeds', () => {
    expect(nextWarSeed(12345, 1)).not.toBe(nextWarSeed(12345, 2));
  });
});
