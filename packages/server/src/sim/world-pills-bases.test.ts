import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  BASE_CAPTURE_HP,
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_HP,
  BASE_MAX_MINE_STOCK,
  BASE_MAX_SHELL_STOCK,
  BASE_REFUEL_INTERVAL,
  BASE_REFUEL_RADIUS,
  BASE_SIEGE_DRAIN_INTERVAL,
  PILL_COOLDOWN_ANGRY,
  PILL_COOLDOWN_CALM,
  PILL_MAX_HP,
  PILL_RANGE,
  PILL_REGEN_SECONDS,
  SHELL_SPEED,
  TANK_MAX_ARMOR,
  TANK_MAX_MINES,
  TANK_MAX_SHELLS,
  TICK_HZ,
} from '@bolo/shared';
import { Terrain } from '@bolo/shared';
import { addTankAt, makeWorld, setTile, step, stepWar, stubRandom } from './world.test-utils';

describe('World pillboxes', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  it('cooldown interpolates CALM→ANGRY as hp MAX→0', () => {
    // We can't call pillCooldownFor directly (private), so test indirectly:
    // verify the bounds via the effect on pill behavior. A full-hp pill should
    // have a cooldown near PILL_COOLDOWN_CALM (2.0), and a nearly-dead one
    // near PILL_COOLDOWN_ANGRY (0.4).
    const w = makeWorld();
    for (let dx = -15; dx <= 15; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    // Full-hp hostile pill
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.x = 132;
    pill.y = 128;
    pill.owner = 'dusk';
    pill.hp = PILL_MAX_HP;
    pill.cooldown = 0;
    // Target tank nearby
    const target = addTankAt(w, { x: 130.5, y: 128.5, faction: 'dawn', armor: TANK_MAX_ARMOR });
    step(w, null, 1);
    // Pill fires → cooldown set to ~PILL_COOLDOWN_CALM (2.0) for full hp
    expect(pill.cooldown).toBeCloseTo(PILL_COOLDOWN_CALM, 1);

    // Now damage the pill and test angry cooldown
    pill.hp = 1;
    pill.cooldown = 0;
    step(w, null, 1);
    // Pill fires → cooldown ≈ PILL_COOLDOWN_ANGRY (0.4)
    expect(pill.cooldown).toBeCloseTo(PILL_COOLDOWN_ANGRY, 1);
  });

  it('owned pill targets only the other faction', () => {
    const w = makeWorld();
    for (let dx = -15; dx <= 15; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.x = 132;
    pill.y = 128;
    pill.owner = 'dawn';
    pill.hp = PILL_MAX_HP;
    pill.cooldown = 0;
    // Place a friendly (dawn) tank near the pill — should NOT be targeted
    const ally = addTankAt(w, { x: 130.5, y: 128.5, faction: 'dawn', armor: TANK_MAX_ARMOR });
    const armorBefore = ally.armor;
    step(w, null, 5);
    expect(ally.armor).toBe(armorBefore); // not shot at

    // Now add an enemy (dusk) tank — should be targeted
    const enemy = addTankAt(w, { x: 131.0, y: 128.5, faction: 'dusk', armor: TANK_MAX_ARMOR });
    const enemyArmorBefore = enemy.armor;
    step(w, null, 30);
    expect(enemy.armor).toBeLessThan(enemyArmorBefore);
  });

  it('neutral pill targets everyone', () => {
    const w = makeWorld();
    for (let dx = -15; dx <= 15; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.x = 132;
    pill.y = 128;
    pill.owner = 'neutral';
    pill.hp = PILL_MAX_HP;
    pill.cooldown = 0;
    // Place a dawn tank — should be targeted by neutral pill
    const target = addTankAt(w, { x: 130.5, y: 128.5, faction: 'dawn', armor: TANK_MAX_ARMOR });
    const armorBefore = target.armor;
    step(w, null, 30);
    expect(target.armor).toBeLessThan(armorBefore);
  });

  it('forest-hidden tank is skipped by pills', () => {
    const w = makeWorld();
    for (let dx = -15; dx <= 15; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.x = 132;
    pill.y = 128;
    pill.owner = 'neutral';
    pill.hp = PILL_MAX_HP;
    pill.cooldown = 0;
    // Place target in a forest tile
    setTile(w, 130, 128, Terrain.Forest);
    const target = addTankAt(w, { x: 130.5, y: 128.5, faction: 'dawn', armor: TANK_MAX_ARMOR });
    const armorBefore = target.armor;
    step(w, null, 30);
    expect(target.armor).toBe(armorBefore);
  });

  it('self-repair: +1 hp per PILL_REGEN_SECONDS*TICK_HZ ticks', () => {
    const w = makeWorld();
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.hp = PILL_MAX_HP - 5;
    pill.cooldown = 100; // prevent firing
    const hpBefore = pill.hp;
    const regenTicks = PILL_REGEN_SECONDS * TICK_HZ;
    step(w, null, regenTicks);
    expect(pill.hp).toBe(hpBefore + 1);
  });

  it('pickup dead pill when tank drives onto it', () => {
    const w = makeWorld();
    for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.x = 130;
    pill.y = 128;
    pill.hp = 0; // dead pill
    const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, faction: 'dawn', carriedPill: null });
    // Drive the tank onto the pill tile
    tank.x = 130.5;
    tank.y = 128.5;
    // Simulate a tile transition by having the tank move onto it
    // handleTileTransitions is called from tickTank when prevTile != curTile.
    // We need the tank to actually cross into the tile during a tick.
    // Place the tank just outside the pill tile and drive into it.
    tank.x = 129.5;
    tank.y = 128.5;
    tank.dir = 0;
    for (let dx = -3; dx <= 3; dx++) setTile(w, 128 + dx, 128, Terrain.Road);
    w.setInput(tank.id, { accel: 1, turn: 0, fire: false });
    step(w, null, 10); // drive forward onto the pill tile
    expect(tank.carriedPill).toBe(pill.id);
    expect(pill.inTank).toBe(true);
    expect(tank.caps).toBeGreaterThan(0);
  });

  it('killed tank drops carried pill at current tile', () => {
    const w = makeWorld();
    for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
    // Give a tank a carried pill
    const pill = w.pills.find((p) => !p.inTank)!;
    pill.inTank = true;
    pill.owner = 'dawn';
    pill.hp = PILL_MAX_HP;
    // Low-armor target so it dies from one shell
    const tank = addTankAt(w, { x: 128.5, y: 128.5, faction: 'dawn', carriedPill: pill.id, armor: 1 });
    const shooter = addTankAt(w, { x: 126.5, y: 128.5, dir: 0, faction: 'dusk', shells: 20, gunRange: 5 });
    w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
    step(w, null, 1); // fire
    w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
    step(w, null, 5); // shell reaches tank
    expect(tank.alive).toBe(false);
    expect(pill.inTank).toBe(false);
    expect(pill.owner).toBe('neutral');
    expect(pill.hp).toBe(0);
  });
});

describe('World base economy', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  it('neutral capture: enemy on neutral pad → owner flips', () => {
    const w = makeWorld();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) setTile(w, 128 + dx, 128 + dy, Terrain.Road);
    const base = w.bases.find((b) => b.owner === 'neutral')!;
    base.x = 128;
    base.y = 128;
    base.owner = 'neutral';
    const tank = addTankAt(w, { x: 128.5, y: 128.5, faction: 'dawn' });
    const capsBefore = tank.caps;
    step(w, null, 1);
    expect(base.owner).toBe('dawn');
    expect(tank.caps).toBe(capsBefore + 1);
  });

  it('refuel: friendly tank on friendly base gets armor/shells', () => {
    const w = makeWorld();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) setTile(w, 128 + dx, 128 + dy, Terrain.Road);
    const base = w.bases[0];
    base.x = 128;
    base.y = 128;
    base.owner = 'dawn';
    base.armorStock = BASE_MAX_ARMOR_STOCK;
    base.shellStock = BASE_MAX_SHELL_STOCK;
    base.mineStock = BASE_MAX_MINE_STOCK;
    const tank = addTankAt(w, {
      x: 128.5, y: 128.5, faction: 'dawn',
      armor: 10, shells: 5, mines: 2,
    });
    const armorBefore = tank.armor;
    step(w, null, Math.ceil(BASE_REFUEL_INTERVAL / 0.1) + 1);
    expect(tank.armor).toBeGreaterThan(armorBefore);
  });

  it('siege drain: enemy on hostile base grinds hp down, tank takes damage', () => {
    const w = makeWorld();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) setTile(w, 128 + dx, 128 + dy, Terrain.Road);
    const base = w.bases[0];
    base.x = 128;
    base.y = 128;
    base.owner = 'dawn';
    base.hp = BASE_MAX_HP;
    const enemy = addTankAt(w, { x: 128.5, y: 128.5, faction: 'dusk', armor: TANK_MAX_ARMOR });
    const armorBefore = enemy.armor;
    const hpBefore = base.hp;
    step(w, null, Math.ceil(BASE_SIEGE_DRAIN_INTERVAL / 0.1) + 1);
    expect(base.hp).toBeLessThan(hpBefore);
    expect(enemy.armor).toBeLessThanOrEqual(armorBefore);
  });

  it('siege breach: enemy grinds hp to 0, base falls neutral, then the attacker claims it', () => {
    const w = makeWorld();
    for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) setTile(w, 128 + dx, 128 + dy, Terrain.Road);
    const base = w.bases[0];
    base.x = 128;
    base.y = 128;
    base.owner = 'dawn';
    base.hp = 1; // one siege tick from breach
    addTankAt(w, { x: 128.5, y: 128.5, faction: 'dusk' });
    // breach (hp→0, neutral) then the attacker on the pad claims the neutral base
    step(w, null, Math.ceil(BASE_SIEGE_DRAIN_INTERVAL / 0.1) + 2);
    expect(base.owner).toBe('dusk');
    expect(base.hp).toBe(BASE_CAPTURE_HP); // a fresh claim digs in from token hp
  });

  it('passive regen: owned uncontested base regenerates over time', () => {
    const w = makeWorld();
    const base = w.bases[0];
    base.owner = 'dawn';
    base.armorStock = 10;
    base.shellStock = 10;
    const stockBefore = base.armorStock;
    // BASE_REGEN_INTERVAL = 8 sec = 80 ticks
    step(w, null, 81);
    expect(base.armorStock).toBeGreaterThan(stockBefore);
  });
});
