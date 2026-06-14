import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BUILDER_MAX_RANGE,
  BUILDER_WORK_SECONDS,
  COST_BOAT,
  COST_PILL_PLACE,
  COST_ROAD,
  COST_WALL,
  COST_WALL_REPAIR,
  MAP_SIZE,
  MINE_DAMAGE,
  PILL_MAX_HP,
  PILL_REPAIR_HP,
  PILL_REPAIR_TREES,
  TANK_MAX_ARMOR,
  TREES_PER_FOREST_TILE,
  WAR_MIN_MINUTES,
} from '@bolo/shared';
import { Terrain, MineState, idx } from '@bolo/shared';
import { addTankAt, makeWorld, setTile, step, stepWar, stubRandom } from './world.test-utils';
import { World } from './world';

const W = MAP_SIZE;

describe('World builders', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  describe('order validation', () => {
    it('rejects when tank is dead', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10, mines: 5 });
      tank.alive = false;
      expect(w.builderOrder(tank.id, 'road', 129, 128)).toBe('not alive');
    });

    it('rejects when builder is already out', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      setTile(w, 129, 128, Terrain.Forest);
      setTile(w, 130, 128, Terrain.Forest);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      expect(w.builderOrder(tank.id, 'harvest', 129, 128)).toBeNull();
      // Builder is now outbound; second order should fail
      expect(w.builderOrder(tank.id, 'harvest', 130, 128)).toBe('builder is out');
    });

    it('rejects out-of-bounds target', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      expect(w.builderOrder(tank.id, 'road', -1, 128)).toBe('out of bounds');
      expect(w.builderOrder(tank.id, 'road', W, 128)).toBe('out of bounds');
    });

    it('rejects too-far target', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      // BUILDER_MAX_RANGE = 12 tiles
      expect(w.builderOrder(tank.id, 'harvest', 128 + BUILDER_MAX_RANGE + 1, 128)).toBe('too far away');
    });

    it('harvest requires forest', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      setTile(w, 129, 128, Terrain.Grass);
      expect(w.builderOrder(tank.id, 'harvest', 129, 128)).toBe('no trees there');
      setTile(w, 130, 128, Terrain.Forest);
      expect(w.builderOrder(tank.id, 'harvest', 130, 128)).toBeNull();
    });

    it('road requires trees and buildable terrain', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 1 });
      // Not enough trees (COST_ROAD = 2)
      expect(w.builderOrder(tank.id, 'road', 129, 128)).toBe('not enough trees');
      tank.trees = COST_ROAD;
      // Deep sea can't be paved
      setTile(w, 129, 128, Terrain.DeepSea);
      expect(w.builderOrder(tank.id, 'road', 129, 128)).toBe('cannot pave that');
      // Grass is fine
      setTile(w, 129, 128, Terrain.Grass);
      expect(w.builderOrder(tank.id, 'road', 129, 128)).toBeNull();
      expect(tank.trees).toBe(0); // cost deducted
    });

    it('mine requires non-water, no existing mine, and a mine in inventory', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, mines: 0 });
      expect(w.builderOrder(tank.id, 'mine', 129, 128)).toBe('no mines');
      tank.mines = 1;
      setTile(w, 129, 128, Terrain.River);
      expect(w.builderOrder(tank.id, 'mine', 129, 128)).toBe('cannot mine water');
      setTile(w, 129, 128, Terrain.Grass);
      w.mines[idx(129, 128)] = MineState.Neutral;
      expect(w.builderOrder(tank.id, 'mine', 129, 128)).toBe('already mined');
      w.mines[idx(129, 128)] = MineState.None;
      expect(w.builderOrder(tank.id, 'mine', 129, 128)).toBeNull();
      expect(tank.mines).toBe(0);
    });
  });

  describe('upfront cost deduction', () => {
    it('road deducts COST_ROAD at order time', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      w.builderOrder(tank.id, 'road', 129, 128);
      expect(tank.trees).toBe(10 - COST_ROAD);
    });

    it('wall deducts COST_WALL at order time', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      w.builderOrder(tank.id, 'wall', 129, 128);
      expect(tank.trees).toBe(10 - COST_WALL);
    });

    it('boat deducts COST_BOAT at order time', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.River);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 20 });
      w.builderOrder(tank.id, 'boat', 129, 128);
      expect(tank.trees).toBe(20 - COST_BOAT);
    });
  });

  describe('refund on recall', () => {
    it('builderRecall during outbound refunds the deducted cost', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      w.builderOrder(tank.id, 'road', 129, 128);
      expect(tank.trees).toBe(10 - COST_ROAD);
      w.builderRecall(tank.id);
      expect(tank.trees).toBe(10); // refunded
    });
  });

  describe('lifecycle', () => {
    it('harvest: outbound → working → returning → in_tank, grants trees', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      setTile(w, 129, 128, Terrain.Forest);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 0 });
      w.builderOrder(tank.id, 'harvest', 129, 128);
      expect(tank.builder.phase).toBe('outbound');
      // Step until builder reaches the forest and completes
      // BUILDER_SPEED=1.6 tiles/sec; distance ~1 tile → ~0.6 sec
      // BUILDER_WORK_SECONDS=2.0 → +2 sec. Then returning ~0.6 sec.
      step(w, null, 40);
      expect(tank.builder.phase).toBe('in_tank');
      expect(tank.trees).toBe(TREES_PER_FOREST_TILE);
      expect(w.tileAt(129.5, 128.5)).toBe(Terrain.Grass); // forest cleared
    });

    it('wall arrive distance: walls built from outside so builder not entombed', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, trees: 10 });
      setTile(w, 130, 128, Terrain.Grass);
      w.builderOrder(tank.id, 'wall', 130, 128);
      // Step to completion
      step(w, null, 50);
      expect(tank.builder.phase).toBe('in_tank');
      // Wall built
      expect(w.tileAt(130.5, 128.5)).toBe(Terrain.Building);
    });
  });

  describe('mine placement', () => {
    it('builder mine → faction MineState', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const tank = addTankAt(w, { x: 128.5, y: 128.5, faction: 'dawn', mines: 5 });
      setTile(w, 130, 128, Terrain.Grass);
      w.builderOrder(tank.id, 'mine', 130, 128);
      step(w, null, 50);
      expect(w.mines[idx(130, 128)]).toBe(MineState.Dawn);
    });
  });
});

describe('World mines', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  it('drive-over detonation: tank entering mined tile takes MINE_DAMAGE', () => {
    const w = makeWorld();
    for (let dx = -10; dx <= 10; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
    // Place a mine on tile 130
    w.mines[idx(130, 128)] = MineState.Neutral;
    const tank = addTankAt(w, { x: 127.5, y: 128.5, dir: 0, faction: 'dawn', armor: TANK_MAX_ARMOR });
    const armorBefore = tank.armor;
    w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
    step(w, null, 30); // drive east over the mine
    expect(tank.armor).toBeLessThanOrEqual(armorBefore - MINE_DAMAGE);
    // Mine consumed
    expect(w.mines[idx(130, 128)]).toBe(MineState.None);
  });

  it('chain reaction: adjacent mines detonate recursively', () => {
    const w = makeWorld();
    for (let dx = -10; dx <= 10; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
    // Place mines in a line: 130, 131, 132
    w.mines[idx(130, 128)] = MineState.Neutral;
    w.mines[idx(131, 128)] = MineState.Neutral;
    w.mines[idx(132, 128)] = MineState.Neutral;
    const tank = addTankAt(w, { x: 127.5, y: 128.5, dir: 0, faction: 'dawn', armor: TANK_MAX_ARMOR });
    w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
    step(w, null, 30);
    // All three mines should be consumed by chain reaction
    expect(w.mines[idx(130, 128)]).toBe(MineState.None);
    expect(w.mines[idx(131, 128)]).toBe(MineState.None);
    expect(w.mines[idx(132, 128)]).toBe(MineState.None);
  });
});

describe('World victory & lifecycle', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  it('total conquest after WAR_MIN_MINUTES ends the war', () => {
    const w = makeWorld();
    // Make dawn own all bases
    for (const b of w.bases) b.owner = 'dawn';
    // At WAR_MIN_MINUTES, checkVictory should trigger
    const result = w.doTick(WAR_MIN_MINUTES);
    expect(result.warEnded).toBe('dawn');
  });

  it('pre-minimum: conquest before WAR_MIN_MINUTES → warEnded null', () => {
    const w = makeWorld();
    for (const b of w.bases) b.owner = 'dawn';
    const result = w.doTick(WAR_MIN_MINUTES - 1);
    expect(result.warEnded).toBeNull();
  });

  // Time-cap base-majority tiebreak was replaced by the dominance countdown
  // (see world.test.ts for dominance victory / break / persistence coverage).

  it('respawn: dead tank respawns at respawnTick', () => {
    const w = makeWorld();
    for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    const tank = addTankAt(w, { x: 128.5, y: 128.5, faction: 'dawn', armor: 1 });
    tank.alive = false;
    tank.deaths = 1;
    tank.respawnTick = w.tick + 5;
    // Step past respawnTick
    step(w, null, 10);
    expect(tank.alive).toBe(true);
  });
});

describe('World persistence', () => {
  it('serializeMeta → restore round-trip', () => {
    const w = makeWorld(777);
    const tank = addTankAt(w, { x: 128.5, y: 128.5, faction: 'dawn' });
    step(w, null, 10);
    const meta = w.serializeMeta();
    const terrainCopy = new Uint8Array(w.terrain);
    const minesCopy = new Uint8Array(w.mines);
    const restored = World.restore(meta, terrainCopy, minesCopy);
    expect(restored.tick).toBe(w.tick);
    expect(restored.warNumber).toBe(w.warNumber);
    expect(restored.seed).toBe(w.seed);
    expect(restored.bases).toEqual(w.bases);
    expect(restored.pills).toEqual(w.pills);
    expect(Array.from(restored.terrain)).toEqual(Array.from(w.terrain));
    expect(Array.from(restored.mines)).toEqual(Array.from(w.mines));
  });
});
