/**
 * The wire protocol: JSON text frames over a WebSocket at /ws.
 * The same protocol serves human clients, external bots and spectators;
 * see docs/PROTOCOL.md for the prose version.
 */
import type { EmoteKind, Faction, Owner } from './constants';import type { Base, BuilderOrderKind, Pillbox, Tank, WarInfo, WarRecord } from './types';

// ---------- client -> server ----------

export interface HelloMsg {
  t: 'hello';
  /** session token from /api/login/verify (or /api/login/dev). Omit for spectators. */
  token?: string;
  role: 'player' | 'spectator';
}

/**
 * Held-control input, Bolo style: the tank keeps doing this until told
 * otherwise. Send a new input message only when a control changes.
 * Values are clamped to [-1, 1]; fractional turn allows fine aiming.
 */
export interface InputMsg {
  t: 'input';
  accel: number;
  turn: number; // positive turns clockwise (screen-space, y-down)
  fire: boolean;
}

export interface BuilderMsg {
  t: 'builder';
  order: BuilderOrderKind;
  x: number; // target tile
  y: number;
}

export interface BuilderRecallMsg {
  t: 'builder_recall';
}

export interface RespawnMsg {
  t: 'respawn';
  baseId?: number; // a friendly base to spawn at; otherwise server picks
}

export interface ChatMsg {
  t: 'chat';
  text: string;
}

export interface EmoteMsg {
  t: 'emote';
  /** one of the EMOTES list */
  kind: string;
}

export interface PingMsg {
  t: 'ping';
  n: number;
}

export type ClientMsg =
  | HelloMsg
  | InputMsg
  | BuilderMsg
  | BuilderRecallMsg
  | RespawnMsg
  | ChatMsg
  | EmoteMsg
  | PingMsg;

// ---------- server -> client ----------

/** Compact tank view sent every tick for tanks inside your view radius. */
export interface TankView {
  id: number;
  handle: string;
  faction: Faction;
  npc: boolean;
  x: number;
  y: number;
  dir: number;
  speed: number;
  alive: boolean;
  onBoat: boolean;
  /** only present for YOUR tank */
  armor?: number;
  shells?: number;
  mines?: number;
  trees?: number;
  carriedPill?: number | null;
  /** seconds until respawn; only on YOUR tank while dead */
  respawnIn?: number;
}

export interface BuilderView {
  tankId: number;
  faction: Faction;
  phase: string;
  x: number;
  y: number;
}

export interface ShellView {
  id: number;
  x: number;
  y: number;
  dir: number;
  /** who fired it ('neutral' = a hostile neutral pillbox) — drives tracer color */
  f: Owner;
}

export type GameEvent =
  | { e: 'kill'; killer: string; victim: string; cause: 'shell' | 'mine' | 'pillbox' | 'sea' }
  | { e: 'base_captured'; baseId: number; by: Owner; handle: string }
  | { e: 'pill_captured'; pillId: number; by: Faction; handle: string }
  | { e: 'pill_placed'; pillId: number; x: number; y: number; by: Faction }
  | { e: 'builder_killed'; tankId: number }
  | { e: 'boom'; x: number; y: number; kind: 'shell' | 'mine' };

export interface WelcomeMsg {
  t: 'welcome';
  you: { did: string; handle: string; faction: Faction; tankId: number } | null; // null for spectators
  war: WarInfo;
  map: { w: number; h: number; terrain: string /* base64 Uint8Array */ };
  /** mine tiles visible to your faction (empty for spectators) */
  mines: [number, number][];
  pills: Pillbox[];
  bases: Base[];
  tick: number;
}

/** Per-tick state for players. Entities outside your view radius are omitted. */
export interface StateMsg {
  t: 'state';
  tick: number;
  tanks: TankView[];
  shells: ShellView[];
  builders: BuilderView[];
  /** pillboxes/bases included only when changed */
  pills?: Pillbox[];
  bases?: Base[];
  /** terrain edits this tick: [x, y, newTerrain] */
  terrain?: [number, number, number][];
  /** mine tiles your faction can see, sent when changed: [x, y, present] */
  mines?: [number, number, 0 | 1][];
  events?: GameEvent[];
}

/** Low-rate world overview for spectators (and the public map page). */
export interface SpectateMsg {
  t: 'spectate';
  tick: number;
  war: WarInfo;
  tanks: { x: number; y: number; faction: Faction; handle: string; npc: boolean; alive: boolean }[];
  pills: Pillbox[];
  bases: Base[];
  /** terrain edits since last spectate frame */
  terrain?: [number, number, number][];
  online: { players: number; spectators: number };
}

export interface ChatBroadcastMsg {
  t: 'chat';
  from: string;
  faction: Faction | 'system';
  text: string;
}

export interface WarOverMsg {
  t: 'war_over';
  winner: Faction;
  record: WarRecord;
  nextWarAt: number;
}

export interface NewWarMsg {
  t: 'new_war';
  war: WarInfo;
}

/** A tank emoting; clients float the bubble for EMOTE_SHOW_MS. */
export interface EmoteBroadcastMsg {
  t: 'emoted';
  tankId: number;
  kind: EmoteKind;
}

export interface PongMsg {
  t: 'pong';
  n: number;
}

export interface ErrorMsg {
  t: 'error';
  code:
    | 'auth_failed'
    | 'bad_message'
    | 'not_in_game'
    | 'rate_limited'
    | 'builder_busy'
    | 'invalid_order';
  msg: string;
}

export type ServerMsg =
  | WelcomeMsg
  | StateMsg
  | SpectateMsg
  | ChatBroadcastMsg
  | EmoteBroadcastMsg
  | WarOverMsg
  | NewWarMsg
  | PongMsg
  | ErrorMsg;
