/**
 * The wire protocol: JSON text frames over a WebSocket at /ws.
 * The same protocol serves human clients, external bots and spectators;
 * see docs/PROTOCOL.md for the prose version.
 */
import type { EmoteKind, Faction, Owner } from './constants';
import type { Base, BuilderOrderKind, Pillbox, PlayerProfile, Tank, WarInfo, WarRecord } from './types';

/**
 * Bumped on breaking wire changes. The server stamps it on `welcome`; a
 * client built against an older version reloads to pick up the new bundle
 * (deploys iterate fast and stale tabs otherwise play a skewed protocol —
 * an early playtester's whole first session was an unversioned old bundle).
 */
export const PROTOCOL_VERSION = 4;

// ---------- client -> server ----------

export interface HelloMsg {
  t: 'hello';
  /** session token from /api/login/verify (or /api/login/dev). Omit for spectators. */
  token?: string;
  role: 'player' | 'spectator';
  /** what's driving this player — segments balance telemetry (accuracy by input kind) */
  client?: 'keyboard' | 'touch' | 'bot';
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
  /**
   * Fine-aim tap: a discrete extra rotation in radians, queued server-side
   * and drained at the standard turn rate (so taps are lossless at any tick
   * rate but can never out-turn a held key). Clamped per message.
   */
  nudge?: number;
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

/** Set the gun range: shells detonate at this distance (classic Bolo range
 * control — lob short of obstacles or reach out to max). Clamped server-side
 * to [1, SHELL_RANGE]. Sticky until changed; echoed back on your TankView. */
export interface RangeMsg {
  t: 'range';
  range: number;
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

/** Escalate a bounty on a target (adds +1 bonus reward). */
export interface BountyMsg {
  t: 'bounty';
  targetDid: string;
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
  | RangeMsg
  | RespawnMsg
  | ChatMsg
  | EmoteMsg
  | BountyMsg
  | PingMsg;

// ---------- server -> client ----------

/** Compact tank view sent every tick for tanks inside your view radius. */
export interface TankView {
  id: number;
  handle: string;
  /** atproto DID for human/bot tanks within view radius; omitted for NPCs and far tanks */
  did?: string;
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
  /** current gun range setting; only on YOUR tank */
  gunRange?: number;
  /** this-life session stats; only on YOUR tank (for live rank progress) */
  kills?: number;
  caps?: number;
  /** true if this tank is driven by your Bluesky mutual */
  mutual?: boolean;
  /** true if this tank is a bounty target for the viewer */
  bounty?: boolean;
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
  | { e: 'kill'; killer: string; victim: string; cause: 'shell' | 'mine' | 'pillbox' | 'sea'; killerDid?: string; victimDid?: string; x?: number; y?: number }
  | { e: 'base_captured'; baseId: number; by: Owner; handle: string; byDid?: string; x?: number; y?: number }
  | { e: 'base_neutralized'; baseId: number; by: Owner }
  /** dominance countdown started (endsAt set) or broken (faction null) */
  | { e: 'dominance'; faction: Faction | null; endsAt: number | null }
  | { e: 'pill_captured'; pillId: number; by: Faction; handle: string }
  | { e: 'pill_placed'; pillId: number; x: number; y: number; by: Faction }
  | { e: 'builder_killed'; tankId: number }
  | { e: 'boom'; x: number; y: number; kind: 'shell' | 'mine' }
  | { e: 'revenge'; killerHandle: string; victimHandle: string }
  | { e: 'payback'; killerHandle: string; victimHandle: string }
  | { e: 'mutual_killed'; killerDid: string; killerHandle: string; victimDid: string; victimHandle: string; x: number; y: number; cause: string }
  | { e: 'mutual_capture'; baseId: number; byDid: string; byHandle: string; x: number; y: number };

export interface WelcomeMsg {
  t: 'welcome';
  /** server's PROTOCOL_VERSION; clients reload when they're behind */
  v?: number;
  you: { did: string; handle: string; faction: Faction; tankId: number } | null; // null for spectators
  /** your persistent career stats (players only) */
  profile?: PlayerProfile;
  war: WarInfo;
  map: { w: number; h: number; terrain: string /* base64 Uint8Array */ };
  /** mine tiles visible to your faction (empty for spectators) */
  mines: [number, number][];
  pills: Pillbox[];
  bases: Base[];
  tick: number;
  /** your top nemesis if one exists */
  nemesis?: { did: string; handle: string; killedBy: number; youKilled: number; online: boolean };
  /** DIDs of your currently-connected Bluesky mutuals */
  mutuals?: string[];
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
    | 'invalid_order'
    | 'at_capacity';
  msg: string;
}

/**
 * Social identity data for connected players (avatars, display names).
 * Sent on connect and when new players join so the client can render
 * avatars in chat, kill feed, and tank labels.
 */
export interface SocialDataMsg {
  t: 'social_data';
  /** keyed by DID → profile info */
  profiles: Record<string, { avatar?: string; displayName?: string; handle?: string }>;
}

/** Sent when a player's mutual set changes (someone connects/disconnects). */
export interface MutualsUpdateMsg {
  t: 'mutuals';
  /** DIDs of currently-connected mutuals */
  dids: string[];
}

/** Sent on connect and when bounties change. Lists active bounty targets. */
export interface BountyActiveMsg {
  t: 'bounty_active';
  bounties: { targetDid: string; targetHandle: string; reward: number; victimHandle: string }[];
}

/** Broadcast when a bounty is claimed. Social proof for all players. */
export interface BountyClaimedMsg {
  t: 'bounty_claimed';
  targetDid: string;
  targetHandle: string;
  claimerDid: string;
  claimerHandle: string;
  reward: number;
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
  | ErrorMsg
  | SocialDataMsg
  | MutualsUpdateMsg
  | BountyActiveMsg
  | BountyClaimedMsg;
