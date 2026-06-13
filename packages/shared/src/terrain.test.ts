import { describe, it, expect } from 'vitest';
import { Terrain, shelledTerrain, minedTerrain, isWater } from './terrain';

describe('shelledTerrain', () => {
  // Exhaustive over all 11 Terrain values — locks terrain.ts:45-58
  it('Building → ShotBuilding', () => {
    expect(shelledTerrain(Terrain.Building)).toBe(Terrain.ShotBuilding);
  });
  it('ShotBuilding → Rubble', () => {
    expect(shelledTerrain(Terrain.ShotBuilding)).toBe(Terrain.Rubble);
  });
  it('Forest → Grass', () => {
    expect(shelledTerrain(Terrain.Forest)).toBe(Terrain.Grass);
  });
  it('BoatTile → River', () => {
    expect(shelledTerrain(Terrain.BoatTile)).toBe(Terrain.River);
  });
  it('all others → null', () => {
    for (const t of [
      Terrain.DeepSea,
      Terrain.River,
      Terrain.Swamp,
      Terrain.Crater,
      Terrain.Road,
      Terrain.Rubble,
      Terrain.Grass,
    ]) {
      expect(shelledTerrain(t)).toBeNull();
    }
  });
});

describe('minedTerrain', () => {
  // Locks terrain.ts:61-69
  it('DeepSea → null', () => {
    expect(minedTerrain(Terrain.DeepSea)).toBeNull();
  });
  it('River → null', () => {
    expect(minedTerrain(Terrain.River)).toBeNull();
  });
  it('all others → Crater', () => {
    for (const t of [
      Terrain.Swamp,
      Terrain.Crater,
      Terrain.Road,
      Terrain.Forest,
      Terrain.Rubble,
      Terrain.Grass,
      Terrain.Building,
      Terrain.ShotBuilding,
      Terrain.BoatTile,
    ]) {
      expect(minedTerrain(t)).toBe(Terrain.Crater);
    }
  });
});

describe('isWater', () => {
  it('DeepSea, River, BoatTile → true', () => {
    expect(isWater(Terrain.DeepSea)).toBe(true);
    expect(isWater(Terrain.River)).toBe(true);
    expect(isWater(Terrain.BoatTile)).toBe(true);
  });
  it('all others → false', () => {
    for (const t of [
      Terrain.Swamp,
      Terrain.Crater,
      Terrain.Road,
      Terrain.Forest,
      Terrain.Rubble,
      Terrain.Grass,
      Terrain.Building,
      Terrain.ShotBuilding,
    ]) {
      expect(isWater(t)).toBe(false);
    }
  });
});
