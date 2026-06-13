/**
 * Test helpers for World simulation tests.
 *
 * These bypass Math.random-dependent spawn selection by setting tank
 * position/heading directly after addTank, and provide a stub for Math.random
 * when mine chain reactions or spawn logic must be exercised.
 */
import { type Faction, MAP_SIZE, SHELL_RANGE } from '@bolo/shared';
import { Terrain, idx } from '@bolo/shared';
import { type TankInput, World } from './world';
import type { Tank } from '@bolo/shared';

const W = MAP_SIZE;

export function makeWorld(seed = 12345): World {
  return new World(1, seed, 1_700_000_000_000);
}

/** Add a tank and teleport it to a controlled position, bypassing placeAtSpawn's Math.random. */
export function addTankAt(
  world: World,
  opts: { did?: string; handle?: string; faction?: Faction; x: number; y: number; dir?: number; npc?: boolean } & Partial<
    Pick<Tank, 'armor' | 'shells' | 'mines' | 'trees' | 'onBoat' | 'gunRange' | 'carriedPill'>
  >,
): Tank {
  const tank = world.addTank(
    opts.did ?? `did:test:${world.tanks.size + 1}`,
    opts.handle ?? `tank${world.tanks.size + 1}`,
    opts.faction ?? 'dawn',
    opts.npc ?? false,
  );
  tank.x = opts.x;
  tank.y = opts.y;
  tank.dir = opts.dir ?? 0;
  tank.speed = 0;
  tank.turnSpeed = 0;
  if (opts.armor !== undefined) tank.armor = opts.armor;
  if (opts.shells !== undefined) tank.shells = opts.shells;
  if (opts.mines !== undefined) tank.mines = opts.mines;
  if (opts.trees !== undefined) tank.trees = opts.trees;
  if (opts.onBoat !== undefined) tank.onBoat = opts.onBoat;
  if (opts.gunRange !== undefined) tank.gunRange = opts.gunRange;
  if (opts.carriedPill !== undefined) tank.carriedPill = opts.carriedPill;
  return tank;
}

/** Set input for a tank and step n ticks with warMinutes=0 (keeps checkVictory inactive). */
export function step(world: World, input: TankInput | null = null, n = 1): void {
  for (let i = 0; i < n; i++) {
    world.doTick(0);
  }
}

/** Step with a specific warMinutes value (for victory tests). */
export function stepWar(world: World, warMinutes: number, n = 1): void {
  for (let i = 0; i < n; i++) {
    world.doTick(warMinutes);
  }
}

/**
 * Replace Math.random with a deterministic sequence. Returns a restore function.
 * Used for tests that must exercise spawn or mine-chain code paths.
 */
export function stubRandom(values: number[]): () => void {
  const original = Math.random;
  let i = 0;
  Math.random = () => {
    const v = values[i % values.length];
    i++;
    return v;
  };
  return () => {
    Math.random = original;
  };
}

/** Set a single tile's terrain directly (the field is public). */
export function setTile(world: World, x: number, y: number, t: Terrain): void {
  world.terrain[idx(x, y)] = t;
}

/** Find a land tile (Grass) in the map for controlled placement. */
export function findGrassTile(world: World, nearX = 128, nearY = 128): { x: number; y: number } {
  for (let r = 0; r < 100; r++) {
    for (let dy = -r; dy <= r; dy++) {
      for (let dx = -r; dx <= r; dx++) {
        const x = nearX + dx;
        const y = nearY + dy;
        if (x < 1 || y < 1 || x >= W - 1 || y >= W - 1) continue;
        if (world.terrain[idx(x, y)] === Terrain.Grass) return { x, y };
      }
    }
  }
  throw new Error('no grass tile found');
}
