/**
 * Mutable tick-time state shared across all simulation subsystems.
 *
 * The World class holds the authoritative copies of these collections;
 * SimContext is the typed interface through which subsystem classes
 * read and write them during a tick. Systems receive the World instance
 * (which satisfies this interface) in their constructor.
 */
import type { Base, GameEvent, Pillbox, Shell, Tank } from '@bolo/shared';
import type { Faction } from '@bolo/shared';
import type { StatEvent, TankInput } from './world';

export interface SimContext {
  // entity collections
  tick: number;
  terrain: Uint8Array;
  mines: Uint8Array;
  bases: Base[];
  pills: Pillbox[];
  tanks: Map<number, Tank>;
  shells: Shell[];

  // per-tank input/state maps
  inputs: Map<number, TankInput>;
  nudges: Map<number, number>;
  refuelTimers: Map<number, number>;
  regenTimers: Map<number, number>;

  // per-tick accumulators
  events: GameEvent[];
  stats: StatEvent[];
  terrainChanges: [number, number, number][];
  mineChanges: [number, number, number][];
  pillsChanged: boolean;
  basesChanged: boolean;
}

/** Reset all per-tick accumulators to empty/falsy. Called at the start of doTick. */
export function resetAccumulators(ctx: SimContext): void {
  ctx.events = [];
  ctx.stats = [];
  ctx.terrainChanges = [];
  ctx.mineChanges = [];
  ctx.pillsChanged = false;
  ctx.basesChanged = false;
}
