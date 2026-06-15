/**
 * Per-tick uniform-grid spatial index for proximity queries.
 *
 * Tanks are binned by tile coordinate. Proximity queries check only the
 * query tile and its 8 neighbors (3×3 neighborhood), turning O(n²) scans
 * into O(1) lookups.
 *
 * The grid is a flat Int32Array of MAP_SIZE*MAP_SIZE entries, each holding
 * a "head" index into parallel arrays that form a linked-list of tanks.
 * This avoids per-tick Map/array allocations entirely.
 *
 * Rebuilt from scratch each tick — the per-tank overhead is trivially small
 * for the entity counts in this game (12-16 tanks).
 */
import { MAP_SIZE } from '@bolo/shared';
import type { Tank } from '@bolo/shared';

const W = MAP_SIZE;
const N_TILES = W * W;

// Sentinel: no tank in this slot
const NONE = -1;

export class SpatialIndex {
  // Tile → head tank-slot index (linked list head), rebuilt each tick
  private grid: Int32Array;
  // Per-slot linked list: next[slot] points to the next tank in the same tile
  private next: Int32Array;
  // Per-slot tank reference
  private tanks: (Tank | null)[];
  // Current count of registered tanks
  private count = 0;
  // Maximum capacity (pre-allocated)
  private readonly capacity: number;

  constructor(capacity = 64) {
    this.capacity = capacity;
    this.grid = new Int32Array(N_TILES).fill(NONE);
    this.next = new Int32Array(capacity);
    this.tanks = new Array(capacity).fill(null);
  }

  /** Clear the index for a new tick. O(N_TILES) but memset-fast on typed arrays. */
  clear(): void {
    this.grid.fill(NONE);
    this.count = 0;
  }

  /**
   * Register a tank at its current tile position. Each tank occupies one slot.
   * Returns the slot index (for potential later removal, though we rebuild
   * from scratch each tick so this is rarely needed).
   */
  insert(tank: Tank): number {
    const slot = this.count++;
    if (slot >= this.capacity) {
      // Grow arrays if needed (rare — capacity 64 covers 12-16 tanks)
      const newCap = this.capacity * 2;
      const newNext = new Int32Array(newCap);
      newNext.set(this.next);
      this.next = newNext;
      this.tanks.length = newCap;
      this.tanks.fill(null, this.capacity);
    }
    this.tanks[slot] = tank;
    const tx = Math.max(0, Math.min(W - 1, Math.floor(tank.x)));
    const ty = Math.max(0, Math.min(W - 1, Math.floor(tank.y)));
    const tileIdx = ty * W + tx;
    this.next[slot] = this.grid[tileIdx];
    this.grid[tileIdx] = slot;
    return slot;
  }

  /**
   * Iterate all tanks in the 3×3 neighborhood around a world position.
   * Calls `fn(tank)` for each; stops early if `fn` returns true.
   */
  forEachNearby(x: number, y: number, fn: (tank: Tank) => boolean | void): void {
    const cx = Math.max(0, Math.min(W - 1, Math.floor(x)));
    const cy = Math.max(0, Math.min(W - 1, Math.floor(y)));
    const x0 = Math.max(0, cx - 1);
    const x1 = Math.min(W - 1, cx + 1);
    const y0 = Math.max(0, cy - 1);
    const y1 = Math.min(W - 1, cy + 1);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        let slot = this.grid[ty * W + tx];
        while (slot !== NONE) {
          const tank = this.tanks[slot]!;
          if (fn(tank)) return;
          slot = this.next[slot];
        }
      }
    }
  }

  /**
   * Iterate all tanks in a square radius around a world position.
   * More general than forEachNearby for larger radii.
   */
  forEachInRadius(x: number, y: number, radiusTiles: number, fn: (tank: Tank) => boolean | void): void {
    const cx = Math.floor(x);
    const cy = Math.floor(y);
    const x0 = Math.max(0, cx - radiusTiles);
    const x1 = Math.min(W - 1, cx + radiusTiles);
    const y0 = Math.max(0, cy - radiusTiles);
    const y1 = Math.min(W - 1, cy + radiusTiles);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        let slot = this.grid[ty * W + tx];
        while (slot !== NONE) {
          const tank = this.tanks[slot]!;
          if (fn(tank)) return;
          slot = this.next[slot];
        }
      }
    }
  }

  /** Direct grid access for custom iteration patterns. Returns NONE if empty. */
  headAtTile(tx: number, ty: number): number {
    if (tx < 0 || ty < 0 || tx >= W || ty >= W) return NONE;
    return this.grid[ty * W + tx];
  }

  /** Follow the linked list from a slot index. Returns tank and next slot. */
  getSlot(slot: number): { tank: Tank | null; next: number } {
    return { tank: this.tanks[slot] ?? null, next: this.next[slot] };
  }

  /** Number of tanks currently registered. */
  get size(): number {
    return this.count;
  }
}
