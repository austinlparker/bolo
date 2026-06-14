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
  /** current turn rate, radians/sec — ramps toward input.turn * TANK_TURN_RATE */
  turnSpeed: number;
  armor: number;
  shells: number;
  mines: number;
  trees: number;
  onBoat: boolean;
  alive: boolean;
  /** shells detonate at this distance (player-adjustable, <= SHELL_RANGE) */
  gunRange: number;
  respawnTick: number;
  fireCooldown: number;
  /** id of a carried (captured) pillbox, or null */
  carriedPill: number | null;
  builder: BuilderState;
  kills: number;
  deaths: number;
  caps: number; // bases + pillboxes captured
  /** input kind from hello ('npc' for garrison tanks) — telemetry segmentation */
  client: string;
  /** server-only: tick of first damage in the current engagement (TTK telemetry) */
  engagedTick?: number;
}

export interface Shell {
  id: number;
  x: number;
  y: number;
  dir: number;
  /** 'neutral' for shells fired by hostile neutral pillboxes (they hate everyone) */
  faction: Owner;
  ownerTank: number;
  /** distance remaining before it detonates */
  range: number;
  /** the range it was fired with (for travel-distance telemetry) */
  fired: number;
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
  /** fortification 0..BASE_MAX_HP; at 0 the base goes neutral */
  hp: number;
  armorStock: number;
  shellStock: number;
  mineStock: number;
}

/** A faction holding >= DOMINANCE_BASES; they win at endsAt unless broken. */
export interface DominanceInfo {
  faction: Faction;
  /** epoch ms at which the dominant faction wins */
  endsAt: number;
}

export interface WarInfo {
  warNumber: number;
  seed: number;
  startedAt: number; // epoch ms
  phase: 'active' | 'intermission';
  /** when phase === 'intermission': epoch ms at which the next war begins */
  nextWarAt: number | null;
  baseCounts: Record<Owner, number>;
  /** present while a dominance-victory countdown is running */
  dominance?: DominanceInfo | null;
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
  /** wars this player actually fought in (connected while the war ran) */
  warsFought: number;
  /** ...and how many of those their faction won */
  warsWon: number;
  firstSeen: number;
  lastSeen: number;
}
