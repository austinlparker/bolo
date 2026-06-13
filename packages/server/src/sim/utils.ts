/** Shared helpers extracted from the World class. */
import { Terrain } from '@bolo/shared';

/** Whether a builder can construct on this terrain type. */
export function canBuildOn(t: Terrain): boolean {
  return (
    t === Terrain.Grass ||
    t === Terrain.Swamp ||
    t === Terrain.Crater ||
    t === Terrain.Rubble ||
    t === Terrain.Road ||
    t === Terrain.ShotBuilding
  );
}

export function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

export function round2stat(v: number): number {
  return Math.round(v * 100) / 100;
}

export function clampInt(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}
