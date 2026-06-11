import type { Faction, Owner } from './constants';

/** Orders the builder can carry out, straight from original Bolo's build menu. */
export type BuilderOrderKind =
  | 'harvest' // chop a forest tile into trees
  | 'road'
  | 'wall'
  | 'boat'
  | 'pillbox' // place the carried pillbox (or repair a friendly one on that tile)
  | 'mine';

export type BuilderPhase = 'in_tank' | 'outbound' | 'working' | 'returning' | 'dead';

export interface BuilderState {
  phase: BuilderPhase;
  x: number;
  y: number;
  order: { kind: BuilderOrderKind; tx: number; ty: number } | null;
  /** seconds of work remaining when phase === 'working' */
  workLeft: number;
  /** server tick at which a dead builder respawns in the tank */
  respawnTick: number;
}

export interface Tank {
  id: number;
  /** atproto DID for humans and external bots; 'npc:<n>' for garrison tanks */
  did: string;
  handle: string;
  faction: Faction;
  npc: boolean;
  x: number;
  y: number;
  dir: number; // radians, 0 = east
  speed: number; // current scalar speed, tiles/sec
  armor: number;
  shells: number;
  mines: number;
  trees: number;
  onBoat: boolean;
  alive: boolean;
  respawnTick: number;
  fireCooldown: number;
  /** id of a carried (captured) pillbox, or null */
  carriedPill: number | null;
  builder: BuilderState;
  kills: number;
  deaths: number;
  caps: number; // bases + pillboxes captured
}

export interface Shell {
  id: number;
  x: number;
  y: number;
  dir: number;
  /** 'neutral' for shells fired by hostile neutral pillboxes (they hate everyone) */
  faction: Owner;
  ownerTank: number;
  /** distance remaining before it falls inert */
  range: number;
}

export interface Pillbox {
  id: number;
  x: number; // tile coords (pillboxes occupy a tile)
  y: number;
  owner: Owner;
  hp: number;
  /** true while being carried in a tank (not on the map) */
  inTank: boolean;
  cooldown: number;
}

export interface Base {
  id: number;
  x: number; // tile coords
  y: number;
  owner: Owner;
  armorStock: number;
  shellStock: number;
  mineStock: number;
}

export interface WarInfo {
  warNumber: number;
  seed: number;
  startedAt: number; // epoch ms
  phase: 'active' | 'intermission';
  /** when phase === 'intermission': epoch ms at which the next war begins */
  nextWarAt: number | null;
  baseCounts: Record<Owner, number>;
}

export interface WarRecord {
  warNumber: number;
  seed: number;
  winner: Faction;
  startedAt: number;
  endedAt: number;
  durationMinutes: number;
}

/** Per-DID persistent profile, kept across wars. */
export interface PlayerProfile {
  did: string;
  handle: string;
  faction: Faction;
  isBot: boolean;
  kills: number;
  deaths: number;
  caps: number;
  warsFought: number;
  firstSeen: number;
  lastSeen: number;
}
