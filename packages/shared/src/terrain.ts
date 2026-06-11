/**
 * Terrain follows the original Bolo set. Each tile of the map is one byte.
 * Mines live in a separate per-tile layer (see MineLayer) like Bolo's
 * hidden-mine overlay.
 */
export enum Terrain {
  DeepSea = 0,
  River = 1,
  Swamp = 2,
  Crater = 3,
  Road = 4,
  Forest = 5,
  Rubble = 6,
  Grass = 7,
  Building = 8,
  ShotBuilding = 9, // a damaged wall: passable rubble that can be repaired
  BoatTile = 10, // a built boat waiting on water; drive on to embark
}

export interface TerrainProps {
  name: string;
  /** Tank speed multiplier; 0 = impassable to tanks. */
  tankSpeed: number;
  /** Builder speed multiplier; 0 = impassable to the builder. */
  builderSpeed: number;
  /** Shells pass over everything except buildings, which they destroy. */
  blocksShells: boolean;
}

export const TERRAIN: Record<Terrain, TerrainProps> = {
  [Terrain.DeepSea]: { name: 'deep sea', tankSpeed: 0, builderSpeed: 0, blocksShells: false },
  [Terrain.River]: { name: 'river', tankSpeed: 0.25, builderSpeed: 0.3, blocksShells: false },
  [Terrain.Swamp]: { name: 'swamp', tankSpeed: 0.25, builderSpeed: 0.5, blocksShells: false },
  [Terrain.Crater]: { name: 'crater', tankSpeed: 0.25, builderSpeed: 0.5, blocksShells: false },
  [Terrain.Road]: { name: 'road', tankSpeed: 1.0, builderSpeed: 1.0, blocksShells: false },
  [Terrain.Forest]: { name: 'forest', tankSpeed: 0.5, builderSpeed: 0.75, blocksShells: false },
  [Terrain.Rubble]: { name: 'rubble', tankSpeed: 0.25, builderSpeed: 0.5, blocksShells: false },
  [Terrain.Grass]: { name: 'grass', tankSpeed: 0.75, builderSpeed: 1.0, blocksShells: false },
  [Terrain.Building]: { name: 'building', tankSpeed: 0, builderSpeed: 0, blocksShells: true },
  [Terrain.ShotBuilding]: { name: 'shot building', tankSpeed: 0.25, builderSpeed: 0.5, blocksShells: false },
  [Terrain.BoatTile]: { name: 'boat', tankSpeed: 0.25, builderSpeed: 0.3, blocksShells: false },
};

/** What a shell does to the tile it detonates on. Returns the new terrain, or null for no change. */
export function shelledTerrain(t: Terrain): Terrain | null {
  switch (t) {
    case Terrain.Building:
      return Terrain.ShotBuilding;
    case Terrain.ShotBuilding:
      return Terrain.Rubble;
    case Terrain.Forest:
      return Terrain.Grass;
    case Terrain.BoatTile:
      return Terrain.River;
    default:
      return null;
  }
}

/** What a mine explosion does to a tile: everything organic becomes a crater. */
export function minedTerrain(t: Terrain): Terrain | null {
  switch (t) {
    case Terrain.DeepSea:
    case Terrain.River:
      return null;
    default:
      return Terrain.Crater;
  }
}

export function isWater(t: Terrain): boolean {
  return t === Terrain.DeepSea || t === Terrain.River || t === Terrain.BoatTile;
}

/** Mine layer values. Neutral mines are seeded by mapgen and hidden from everyone. */
export enum MineState {
  None = 0,
  Dawn = 1,
  Dusk = 2,
  Neutral = 3,
}

// --- Byte-array <-> base64 helpers (work in Workers, browsers and Node) ---
export function bytesToBase64(bytes: Uint8Array): string {
  let bin = '';
  const chunk = 0x8000;
  for (let i = 0; i < bytes.length; i += chunk) {
    bin += String.fromCharCode(...bytes.subarray(i, i + chunk));
  }
  return btoa(bin);
}

export function base64ToBytes(b64: string): Uint8Array<ArrayBuffer> {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
