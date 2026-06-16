import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import { DT, TANK_TURN_ACCEL, TANK_TURN_RATE, MAP_SIZE } from '@bolo/shared';
import { Terrain } from '@bolo/shared';
import { addTankAt, makeWorld, setTile, step, stubRandom } from './world.test-utils';

const W = MAP_SIZE;
const PI = Math.PI;

describe('World turn & aim', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  // --- NPC turn model (server-authoritative; unchanged by client-heading refactor) ---

  describe('NPC turn rate ramp', () => {
    it('turn:1 from rest ramps turnSpeed toward TANK_TURN_RATE (not instant)', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      w.setInput(tank.id, { accel: 0, turn: 1, fire: false });
      step(w, null, 1);
      // After 1 tick: turnSpeed = TANK_TURN_ACCEL * DT (ramping up)
      expect(tank.turnSpeed).toBeCloseTo(TANK_TURN_ACCEL * DT, 5);
      expect(tank.turnSpeed).toBeLessThan(TANK_TURN_RATE);
      // After many ticks, reaches full rate
      step(w, null, 40);
      expect(tank.turnSpeed).toBeCloseTo(TANK_TURN_RATE, 2);
    });
  });

  describe('NPC reversal resets ramp', () => {
    it('turn:1 then turn:-1 → turnSpeed jumps to 0 then ramps negative', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      // Ramp up positive
      w.setInput(tank.id, { accel: 0, turn: 1, fire: false });
      step(w, null, 10);
      expect(tank.turnSpeed).toBeGreaterThan(0);
      // Reverse direction
      w.setInput(tank.id, { accel: 0, turn: -1, fire: false });
      step(w, null, 1);
      // targetRate * turnSpeed < 0 → turnSpeed reset to 0, then ramps negative
      expect(tank.turnSpeed).toBeLessThanOrEqual(0);
      expect(tank.turnSpeed).toBeGreaterThanOrEqual(-(TANK_TURN_ACCEL * DT + 0.001));
    });
  });

  describe('NPC nudge budget', () => {
    it('queued nudge drains over multiple ticks', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      // Queue a large nudge with no held turn
      w.addNudge(tank.id, 0.5);
      const dirBefore = tank.dir;
      step(w, null, 1);
      const dirAfter1 = tank.dir;
      expect(dirAfter1 - dirBefore).toBeGreaterThan(0); // turned right
      // The nudge should continue draining in subsequent ticks
      const dirAfter1Copy = tank.dir;
      step(w, null, 1);
      expect(tank.dir).toBeGreaterThan(dirAfter1Copy); // still turning
    });

    it('held key takes priority over nudge', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      // Both held turn and queued nudge
      w.addNudge(tank.id, 0.3);
      w.setInput(tank.id, { accel: 0, turn: 1, fire: false });
      const dirBefore = tank.dir;
      step(w, null, 1);
      // The total rotation = held turn + remaining nudge budget
      const totalTurn = tank.dir - dirBefore;
      // Should be positive (both turn right)
      expect(totalTurn).toBeGreaterThan(0);
    });
  });

  describe('NPC nudge clamp', () => {
    it('addNudge clamps cumulative pending to [-π, π]', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      // Add way more than π
      w.addNudge(tank.id, PI * 3);
      w.addNudge(tank.id, PI * 3);
      // Step with no held turn — the clamped nudge should drain
      w.setInput(tank.id, { accel: 0, turn: 0, fire: false });
      const dirBefore = tank.dir;
      step(w, null, 1);
      // Maximum turn per tick = TANK_TURN_RATE * DT
      const maxTurn = TANK_TURN_RATE * DT;
      expect(tank.dir - dirBefore).toBeLessThanOrEqual(maxTurn + 1e-6);
    });

    it('addNudge ignores NaN', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      const dirBefore = tank.dir;
      w.addNudge(tank.id, NaN);
      w.setInput(tank.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 1);
      expect(tank.dir).toBe(dirBefore); // no change
    });

    it('addNudge ignores non-finite (Infinity)', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      const dirBefore = tank.dir;
      w.addNudge(tank.id, Infinity);
      w.setInput(tank.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 1);
      expect(tank.dir).toBe(dirBefore); // no change
    });
  });

  describe('NPC angle wrap', () => {
    it('dir stays in [-π, π] across many continuous-turn ticks', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, npc: true });
      w.setInput(tank.id, { accel: 0, turn: 1, fire: false });
      step(w, null, 200);
      expect(tank.dir).toBeGreaterThanOrEqual(-PI);
      expect(tank.dir).toBeLessThanOrEqual(PI);
    });
  });

  // --- Player heading (client-authoritative; server rate-limits via setHeading) ---

  describe('player tank skips server-side turn', () => {
    it('setInput with turn does not rotate a player tank', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 }); // npc: false (default)
      w.setInput(tank.id, { accel: 0, turn: 1, fire: false });
      step(w, null, 10);
      expect(tank.dir).toBe(0); // no change — player heading is client-authoritative
      expect(tank.turnSpeed).toBe(0);
    });
  });

  describe('setHeading rate limit', () => {
    it('large delta is clamped to turnRate * DT * 1.5', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      const maxStep = TANK_TURN_RATE * DT * 1.5;
      // Request a 180° turn — should be clamped
      w.setHeading(tank.id, PI);
      expect(tank.dir).toBeCloseTo(maxStep, 5);
      expect(tank.dir).toBeLessThan(PI);
    });

    it('small delta is applied in full', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      const smallStep = TANK_TURN_RATE * DT * 0.5; // within the clamp
      w.setHeading(tank.id, smallStep);
      expect(tank.dir).toBeCloseTo(smallStep, 5);
    });

    it('setHeading ignores NaN', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0.5 });
      w.setHeading(tank.id, NaN);
      expect(tank.dir).toBe(0.5); // unchanged
    });

    it('setHeading ignores non-finite (Infinity)', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0.5 });
      w.setHeading(tank.id, Infinity);
      expect(tank.dir).toBe(0.5); // unchanged
    });

    it('setHeading on missing tank is a no-op', () => {
      const w = makeWorld();
      // Should not throw
      w.setHeading(99999, PI);
    });

    it('heading normalizes to [-π, π]', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: PI - 0.01 });
      // Small positive step pushes past π, should wrap to -π range
      w.setHeading(tank.id, PI - 0.01 + TANK_TURN_RATE * DT * 0.5);
      expect(tank.dir).toBeGreaterThanOrEqual(-PI);
      expect(tank.dir).toBeLessThanOrEqual(PI);
    });

    it('repeated calls accumulate toward target (drains over multiple ticks)', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      const target = 1.0; // ~57°
      // Each call moves at most turnRate * DT * 1.5 ≈ 0.48 rad
      const maxPerCall = TANK_TURN_RATE * DT * 1.5;
      const minCalls = Math.ceil(target / maxPerCall);
      for (let i = 0; i < minCalls; i++) {
        w.setHeading(tank.id, target);
      }
      expect(tank.dir).toBeCloseTo(target, 1);
    });
  });
});
