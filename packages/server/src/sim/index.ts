/**
 * Barrel export for the simulation package.
 *
 * Re-exports the public API of the World class, NPC controller, and
 * shared types used by the Durable Object layer.
 */
export { World } from './world';
export type { TickResult, TankInput, StatEvent, ShotStat, KillStat } from './world';
export { NpcController } from './npc';
