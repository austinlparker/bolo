/** Shared helpers extracted from the World class. */
import {
  ATTRITION_AFTER_MINUTES,
  ATTRITION_FLOOR,
  ATTRITION_RAMP_MINUTES,
  Terrain,
} from '@bolo/shared';

/**
 * Late-war supply decay: 1 until ATTRITION_AFTER_MINUTES, then linear down to
 * ATTRITION_FLOOR over ATTRITION_RAMP_MINUTES. Scales base fortification and
 * restocking so marathon wars can't turtle forever.
 */
export function attritionFactor(warMinutes: number): number {
  if (warMinutes <= ATTRITION_AFTER_MINUTES) return 1;
  const t = Math.min(1, (warMinutes - ATTRITION_AFTER_MINUTES) / ATTRITION_RAMP_MINUTES);
  return 1 - t * (1 - ATTRITION_FLOOR);
}

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
