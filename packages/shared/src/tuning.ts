/**
 * Tank-handling parameters as a group (the sim reads them via World.tuning).
 * Defaults come straight from constants.ts; the /rig dev comparison tool
 * overrides them per-pane to feel out handling variants. Production never
 * mutates them.
 */
import {
  SHELL_SPEED,
  TANK_ACCEL,
  TANK_ACCEL_CURVE,
  TANK_BRAKE,
  TANK_FIRE_COOLDOWN,
  TANK_MAX_SPEED,
  TANK_REVERSE_FACTOR,
  TANK_TURN_ACCEL,
  TANK_TURN_RATE,
} from './constants';

export interface TankTuning {
  /** tiles/sec at 100% terrain speed (road) */
  maxSpeed: number;
  /** tiles/sec^2, at standstill */
  accel: number;
  /** 0..~0.9: tapers accel toward top speed (0 = linear ramp) */
  accelCurve: number;
  /** tiles/sec^2 when input opposes current motion */
  brake: number;
  /** radians/sec at full ramp */
  turnRate: number;
  /** radians/sec^2 ramp toward turnRate */
  turnAccel: number;
  /** reverse speed as a fraction of forward */
  reverseFactor: number;
  /** seconds between shots */
  fireCooldown: number;
  /** tiles/sec */
  shellSpeed: number;
}

export const DEFAULT_TANK_TUNING: TankTuning = {
  maxSpeed: TANK_MAX_SPEED,
  accel: TANK_ACCEL,
  accelCurve: TANK_ACCEL_CURVE,
  brake: TANK_BRAKE,
  turnRate: TANK_TURN_RATE,
  turnAccel: TANK_TURN_ACCEL,
  reverseFactor: TANK_REVERSE_FACTOR,
  fireCooldown: TANK_FIRE_COOLDOWN,
  shellSpeed: SHELL_SPEED,
};

/** Slider metadata for the dev tuning panel. */
export const TANK_TUNING_SPEC: Record<keyof TankTuning, { label: string; min: number; max: number; step: number }> = {
  maxSpeed: { label: 'max speed (tiles/s)', min: 1, max: 10, step: 0.1 },
  accel: { label: 'accel (tiles/s²)', min: 1, max: 20, step: 0.5 },
  accelCurve: { label: 'accel curve', min: 0, max: 0.9, step: 0.05 },
  brake: { label: 'brake (tiles/s²)', min: 1, max: 30, step: 0.5 },
  turnRate: { label: 'turn rate (rad/s)', min: 0.5, max: 8, step: 0.1 },
  turnAccel: { label: 'turn accel (rad/s²)', min: 1, max: 40, step: 1 },
  reverseFactor: { label: 'reverse factor', min: 0.1, max: 1, step: 0.05 },
  fireCooldown: { label: 'fire cooldown (s)', min: 0.1, max: 2, step: 0.05 },
  shellSpeed: { label: 'shell speed (tiles/s)', min: 3, max: 20, step: 0.5 },
};
