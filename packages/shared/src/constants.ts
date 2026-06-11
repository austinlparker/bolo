// World geometry. All distances are in tile units; positions are floats.
export const MAP_SIZE = 256;

// Simulation runs at a fixed tick on the server. Clients interpolate.
export const TICK_HZ = 10;
export const TICK_MS = 1000 / TICK_HZ;
export const DT = 1 / TICK_HZ;

// Spectators get a low-rate, whole-world feed.
export const SPECTATOR_HZ = 1;

export const FACTIONS = ['dawn', 'dusk'] as const;
export type Faction = (typeof FACTIONS)[number];
export type Owner = Faction | 'neutral';

export const FACTION_NAMES: Record<Faction, string> = {
  dawn: 'Dawn Concord',
  dusk: 'Dusk Pact',
};

// --- Tank ---
export const TANK_RADIUS = 0.38;
export const TANK_MAX_SPEED = 4.0; // tiles/sec at 100% terrain speed (road)
export const TANK_ACCEL = 6.0; // tiles/sec^2
export const TANK_BRAKE = 10.0;
export const TANK_TURN_RATE = 3.2; // radians/sec
export const TANK_MAX_ARMOR = 40;
export const TANK_MAX_SHELLS = 40;
export const TANK_MAX_MINES = 40;
export const TANK_MAX_TREES = 40;
export const TANK_START_ARMOR = 40;
export const TANK_START_SHELLS = 20;
export const TANK_START_MINES = 4;
export const TANK_FIRE_COOLDOWN = 0.35; // seconds between shots
export const TANK_RESPAWN_SECONDS = 6;
export const BOAT_SPEED = 3.2; // tiles/sec on water when on a boat

// --- Shells ---
export const SHELL_SPEED = 9.0; // tiles/sec
export const SHELL_RANGE = 7.0; // tiles
export const SHELL_DAMAGE = 5;
export const SHELL_RADIUS = 0.12;

// --- Mines ---
export const MINE_DAMAGE = 20;
export const MINE_TRIGGER_RADIUS = 0.45;

// --- Pillboxes ---
export const PILL_MAX_HP = 75;
export const PILL_RANGE = 8.0;
// Cooldown scales with anger: a freshly damaged pillbox shoots much faster.
export const PILL_COOLDOWN_CALM = 2.0; // seconds at full health
export const PILL_COOLDOWN_ANGRY = 0.4; // seconds at 1 hp
export const PILL_REGEN_SECONDS = 4; // 1 hp per this many seconds
export const PILL_REPAIR_TREES = 4; // trees per 15 hp repaired
export const PILL_REPAIR_HP = 15;

// --- Bases (the control points of the war) ---
export const BASE_MAX_ARMOR_STOCK = 90;
export const BASE_MAX_SHELL_STOCK = 90;
export const BASE_MAX_MINE_STOCK = 40;
export const BASE_START_STOCK = 0.5; // fraction of max for neutral bases at war start
export const BASE_REFUEL_RADIUS = 0.75;
export const BASE_REFUEL_INTERVAL = 0.5; // seconds per unit transferred
export const BASE_SIEGE_DRAIN_INTERVAL = 0.5; // enemy on pad drains 1 armor stock per interval
export const BASE_SIEGE_DAMAGE = 1; // ...and takes this much damage per interval
export const BASE_REGEN_INTERVAL = 8; // seconds per unit of passive restock when owned

// --- Builder (the engineer / "man") ---
export const BUILDER_SPEED = 1.6; // tiles/sec on land
export const BUILDER_WATER_SPEED = 0.5;
export const BUILDER_WORK_SECONDS = 2.0; // per job
export const BUILDER_RESPAWN_SECONDS = 30;
export const BUILDER_MAX_RANGE = 12; // max order distance from tank
export const TREES_PER_FOREST_TILE = 4;
export const COST_ROAD = 2;
export const COST_WALL = 2;
export const COST_WALL_REPAIR = 1;
export const COST_BOAT = 10;
export const COST_PILL_PLACE = 2;

// --- Vision ---
export const FOREST_HIDE_RANGE = 3; // enemies within this range still see a hidden tank
export const PLAYER_VIEW_RADIUS = 24; // server only sends entities within this range

// --- War lifecycle ---
export const WAR_MIN_MINUTES = 10; // a war cannot end before this
export const INTERMISSION_SECONDS = 120;
export const BASES_PER_FACTION_AT_START = 3;
export const TOTAL_BASES = 14;
export const TOTAL_PILLS = 18;

// --- NPC garrison ---
// Each faction is kept at this many active tanks (humans + NPCs combined),
// so the world stays alive when nobody is online.
export const NPC_MIN_PER_FACTION = 3;
export const NPC_MAX_TOTAL = 12;
