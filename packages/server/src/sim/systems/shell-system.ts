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
  SHELL_SPEED,
  shelledTerrain,
  Terrain,
  TERRAIN,
  MAP_SIZE,
  TANK_RADIUS,
} from '@bolo/shared';
import type { Shell, Tank } from '@bolo/shared';
import type { WorldHost } from '../world-host';
import type { ShotStat } from '../world';
import { round2stat } from '../utils';

const W = MAP_SIZE;

export class ShellSystem {
  constructor(private host: WorldHost) {}

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
    const survivors: Shell[] = [];
    for (const shell of this.host.shells) {
      let travel = SHELL_SPEED * DT;
      let dead = false;
      while (travel > 0 && !dead) {
        const d = Math.min(step, travel, shell.range);
        shell.x += Math.cos(shell.dir) * d;
        shell.y += Math.sin(shell.dir) * d;
        shell.range -= d;
        travel -= d;
        dead = this.shellCollide(shell);
        if (!dead && shell.range <= 0) {
          this.shellDetonateTerrain(shell);
          this.shotResolved(shell, 'expired');
          dead = true;
        }
      }
      if (!dead) survivors.push(shell);
    }
    this.host.shells = survivors;
  }

  private shellCollide(shell: Shell): boolean {
    const { terrain, bases, pills, tanks, events } = this.host;
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

    // bombardment: shells drain a hostile base's armor stock until it can be overrun
    const base = bases.find((b) => b.x === xi && b.y === yi);
    if (base && base.owner !== shell.faction && base.armorStock > 0) {
      base.armorStock = Math.max(0, base.armorStock - SHELL_DAMAGE);
      this.host.basesChanged = true;
      events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
      this.shotResolved(shell, 'base');
      return true;
    }

    // pillboxes occupy their tile
    const pill = pills.find((p) => !p.inTank && p.hp > 0 && p.x === xi && p.y === yi);
    if (pill && pill.owner !== shell.faction) {
      pill.hp = Math.max(0, pill.hp - SHELL_DAMAGE);
      pill.cooldown = Math.min(pill.cooldown, this.host.pillCooldownFor(pill)); // freshly angry
      this.host.pillsChanged = true;
      events.push({ e: 'boom', x: shell.x, y: shell.y, kind: 'shell' });
      this.shotResolved(shell, 'pill');
      return true;
    }

    for (const tank of tanks.values()) {
      if (!tank.alive || tank.faction === shell.faction || tank.id === shell.ownerTank) continue;
      if (Math.hypot(tank.x - shell.x, tank.y - shell.y) < TANK_RADIUS) {
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
        Math.hypot(b.x - shell.x, b.y - shell.y) < 0.3
      ) {
        this.host.killBuilder(tank);
        this.shotResolved(shell, 'builder', tank);
        return true;
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
