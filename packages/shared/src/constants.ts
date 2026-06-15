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
// Handling numbers below were dialed in on the /rig comparison harness
// (four sim variants, same inputs): punchy off the line with a soft top
// end, and turns that ramp fast enough to feel connected to the key.
export const TANK_MAX_SPEED = 5.4; // tiles/sec at 100% terrain speed (road)
export const TANK_ACCEL = 11; // tiles/sec^2, at standstill
// Tapers acceleration as speed approaches max: effective accel is
// TANK_ACCEL * (1 - curve * speed/maxSpeed). 0 = constant (linear ramp),
// higher = punchy start that eases into top speed.
export const TANK_ACCEL_CURVE = 0.4;
export const TANK_BRAKE = 9.5;
export const TANK_TURN_RATE = 3.2; // radians/sec, at full ramp
// Rotational inertia: turn rate ramps UP at this accel (full rate in ~0.32s),
// but slowing/releasing/reversing is instant so aim never overshoots.
export const TANK_TURN_ACCEL = 16; // radians/sec^2
export const TANK_MAX_ARMOR = 40;
export const TANK_MAX_SHELLS = 40;
export const TANK_MAX_MINES = 40;
export const TANK_MAX_TREES = 40;
export const TANK_START_ARMOR = 40;
export const TANK_START_SHELLS = 20;
export const TANK_START_MINES = 4;
export const TANK_FIRE_COOLDOWN = 0.35; // seconds between shots
export const TANK_RESPAWN_SECONDS = 6;
// Reverse gear: top speed backing up, as a fraction of forward max. Slow
// enough that reversing is an escape maneuver, not a viable way to fight.
export const TANK_REVERSE_FACTOR = 0.55;
// Faster than road speed: committing 10 trees and an exposed crossing to
// the open water should pay off (at 3.2 a boat was slower than driving;
// re-raised when the rig retune took road speed to 5.4).
export const BOAT_SPEED = 5.8; // tiles/sec on water when on a boat

// --- Shells ---
// Ranges are scaled up from original Bolo's (7/8) for the larger viewport;
// pillboxes deliberately OUTRANGE tanks so assaulting one stays dangerous.
export const SHELL_SPEED = 9.0; // tiles/sec
export const SHELL_RANGE = 9.0; // tiles, max; players range down with the mouse buttons
export const SHELL_DAMAGE = 5;

// --- Mines ---
export const MINE_DAMAGE = 20;

// --- Pillboxes ---
export const PILL_MAX_HP = 75;
export const PILL_RANGE = 10.0; // > SHELL_RANGE: see note above
// Cooldown scales with anger: a freshly damaged pillbox shoots much faster.
export const PILL_COOLDOWN_CALM = 2.0; // seconds at full health
export const PILL_COOLDOWN_ANGRY = 0.4; // seconds at 1 hp
export const PILL_REGEN_SECONDS = 4; // 1 hp per this many seconds
export const PILL_REPAIR_TREES = 4; // trees per 15 hp repaired
export const PILL_REPAIR_HP = 15;

// --- Bases (the control points of the war) ---
// A base has two separate gauges:
//  - hp ("fortification"): its defenses. Shells and sieging tanks wear it
//    down; at 0 the base goes NEUTRAL and anyone can drive on to claim it.
//    Owned, uncontested bases fortify back up over time.
//  - stocks (armor/shell/mine): the supplies it dispenses to friendly tanks.
//    Restock and refuel rates scale with hp — a battered base is a slow one.
export const BASE_MAX_HP = 100;
export const BASE_CAPTURE_HP = 25; // fortification granted the moment a base is claimed
export const BASE_NEUTRAL_START_HP = 50; // unclaimed bases at war start
export const BASE_FORTIFY_INTERVAL = 2; // seconds per hp while owned & uncontested
export const BASE_SUPPLY_FLOOR = 0.25; // supply-rate multiplier at 0 hp (1.0 at full hp)
export const BASE_MAX_ARMOR_STOCK = 90;
export const BASE_MAX_SHELL_STOCK = 90;
export const BASE_MAX_MINE_STOCK = 40;
export const BASE_START_STOCK = 0.5; // fraction of max for neutral bases at war start
export const BASE_REFUEL_RADIUS = 0.75;
export const BASE_REFUEL_INTERVAL = 0.5; // seconds per unit transferred, at full hp
export const BASE_SIEGE_DRAIN_INTERVAL = 0.5; // enemy on pad drains 1 hp per interval
export const BASE_SIEGE_DAMAGE = 1; // ...and takes this much damage per interval
export const BASE_REGEN_INTERVAL = 8; // seconds per unit of passive restock when owned, at full hp

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
// Wars end by conquest only — there is no time cap. Two systems keep a war
// from stalemating forever (symmetric garrisons once made all-14-bases a
// random walk: production saw a 226-minute war and an 8-hour 7v7 deadlock):
//  - DOMINANCE: hold >= DOMINANCE_BASES continuously for DOMINANCE_MINUTES
//    and the war is yours, ending the last-base turtle grind. A visible
//    countdown gives the defenders a clear "break this or lose" objective.
//  - ATTRITION: past ATTRITION_AFTER_MINUTES, base fortification and
//    restocking decay toward ATTRITION_FLOOR over ATTRITION_RAMP_MINUTES —
//    supply lines exhaust, defense weakens, and fronts start to move.
export const WAR_MIN_MINUTES = 10; // a war cannot end before this
export const DOMINANCE_BASES = 12;
export const DOMINANCE_MINUTES = 10;
export const ATTRITION_AFTER_MINUTES = 90;
export const ATTRITION_RAMP_MINUTES = 60;
export const ATTRITION_FLOOR = 0.25;
export const INTERMISSION_SECONDS = 120;
export const BASES_PER_FACTION_AT_START = 3;
export const TOTAL_BASES = 14;
export const TOTAL_PILLS = 18;

// --- NPC garrison ---
// Each faction is kept at this many active tanks (humans + NPCs combined),
// so the world stays alive when nobody is online.
export const NPC_MIN_PER_FACTION = 3;
export const NPC_MAX_TOTAL = 12;

// --- emotes ---
export const EMOTES = ['happy', 'angry', 'sad', 'heart', 'laugh', 'alert', 'question', 'sleep'] as const;
export type EmoteKind = (typeof EMOTES)[number];
export const EMOTE_COOLDOWN_MS = 1500;
export const EMOTE_SHOW_MS = 2600;

// --- Bounties ---
// Auto-placed on mutual kills; players can escalate by pressing B.
export const BOUNTY_AUTO_REWARD = 1; // bonus kill credits from auto-placement
export const BOUNTY_TTL_TICKS = TICK_HZ * 300; // 5 minutes at 10Hz
export const BOUNTY_MAX_ESCALATION = 3; // max bonus reward per bounty from escalation
