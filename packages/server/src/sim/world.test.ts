/**
 * Sim tests, run against a real generated island (the sim is pure TS — no
 * Workers APIs). Tanks are placed by writing x/y directly; time advances by
 * driving doTick at TICK_HZ like the Durable Object does.
 */
import {
  ATTRITION_AFTER_MINUTES,
  ATTRITION_FLOOR,
  ATTRITION_RAMP_MINUTES,
  BASE_CAPTURE_HP,
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_HP,
  BASE_MAX_MINE_STOCK,
  BASE_MAX_SHELL_STOCK,
  BASE_NEUTRAL_START_HP,
  COST_ROAD,
  DOMINANCE_BASES,
  DOMINANCE_MINUTES,
  type Faction,
  idx,
  MineState,
  PILL_MAX_HP,
  PILL_REGEN_SECONDS,
  SHELL_DAMAGE,
  SHELL_RANGE,
  TANK_MAX_ARMOR,
  Terrain,
  TICK_HZ,
  WAR_MIN_MINUTES,
} from '@bolo/shared';
import { describe, expect, it } from 'vitest';
import { World, type StatEvent } from './world';
import { attritionFactor } from './utils';
import type { Base, GameEvent, Tank } from '@bolo/shared';

const WAR_MIN = WAR_MIN_MINUTES + 1; // past the no-victory guard

function makeWorld(): World {
  return new World(1, 0xb010);
}

/** Drive N ticks, collecting every event and stat emitted along the way. */
function tickN(
  world: World,
  n: number,
  warMinutes = WAR_MIN,
): { events: GameEvent[]; stats: StatEvent[]; warEnded: Faction | null } {
  const events: GameEvent[] = [];
  const stats: StatEvent[] = [];
  let warEnded: Faction | null = null;
  for (let i = 0; i < n && !warEnded; i++) {
    const r = world.doTick(warMinutes);
    events.push(...r.events);
    stats.push(...r.stats);
    warEnded = r.warEnded;
  }
  return { events, stats, warEnded };
}

/** Flatten a square of grass (and clear mines) so movement/building tests are deterministic. */
function flatten(world: World, cx: number, cy: number, r = 6): void {
  for (let y = cy - r; y <= cy + r; y++) {
    for (let x = cx - r; x <= cx + r; x++) {
      world.terrain[idx(x, y)] = Terrain.Grass;
      world.mines[idx(x, y)] = MineState.None;
    }
  }
}

/** A driver tank on flat grass at (cx,cy), pointed east, stationary. */
function driverAt(world: World, cx: number, cy: number, faction: Faction = 'dawn'): Tank {
  flatten(world, cx, cy);
  const tank = world.addTank(`did:test:${faction}-drv`, `${faction}.drv`, faction, false);
  tank.x = cx + 0.5;
  tank.y = cy + 0.5;
  tank.dir = 0;
  tank.speed = 0;
  return tank;
}

/** Park a tank dead-center on a base pad (the pad tile is always drivable). */
function parkOn(world: World, base: Base, faction: Faction): Tank {
  const tank = world.addTank(`did:test:${faction}`, `${faction}.test`, faction, false);
  tank.x = base.x + 0.5;
  tank.y = base.y + 0.5;
  return tank;
}

function baseOwned(world: World, owner: 'dawn' | 'dusk' | 'neutral'): Base {
  const b = world.bases.find((b) => b.owner === owner);
  if (!b) throw new Error(`no ${owner} base on this map`);
  return b;
}

/** A shell one tile west of the pad, flying east into it. */
function shellAt(world: World, base: Base, faction: Faction): void {
  world.shells.push({
    id: 9000 + world.shells.length,
    x: base.x - 0.5,
    y: base.y + 0.5,
    dir: 0,
    faction,
    ownerTank: -1,
    range: 3,
    fired: 3,
  });
}

describe('base capture', () => {
  it('claims a neutral base by parking on it', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'neutral');
    const before = base.hp;
    const tank = parkOn(world, base, 'dusk');

    const { events } = tickN(world, 1);

    expect(base.owner).toBe('dusk');
    expect(base.hp).toBeGreaterThanOrEqual(Math.max(before, BASE_CAPTURE_HP));
    expect(tank.caps).toBe(1);
    expect(events).toContainEqual({ e: 'base_captured', baseId: base.id, by: 'dusk', handle: 'dusk.test', byDid: 'did:test:dusk', x: expect.any(Number), y: expect.any(Number) });
  });

  it('sieging an enemy base grinds hp and zaps the attacker, without flipping it', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    const tank = parkOn(world, base, 'dusk');
    const hp0 = base.hp;
    const armor0 = tank.armor;

    tickN(world, TICK_HZ * 3); // 3 seconds on the pad

    expect(base.owner).toBe('dawn');
    expect(base.hp).toBeLessThan(hp0);
    expect(tank.armor).toBeLessThan(armor0);
    expect(hp0 - base.hp).toBe(armor0 - tank.armor); // 1-for-1 attrition
  });

  it('a base whose hp hits 0 falls neutral, then the besieger claims it', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    base.hp = 2;
    parkOn(world, base, 'dusk');

    const { events } = tickN(world, TICK_HZ * 3);

    expect(events).toContainEqual({ e: 'base_neutralized', baseId: base.id, by: 'dusk' });
    expect(base.owner).toBe('dusk'); // pad race won by the tank already there
    // claimed at BASE_CAPTURE_HP; may have fortified a point since
    expect(base.hp).toBeGreaterThanOrEqual(BASE_CAPTURE_HP);
    expect(base.hp).toBeLessThan(BASE_CAPTURE_HP + 5);
  });

  it('shells batter fortifications and neutralize at 0', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    const hp0 = base.hp;

    shellAt(world, base, 'dusk');
    const { stats } = tickN(world, 3);
    expect(base.hp).toBe(hp0 - SHELL_DAMAGE);
    expect(stats.some((s) => s.name === 'shot' && s.outcome === 'base')).toBe(true);

    base.hp = 1;
    shellAt(world, base, 'dusk');
    const { events } = tickN(world, 3);
    expect(base.owner).toBe('neutral');
    expect(base.hp).toBe(0);
    expect(events).toContainEqual({ e: 'base_neutralized', baseId: base.id, by: 'dusk' });
  });

  it('friendly shells pass over your own base; all shells ignore neutral bases', () => {
    const world = makeWorld();
    const own = baseOwned(world, 'dawn');
    const hp0 = own.hp;
    shellAt(world, own, 'dawn');
    tickN(world, 5);
    expect(own.hp).toBe(hp0);

    const neutral = baseOwned(world, 'neutral');
    const nhp0 = neutral.hp;
    shellAt(world, neutral, 'dusk');
    tickN(world, 5);
    expect(neutral.hp).toBe(nhp0);
    expect(neutral.owner).toBe('neutral');
  });
});

describe('base fortification & supply', () => {
  it('an owned, uncontested base fortifies over time; a contested one does not', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    base.hp = 50;

    tickN(world, TICK_HZ * 5); // 5 quiet seconds
    const fortified = base.hp;
    expect(fortified).toBeGreaterThan(50);

    // an enemy tank lurking nearby (but off the pad) freezes the engineers
    const enemy = world.addTank('did:test:lurker', 'lurker.test', 'dusk', false);
    enemy.x = base.x + 3.5;
    enemy.y = base.y + 0.5;
    const before = base.hp;
    tickN(world, TICK_HZ * 5);
    expect(base.hp).toBe(before);
  });

  it('refuels shells faster at full fortification than when battered', () => {
    const drained = (hp: number): number => {
      const world = makeWorld();
      const base = baseOwned(world, 'dawn');
      base.hp = hp;
      base.shellStock = BASE_MAX_SHELL_STOCK;
      const tank = parkOn(world, base, 'dawn');
      tank.shells = 0;
      tickN(world, TICK_HZ * 10);
      return tank.shells;
    };

    const atFull = drained(BASE_MAX_HP);
    const atLow = drained(5);
    expect(atFull).toBeGreaterThan(atLow);
    expect(atLow).toBeGreaterThan(0); // a battered base still supplies, slowly
  });

  it('passive restock flips basesChanged so clients see the supply bar move', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    base.shellStock = 0;
    base.armorStock = 0;

    // uncontested, nobody refueling: stock climbs silently unless flagged
    let flaggedOnRestock = false;
    const before = base.shellStock;
    for (let i = 0; i < TICK_HZ * 12; i++) {
      const r = world.doTick(WAR_MIN);
      if (base.shellStock > before && r.basesChanged) flaggedOnRestock = true;
    }
    expect(base.shellStock).toBeGreaterThan(before);
    expect(flaggedOnRestock).toBe(true);
  });

  it('a full base does not broadcast a no-op bases array every regen interval', () => {
    const world = makeWorld();
    // top out every owned base (neutral bases neither fortify nor restock)
    for (const b of world.bases) {
      b.hp = BASE_MAX_HP;
      b.armorStock = BASE_MAX_ARMOR_STOCK;
      b.shellStock = BASE_MAX_SHELL_STOCK;
      b.mineStock = BASE_MAX_MINE_STOCK;
    }
    // everything topped out, no tanks on the map -> no base should ever flag
    let everFlagged = false;
    for (let i = 0; i < TICK_HZ * 30; i++) {
      if (world.doTick(WAR_MIN).basesChanged) everFlagged = true;
    }
    expect(everFlagged).toBe(false);
  });
});

describe('war lifecycle', () => {
  it('total conquest wins the war (after the minimum)', () => {
    const world = makeWorld();
    for (const b of world.bases) b.owner = 'dawn';
    expect(tickN(world, 1, WAR_MIN_MINUTES - 1).warEnded).toBeNull();
    expect(tickN(world, 1).warEnded).toBe('dawn');
  });

  it('a mere base majority never ends the war (no time cap)', () => {
    const world = makeWorld();
    // 8/6 split, deep into a marathon war
    world.bases.forEach((b, i) => (b.owner = i < 8 ? 'dawn' : 'dusk'));
    expect(tickN(world, TICK_HZ * 5, 300).warEnded).toBeNull();
  });

  it('dominance: holding >= DOMINANCE_BASES starts a countdown that wins the war', () => {
    const world = makeWorld();
    world.bases.forEach((b, i) => (b.owner = i < DOMINANCE_BASES ? 'dawn' : 'dusk'));

    const first = tickN(world, 1);
    expect(first.events.some((e) => e.e === 'dominance' && e.faction === 'dawn')).toBe(true);

    const run = tickN(world, DOMINANCE_MINUTES * 60 * TICK_HZ + 1);
    expect(run.warEnded).toBe('dawn');
  });

  it('dominance broken by losing a base resets the countdown', () => {
    const world = makeWorld();
    world.bases.forEach((b, i) => (b.owner = i < DOMINANCE_BASES ? 'dawn' : 'dusk'));
    tickN(world, TICK_HZ * 60); // a minute into the countdown

    world.bases[0].owner = 'neutral'; // grip broken: 11 < 12
    const broken = tickN(world, 1);
    expect(broken.events).toContainEqual({ e: 'dominance', faction: null, endsAt: null });

    // regaining it starts a FRESH countdown — the old minute doesn't count
    world.bases[0].owner = 'dawn';
    const resumed = tickN(world, DOMINANCE_MINUTES * 60 * TICK_HZ - TICK_HZ * 30);
    expect(resumed.warEnded).toBeNull();
  });

  it('attrition holds at 1 until the threshold, then ramps to the floor', () => {
    expect(attritionFactor(0)).toBe(1);
    expect(attritionFactor(ATTRITION_AFTER_MINUTES)).toBe(1);
    const mid = attritionFactor(ATTRITION_AFTER_MINUTES + ATTRITION_RAMP_MINUTES / 2);
    expect(mid).toBeCloseTo(1 - 0.5 * (1 - ATTRITION_FLOOR));
    expect(attritionFactor(ATTRITION_AFTER_MINUTES + ATTRITION_RAMP_MINUTES)).toBeCloseTo(ATTRITION_FLOOR);
    expect(attritionFactor(10_000)).toBeCloseTo(ATTRITION_FLOOR);
  });
});

describe('tank handling', () => {
  /** A tank alone on a flattened grass plain, pointed east. */
  function tankOnPlain(world: World): Tank {
    const tank = world.addTank('did:test:driver', 'driver.test', 'dawn', false);
    const cx = 128;
    const cy = 128;
    for (let y = cy - 6; y <= cy + 6; y++) {
      for (let x = cx - 6; x <= cx + 6; x++) {
        world.terrain[idx(x, y)] = Terrain.Grass;
      }
    }
    tank.x = cx + 0.5;
    tank.y = cy + 0.5;
    tank.dir = 0;
    tank.speed = 0;
    return tank;
  }

  it('acceleration tapers as speed builds (accelCurve)', () => {
    const world = makeWorld();
    const tank = tankOnPlain(world);
    world.setInput(tank.id, { accel: 1, turn: 0, fire: false });

    world.doTick(WAR_MIN);
    const firstGain = tank.speed;

    let lastGain = firstGain;
    for (let i = 0; i < TICK_HZ * 3; i++) {
      const before = tank.speed;
      world.doTick(WAR_MIN);
      if (tank.speed > before) lastGain = tank.speed - before;
      tank.x = 128.5; // hold position so terrain never changes under the test
      tank.y = 128.5;
    }
    expect(lastGain).toBeLessThan(firstGain);
    expect(world.tuning.accelCurve).toBeGreaterThan(0);
  });

  it('with accelCurve 0 the ramp is linear (constant per-tick gain)', () => {
    const world = makeWorld();
    world.tuning.accelCurve = 0;
    const tank = tankOnPlain(world);
    world.setInput(tank.id, { accel: 1, turn: 0, fire: false });

    world.doTick(WAR_MIN);
    const firstGain = tank.speed;
    tank.x = 128.5;
    tank.y = 128.5;
    world.doTick(WAR_MIN);
    const secondGain = tank.speed - firstGain;
    expect(secondGain).toBeCloseTo(firstGain);
  });
});

describe('input hardening', () => {
  it('NaN/out-of-range input cannot poison tank dir or speed', () => {
    const world = makeWorld();
    const tank = driverAt(world, 128, 128);
    // a malicious/buggy caller feeds garbage straight into setInput
    world.setInput(tank.id, { accel: NaN, turn: Infinity, fire: true } as never);
    tickN(world, 10);
    expect(Number.isFinite(tank.dir)).toBe(true);
    expect(Number.isFinite(tank.speed)).toBe(true);
    expect(Math.abs(tank.speed)).toBeLessThanOrEqual(world.tuning.maxSpeed + 0.01);
  });

  it('builder orders reject non-finite and out-of-bounds coordinates', () => {
    const world = makeWorld();
    const tank = driverAt(world, 128, 128);
    expect(world.builderOrder(tank.id, 'wall', NaN, 128)).toBe('out of bounds');
    expect(world.builderOrder(tank.id, 'wall', 128, Infinity)).toBe('out of bounds');
    expect(world.builderOrder(tank.id, 'wall', -1, 128)).toBe('out of bounds');
    expect(world.builderOrder(tank.id, 'wall', 99999, 128)).toBe('out of bounds');
  });

  it('gun range clamps to [1, SHELL_RANGE] and ignores non-finite input', () => {
    const world = makeWorld();
    const tank = driverAt(world, 128, 128);
    world.setGunRange(tank.id, 999);
    expect(tank.gunRange).toBe(SHELL_RANGE);
    world.setGunRange(tank.id, -5);
    expect(tank.gunRange).toBe(1);
    world.setGunRange(tank.id, 4);
    world.setGunRange(tank.id, NaN);
    expect(tank.gunRange).toBe(4); // unchanged
  });
});

describe('builder construction', () => {
  it('cannot build a wall on a base tile', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    const tank = world.addTank('did:test:eng', 'eng.test', 'dawn', false);
    tank.x = base.x + 0.5;
    tank.y = base.y + 1.5; // adjacent, within builder range
    const before = world.terrain[idx(base.x, base.y)];
    expect(world.builderOrder(tank.id, 'wall', base.x, base.y)).toBe('cannot build on a base');
    expect(world.terrain[idx(base.x, base.y)]).toBe(before);
  });

  it('paves a road, deducting trees up front, and completes the job', () => {
    const world = makeWorld();
    const tank = driverAt(world, 128, 128);
    tank.trees = 10;
    const tx = 129;
    const ty = 128;
    expect(world.builderOrder(tank.id, 'road', tx, ty)).toBeNull();
    expect(tank.trees).toBe(10 - COST_ROAD); // cost taken at order time
    tickN(world, 150); // let the engineer walk out, work, and finish
    expect(world.terrain[idx(tx, ty)]).toBe(Terrain.Road);
  });

  it('recalling an in-progress order refunds its cost', () => {
    const world = makeWorld();
    const tank = driverAt(world, 128, 128);
    tank.trees = 10;
    world.builderOrder(tank.id, 'road', 129, 128);
    expect(tank.trees).toBe(10 - COST_ROAD);
    world.builderRecall(tank.id);
    expect(tank.trees).toBe(10);
  });
});

describe('mine chain reaction', () => {
  it('detonating one mine chains through orthogonally adjacent mines', () => {
    const world = makeWorld();
    const cx = 128;
    const cy = 128;
    const tank = driverAt(world, cx, cy);
    // a row of three mines just ahead of the tank
    for (const x of [cx + 2, cx + 3, cx + 4]) world.mines[idx(x, cy)] = MineState.Dawn;
    tank.x = cx + 1.6;
    world.setInput(tank.id, { accel: 1, turn: 0, fire: false });
    tickN(world, 20); // drive over the first mine
    for (const x of [cx + 2, cx + 3, cx + 4]) {
      expect(world.mines[idx(x, cy)]).toBe(MineState.None);
    }
  });
});

describe('pillbox behavior', () => {
  it('self-repairs over time while undamaged-but-not-full', () => {
    const world = makeWorld();
    const pill = world.pills[0];
    pill.inTank = false;
    pill.hp = PILL_MAX_HP - 4;
    const before = pill.hp;
    tickN(world, PILL_REGEN_SECONDS * TICK_HZ * 2 + 2);
    expect(pill.hp).toBeGreaterThan(before);
  });

  it('fires at an enemy tank in range', () => {
    const world = makeWorld();
    const cx = 128;
    const cy = 128;
    flatten(world, cx, cy);
    const pill = world.pills[0];
    pill.inTank = false;
    pill.owner = 'dawn';
    pill.hp = PILL_MAX_HP;
    pill.cooldown = 0;
    pill.x = cx;
    pill.y = cy;
    const enemy = world.addTank('did:test:prey', 'prey.test', 'dusk', false);
    enemy.x = cx + 3.5;
    enemy.y = cy + 0.5;
    world.doTick(WAR_MIN);
    expect(world.shells.some((s) => s.ownerTank < 0)).toBe(true); // pillbox-fired
  });
});

describe('world serialization', () => {
  it('round-trips war + dominance state through serialize/restore', () => {
    const world = makeWorld();
    world.bases.forEach((b, i) => (b.owner = i < DOMINANCE_BASES ? 'dawn' : 'dusk'));
    world.bases[0].hp = 42;
    tickN(world, TICK_HZ * 3); // advance tick and start the dominance countdown
    const hp0 = world.bases[0].hp; // (may have fortified a point since)

    const restored = World.restore(world.serializeMeta(), world.terrain, world.mines);
    expect(restored.warNumber).toBe(world.warNumber);
    expect(restored.seed).toBe(world.seed);
    expect(restored.tick).toBe(world.tick);
    expect(restored.bases[0].hp).toBe(hp0);
    expect(restored.warInfo('active', null).dominance?.faction).toBe('dawn');
  });

  it('migrates a pre-fortification save by defaulting base hp', () => {
    const world = makeWorld();
    const meta = world.serializeMeta();
    for (const b of meta.bases as { hp?: number }[]) delete b.hp;
    const restored = World.restore(meta, world.terrain, world.mines);
    for (const b of restored.bases) {
      expect(Number.isFinite(b.hp)).toBe(true);
      expect(b.hp).toBe(b.owner === 'neutral' ? BASE_NEUTRAL_START_HP : BASE_MAX_HP);
    }
  });
});

describe('siege rate is per-pad, not per-tank (regression)', () => {
  it('three besiegers drain fortification at the single-pad rate, damaging one tank per interval', () => {
    const world = makeWorld();
    const base = baseOwned(world, 'dawn');
    base.hp = 50;
    const tanks: Tank[] = [];
    for (let i = 0; i < 3; i++) {
      const t = world.addTank(`did:test:siege${i}`, `siege${i}.test`, 'dusk', false);
      t.x = base.x + 0.5;
      t.y = base.y + 0.5; // all crammed onto the pad
      tanks.push(t);
    }
    tickN(world, TICK_HZ * 2); // 2s == 4 siege intervals

    // pre-fix all three fired every interval (~12 hp, ~12 armor); now it's ~4
    expect(base.hp).toBeGreaterThanOrEqual(45);
    const armorLost = tanks.reduce((sum, t) => sum + (TANK_MAX_ARMOR - t.armor), 0);
    expect(armorLost).toBeLessThanOrEqual(6);
  });
});

describe('shell substep collision', () => {
  it('a fast shell detonates on a wall instead of tunnelling through it', () => {
    const world = makeWorld();
    const cx = 128;
    const cy = 128;
    flatten(world, cx, cy);
    world.terrain[idx(cx + 2, cy)] = Terrain.Building;
    world.shells.push({
      id: 1,
      x: cx + 0.5,
      y: cy + 0.5,
      dir: 0,
      faction: 'dawn',
      ownerTank: -1,
      range: 9,
      fired: 9,
    });
    const { stats } = tickN(world, 3);
    expect(stats.some((s) => s.name === 'shot' && s.outcome === 'wall')).toBe(true);
    expect(world.shells.length).toBe(0); // resolved, did not pass through
  });
});
