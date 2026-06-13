/**
 * Interface that simulation subsystems use to interact with the World.
 * The World class implements this, giving systems access to shared state
 * (via SimContext fields) and cross-system operations.
 */
import type { Tank } from '@bolo/shared';
import type { SimContext } from './context';

export interface WorldHost extends SimContext {
  /** ID counter for generating unique shell/pill IDs. */
  nextId: number;

  // queries
  tileAt(x: number, y: number): import('@bolo/shared').Terrain;

  // mutation helpers
  setTerrain(x: number, y: number, t: import('@bolo/shared').Terrain): void;
  setMine(x: number, y: number, m: import('@bolo/shared').MineState): void;

  // damage system (owned by DamageSystem, exposed via World delegation)
  damageTank(tank: Tank, amount: number, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void;
  killTank(tank: Tank, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void;
  detonateMine(x: number, y: number): void;
  handleTileTransitions(tank: Tank, prevX: number, prevY: number): void;
  dropCarriedPill(tank: Tank): void;

  // pill system (owned by PillSystem, exposed via World delegation)
  pillCooldownFor(pill: import('@bolo/shared').Pillbox): number;

  // builder system (owned by BuilderSystem, exposed via World delegation)
  killBuilder(tank: Tank): void;
}
