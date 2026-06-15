/**
 * Shell flight, collision, and detonation.
 *
 * Shells travel in substeps to avoid tunnelling through thin walls. On
 * collision they damage tanks, builders, pillboxes, bases, or modify
 * terrain (buildings → shot buildings → rubble, forests → grass). One
 * telemetry event is emitted per shell when it resolves.
 */
import {
  DT,
  idx,
  MineState,
  SHELL_DAMAGE,
  shelledTerrain,
  Terrain,
  TERRAIN,
  MAP_SIZE,
  TANK_RADIUS,
} from '@bolo/shared';
import type { Shell, Tank, Base, Pillbox } from '@bolo/shared';
import type { WorldHost } from '../world-host';
import type { ShotStat } from '../world';
import { round2stat } from '../utils';

const W = MAP_SIZE;
const TANK_RADIUS_SQ = TANK_RADIUS * TANK_RADIUS;

export class ShellSystem {
  /** Pre-allocated survivors array, reused across ticks to avoid GC pressure. */
  private survivors: Shell[] = [];
  /** Spatial index of alive tanks, rebuilt each tick for O(1) collision queries. */
  private tankGrid: Int32Array;
  /** Linked-list next pointers (by slot = tank iteration index). */
  private tankNext: Int32Array;

  constructor(private host: WorldHost) {
    this.tankGrid = new Int32Array(W * W).fill(-1);
    this.tankNext = new Int32Array(128); // max tanks — grows if needed
  }

  /** One telemetry event per shell, emitted when it resolves (hit or expired). */
  private shotResolved(shell: Shell, outcome: ShotStat['outcome'], victim?: Tank): void {
    const fromPill = shell.ownerTank < 0;
    const shooter = fromPill ? undefined : this.host.tanks.get(shell.ownerTank);
    this.host.stats.push({
      name: 'shot',
      outcome, // 'tank' | 'builder' | 'pill' | 'base' | 'wall' | 'expired'
      shooter: fromPill ? 'pillbox' : 'tank',
      shooter_npc: shooter?.npc,
      shooter_client: shooter?.client,
      shooter_faction: String(shell.faction),
      travel_tiles: round2stat(shell.fired - shell.range),
      target_npc: victim?.npc,
      target_client: victim?.client,
    });
  }

  tick(): void {
    const step = 0.25; // substep length in tiles, to avoid tunnelling
    const survivors = this.survivors;
    survivors.length = 0;
    // Build O(1) tile-indexed lookup maps for bases and pills once per tick.
    // Bases are static (never move), pills may move when picked up/dropped.
    const baseMap = new Map<number, Base>();
    for (const b of this.host.bases) baseMap.set(b.y * W + b.x, b);
    const pillMap = new Map<number, Pillbox>();
    for (const p of this.host.pills) {
      if (!p.inTank && p.hp > 0) pillMap.set(p.y * W + p.x, p);
    }
    // Build a uniform grid spatial index of all alive tanks for O(1) collision.
    // Tanks have already been moved by the tank-system tick; this snapshot is
    // accurate for the shell collision pass.
    const tankGrid = this.tankGrid;
    tankGrid.fill(-1);
    const tankList = [...this.host.tanks.values()].filter((t) => t.alive);
    if (tankList.length > this.tankNext.length) {
      this.tankNext = new Int32Array(tankList.length * 2);
    }
    const tankNext = this.tankNext;
    for (let i = 0; i < tankList.length; i++) {
      const t = tankList[i];
      const tx = Math.max(0, Math.min(W - 1, Math.floor(t.x)));
      const ty = Math.max(0, Math.min(W - 1, Math.floor(t.y)));
      const tileIdx = ty * W + tx;
      tankNext[i] = tankGrid[tileIdx];
      tankGrid[tileIdx] = i;
    }
    for (const shell of this.host.shells) {
      let travel = this.host.tuning.shellSpeed * DT;
      let dead = false;
      while (travel > 0 && !dead) {
        const d = Math.min(step, travel, shell.range);
        shell.x += Math.cos(shell.dir) * d;
        shell.y += Math.sin(shell.dir) * d;
        shell.range -= d;
        travel -= d;
        dead = this.shellCollide(shell, baseMap, pillMap, tankGrid, tankList, tankNext);
        if (!dead && shell.range <= 0) {
          this.shellDetonateTerrain(shell);
          this.shotResolved(shell, 'expired');
          dead = true;
        }
      }
      if (!dead) survivors.push(shell);
    }
    // Swap: give the host the populated survivors array, keep the old
    // shells array (now cleared) for reuse next tick.
    const oldShells = this.host.shells;
    this.host.shells = survivors;
    this.survivors = oldShells;
    this.survivors.length = 0;
  }

  private shellCollide(
    shell: Shell,
    baseMap: Map<number, Base>,
    pillMap: Map<number, Pillbox>,
    tankGrid: Int32Array,
    tankList: Tank[],
    tankNext: Int32Array,
  ): boolean {
    const { terrain, tanks, events } = this.host;
    if (shell.x < 0 || shell.y < 0 || shell.x >= W || shell.y >= W) {
      this.shotResolved(shell, 'expired');
      return true;
    }
    const xi = Math.floor(shell.x);
    const yi = Math.floor(shell.y);
    const t = terrain[idx(xi, yi)] as Terrain;

    if (TERRAIN[t].blocksShells) {
      this.shellDetonateTerrain(shell);
      this.shotResolved(shell, 'wall');
      return true;
    }

    // bombardment: shells batter a hostile base's fortifications; at 0 hp it
    // falls neutral and anyone can drive on to claim it. Neutral (and friendly)
    // bases don't intercept shells.
    const base = baseMap.get(yi * W + xi);
    if (base && base.owner !== 'neutral' && base.owner !== shell.faction && base.hp > 0) {
      base.hp = Math.max(0, base.hp - SHELL_DAMAGE);
      this.host.basesChanged = true;
      events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
      this.shotResolved(shell, 'base');
      if (base.hp <= 0) this.host.neutralizeBase(base, shell.faction);
      return true;
    }

    // pillboxes occupy their tile
    const pill = pillMap.get(yi * W + xi);
    if (pill && pill.owner !== shell.faction) {
      pill.hp = Math.max(0, pill.hp - SHELL_DAMAGE);
      pill.cooldown = Math.min(pill.cooldown, this.host.pillCooldownFor(pill)); // freshly angry
      this.host.pillsChanged = true;
      events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
      this.shotResolved(shell, 'pill');
      return true;
    }

    // Tank collision: check the 3×3 tile neighborhood via the spatial grid
    const sx = Math.floor(shell.x);
    const sy = Math.floor(shell.y);
    const x0 = Math.max(0, sx - 1);
    const x1 = Math.min(W - 1, sx + 1);
    const y0 = Math.max(0, sy - 1);
    const y1 = Math.min(W - 1, sy + 1);
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        let slot = tankGrid[ty * W + tx];
        while (slot >= 0) {
          const tank = tankList[slot];
          slot = tankNext[slot];
          if (!tank.alive || tank.faction === shell.faction || tank.id === shell.ownerTank) continue;
          const tdx = tank.x - shell.x;
          const tdy = tank.y - shell.y;
          if (tdx * tdx + tdy * tdy < TANK_RADIUS_SQ) {
            const killer = tanks.get(shell.ownerTank) ?? null;
            this.shotResolved(shell, 'tank', tank);
            this.host.damageTank(tank, SHELL_DAMAGE, shell.ownerTank < 0 ? 'pillbox' : 'shell', killer);
            events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
            return true;
          }
          const b = tank.builder;
          if (
            tank.faction !== shell.faction &&
            (b.phase === 'outbound' || b.phase === 'working' || b.phase === 'returning') &&
            (b.x - shell.x) ** 2 + (b.y - shell.y) ** 2 < 0.09 // 0.3²
          ) {
            this.host.killBuilder(tank);
            this.shotResolved(shell, 'builder', tank);
            return true;
          }
        }
      }
    }
    return false;
  }

  private shellDetonateTerrain(shell: Shell): void {
    const xi = Math.floor(shell.x);
    const yi = Math.floor(shell.y);
    if (xi < 0 || yi < 0 || xi >= W || yi >= W) return;
    const t = this.host.terrain[idx(xi, yi)] as Terrain;
    const nt = shelledTerrain(t);
    if (nt !== null) {
      this.host.setTerrain(xi, yi, nt);
      this.host.events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
    }
  }
}
