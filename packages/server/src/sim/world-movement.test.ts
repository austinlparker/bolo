import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  DT,
  TANK_ACCEL,
  TANK_BRAKE,
  TANK_MAX_SPEED,
  TANK_REVERSE_FACTOR,
  MAP_SIZE,
} from '@bolo/shared';
import { Terrain } from '@bolo/shared';
import { addTankAt, makeWorld, setTile, step, stubRandom } from './world.test-utils';

const W = MAP_SIZE;

/** Build a horizontal corridor of `terrain` tiles centered on (cx,cy). */
function makeCorridor(w: ReturnType<typeof makeWorld>, cx: number, cy: number, t: Terrain, halfWidth = 40): void {
  for (let dx = -halfWidth; dx <= halfWidth; dx++) {
    setTile(w, cx + dx, cy, t);
  }
}

describe('World movement & physics', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  describe('forward acceleration', () => {
    it('speed ramps toward TANK_MAX_SPEED on road', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 3);
      expect(tank.speed).toBeGreaterThan(0);
      step(w, null, 40);
      expect(tank.speed).toBeCloseTo(TANK_MAX_SPEED, 0);
    });

    it('accelerates by TANK_ACCEL*DT per tick (first tick)', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 1);
      expect(tank.speed).toBeCloseTo(TANK_ACCEL * DT, 5);
    });
  });

  describe('braking vs accel', () => {
    it('opposing input brakes at TANK_BRAKE > TANK_ACCEL rate', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      // Build up forward speed
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 10);
      const speedBefore = tank.speed;
      // Now brake (accel=-1 while speed>0)
      w.setInput(tank.id, { accel: -1, turn: 0, fire: false });
      step(w, null, 1);
      const speedAfter = tank.speed;
      expect(speedAfter).toBeLessThan(speedBefore);
      expect(speedBefore - speedAfter).toBeCloseTo(TANK_BRAKE * DT, 5);
    });
  });

  describe('reverse factor', () => {
    it('accel:-1 clamps speed at -TANK_MAX_SPEED * TANK_REVERSE_FACTOR', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: -1, turn: 0, fire: false });
      // Reverse max = 2.0 tiles/sec; at 6 accel → 0.33 sec = ~4 ticks to reach.
      // But the tank reverses direction, so it moves west — needs corridor.
      step(w, null, 20);
      const expectedReverse = -TANK_MAX_SPEED * TANK_REVERSE_FACTOR;
      expect(tank.speed).toBeCloseTo(expectedReverse, 1);
    });
  });

  describe('terrain speed scaling', () => {
    it('grass gives 0.75 speed multiplier', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 20);
      expect(tank.speed).toBeCloseTo(TANK_MAX_SPEED * 0.75, 0);
    });

    it('swamp gives 0.25 speed multiplier', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Swamp);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 20);
      expect(tank.speed).toBeCloseTo(TANK_MAX_SPEED * 0.25, 0);
    });

    it('forest gives 0.5 speed multiplier', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Forest);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 20);
      expect(tank.speed).toBeCloseTo(TANK_MAX_SPEED * 0.5, 0);
    });
  });

  describe('road shoulder', () => {
    it('center on road → full road speed', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Road);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 30);
      expect(tank.speed).toBeCloseTo(TANK_MAX_SPEED, 0);
    });

    it('tank on grass with road under treads gets road speed', () => {
      const w = makeWorld();
      // Grass strip at row 128, road strip at row 129. Tank at y=128.8 straddles:
      // center tile (128) = grass → terrainSpeed 0.75, but +y tread hits row 129 = road.
      for (let dx = -40; dx <= 40; dx++) {
        setTile(w, 128 + dx, 128, Terrain.Grass);
        setTile(w, 128 + dx, 129, Terrain.Road);
      }
      const tank = addTankAt(w, { x: 128.5, y: 128.8, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 30);
      // If shoulder works: speed approaches 4.0 (road); without: clamped at 3.0 (grass max)
      expect(tank.speed).toBeGreaterThan(TANK_MAX_SPEED * 0.75 + 0.1);
    });
  });

  describe('building collision', () => {
    it('driving into Building stops the tank (speed=0)', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.Road);
      // Place a building ahead
      setTile(w, 132, 128, Terrain.Building);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 30);
      // Tank should have hit the building and stopped
      expect(tank.speed).toBe(0);
      expect(tank.x).toBeLessThan(132);
    });
  });

  describe('deep sea without boat', () => {
    it('tank on deep sea without boat is killed', () => {
      const w = makeWorld();
      makeCorridor(w, 128, 128, Terrain.DeepSea);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, onBoat: false });
      w.setInput(tank.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 1);
      expect(tank.alive).toBe(false);
    });
  });

  describe('map clamp', () => {
    it('position stays in [0.5, W-0.5]', () => {
      const w = makeWorld();
      makeCorridor(w, 4, 128, Terrain.Road, 5);
      const tank = addTankAt(w, { x: 4.5, y: 128.5, dir: Math.PI }); // facing west
      w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
      step(w, null, 50);
      expect(tank.x).toBeGreaterThanOrEqual(0.5);
      expect(tank.x).toBeLessThanOrEqual(W - 0.5);
    });
  });
});
