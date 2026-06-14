import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import {
  SHELL_DAMAGE,
  SHELL_RANGE,
  TANK_FIRE_COOLDOWN,
  TANK_MAX_ARMOR,
  PILL_MAX_HP,
  BASE_MAX_HP,
} from '@bolo/shared';
import { Terrain } from '@bolo/shared';
import { addTankAt, makeWorld, setTile, step, stubRandom } from './world.test-utils';

describe('World shells & combat', () => {
  let restoreRandom: (() => void) | null = null;
  beforeEach(() => {
    restoreRandom = stubRandom([0.5]);
  });
  afterEach(() => {
    restoreRandom?.();
    restoreRandom = null;
  });

  describe('shell travel + expiry', () => {
    it('fired shell travels and eventually expires', () => {
      const w = makeWorld();
      for (let dx = -20; dx <= 20; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, shells: 20 });
      // Fire once, then release
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1);
      expect(w.shells.length).toBe(1);
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      // Step until the shell expires (range=9, speed=0.9/tick → ~10 ticks)
      step(w, null, 15);
      expect(w.shells.length).toBe(0);
    });

    it('shell decrements owner shells count', () => {
      const w = makeWorld();
      for (let dx = -20; dx <= 20; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, shells: 20 });
      const before = shooter.shells;
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1);
      expect(shooter.shells).toBe(before - 1);
    });
  });

  describe('shell vs building', () => {
    it('shell on Building → ShotBuilding', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      setTile(w, 131, 128, Terrain.Building);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, shells: 20 });
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1); // fire
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 5); // let shell travel to building
      expect(w.tileAt(131.5, 128.5)).toBe(Terrain.ShotBuilding);
    });
  });

  describe('shell vs tank', () => {
    it('enemy within TANK_RADIUS takes SHELL_DAMAGE', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, faction: 'dawn', shells: 20 });
      const target = addTankAt(w, { x: 130.5, y: 128.5, faction: 'dusk', armor: TANK_MAX_ARMOR });
      const armorBefore = target.armor;
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1); // fire
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 5); // shell reaches target
      expect(target.armor).toBe(armorBefore - SHELL_DAMAGE);
    });

    it('same-faction tank is immune', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, faction: 'dawn', shells: 20 });
      const ally = addTankAt(w, { x: 130.5, y: 128.5, faction: 'dawn', armor: TANK_MAX_ARMOR });
      const armorBefore = ally.armor;
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1);
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 15);
      expect(ally.armor).toBe(armorBefore);
    });

    it('owner tank is immune to own shell', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, faction: 'dawn', shells: 20, armor: TANK_MAX_ARMOR });
      const armorBefore = shooter.armor;
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1);
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 15);
      expect(shooter.armor).toBe(armorBefore);
    });
  });

  describe('shell vs pillbox', () => {
    it('hostile pill takes SHELL_DAMAGE and cooldown drops', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const pill = w.pills.find((p) => !p.inTank)!;
      pill.x = 131;
      pill.y = 128;
      pill.owner = 'dusk';
      pill.hp = PILL_MAX_HP;
      pill.cooldown = 5; // set high so we can see it drop
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, faction: 'dawn', shells: 20 });
      const hpBefore = pill.hp;
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1); // fire
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 5); // shell reaches pill
      expect(pill.hp).toBe(hpBefore - SHELL_DAMAGE);
      // cooldown drops to the anger-based value: Math.min(existing, pillCooldownFor(hp))
      // At hp=70: anger = 1 - 70/75 = 0.0667 → cooldown ≈ 1.89
      // The shell hit sets cooldown = min(currently-ticking-down, 1.89)
      // Verify it dropped to at most the pillCooldownFor value
      const expectedCooldownMax = 2.0 + (0.4 - 2.0) * (1 - pill.hp / PILL_MAX_HP);
      expect(pill.cooldown).toBeLessThanOrEqual(expectedCooldownMax + 0.001);
    });
  });

  describe('shell vs base', () => {
    it('hostile base with hp>0 → fortifications battered, NOT captured', () => {
      const w = makeWorld();
      for (let dx = -5; dx <= 5; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const base = w.bases.find((b) => b.owner !== 'dawn')!;
      base.x = 131;
      base.y = 128;
      base.owner = 'dusk';
      base.hp = BASE_MAX_HP;
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, faction: 'dawn', shells: 20 });
      const hpBefore = base.hp;
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1); // fire
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: false });
      step(w, null, 5); // shell reaches base
      expect(base.hp).toBe(hpBefore - SHELL_DAMAGE);
      expect(base.owner).toBe('dusk'); // not captured
    });
  });

  describe('fire cooldown', () => {
    it('fireCooldown is set to TANK_FIRE_COOLDOWN after firing', () => {
      const w = makeWorld();
      for (let dx = -20; dx <= 20; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, shells: 20 });
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1);
      expect(shooter.fireCooldown).toBeCloseTo(TANK_FIRE_COOLDOWN, 5);
    });

    it('fires again only after cooldown elapses', () => {
      const w = makeWorld();
      for (let dx = -40; dx <= 40; dx++) setTile(w, 128 + dx, 128, Terrain.Grass);
      const shooter = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, shells: 20 });
      w.setInput(shooter.id, { accel: 0, turn: 0, fire: true });
      step(w, null, 1); // fire
      const shellsAfterFirst = shooter.shells;
      // 2 ticks later (0.2 sec) — cooldown (0.35) still active → no refire
      step(w, null, 2);
      expect(shooter.shells).toBe(shellsAfterFirst);
      // 2 more ticks (total 0.5 sec from fire) — cooldown expired → refire
      step(w, null, 2);
      expect(shooter.shells).toBeLessThan(shellsAfterFirst);
    });
  });

  describe('gun range clamping', () => {
    it('setGunRange clamps to [1, SHELL_RANGE]', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0 });
      w.setGunRange(tank.id, 100);
      expect(tank.gunRange).toBe(SHELL_RANGE);
      w.setGunRange(tank.id, 0.1);
      expect(tank.gunRange).toBe(1);
      w.setGunRange(tank.id, 5);
      expect(tank.gunRange).toBe(5);
    });

    it('setGunRange rejects non-finite', () => {
      const w = makeWorld();
      const tank = addTankAt(w, { x: 128.5, y: 128.5, dir: 0, gunRange: 5 });
      w.setGunRange(tank.id, NaN);
      expect(tank.gunRange).toBe(5);
      w.setGunRange(tank.id, Infinity);
      expect(tank.gunRange).toBe(5);
    });
  });
});
