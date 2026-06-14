/**
 * Pillbox AI: self-repair and autonomous fire at nearby enemy tanks.
 *
 * Pillboxes fire shells with simple leading, on a cooldown that scales
 * with how damaged they are (angrier = faster). Neutral pillboxes target
 * everyone; owned ones target the opposing faction.
 */
import {
  DT,
  PILL_COOLDOWN_ANGRY,
  PILL_COOLDOWN_CALM,
  PILL_MAX_HP,
  PILL_RANGE,
  PILL_REGEN_SECONDS,
  Terrain,
  TICK_HZ,
} from '@bolo/shared';
import type { Pillbox, Tank } from '@bolo/shared';
import type { WorldHost } from '../world-host';

export class PillSystem {
  constructor(private host: WorldHost) {}

  cooldownFor(pill: Pillbox): number {
    const anger = 1 - pill.hp / PILL_MAX_HP;
    return PILL_COOLDOWN_CALM + (PILL_COOLDOWN_ANGRY - PILL_COOLDOWN_CALM) * anger;
  }

  tick(): void {
    const { pills, tanks, shells, tick } = this.host;
    for (const pill of pills) {
      if (pill.inTank || pill.hp <= 0) continue;

      // slow self-repair
      if (pill.hp < PILL_MAX_HP && tick % (PILL_REGEN_SECONDS * TICK_HZ) === 0) {
        pill.hp++;
        this.host.pillsChanged = true;
      }

      pill.cooldown = Math.max(0, pill.cooldown - DT);
      if (pill.cooldown > 0) continue;

      // neutral pillboxes hate everyone; owned ones hate the other faction
      let target: Tank | null = null;
      let bestD = PILL_RANGE;
      for (const tank of tanks.values()) {
        if (!tank.alive) continue;
        if (pill.owner !== 'neutral' && tank.faction === pill.owner) continue;
        // hidden in forest = safe from pillboxes too
        if (this.host.tileAt(tank.x, tank.y) === Terrain.Forest) continue;
        const d = Math.hypot(tank.x - (pill.x + 0.5), tank.y - (pill.y + 0.5));
        if (d < bestD) {
          bestD = d;
          target = tank;
        }
      }
      if (target) {
        const px = pill.x + 0.5;
        const py = pill.y + 0.5;
        // simple leading: aim at where the target will be in flight-time
        const t = bestD / this.host.tuning.shellSpeed;
        const ax = target.x + Math.cos(target.dir) * target.speed * t;
        const ay = target.y + Math.sin(target.dir) * target.speed * t;
        const dir = Math.atan2(ay - py, ax - px);
        shells.push({
          id: this.host.nextId++,
          x: px + Math.cos(dir) * 0.5,
          y: py + Math.sin(dir) * 0.5,
          dir,
          faction: pill.owner,
          ownerTank: -1 - pill.id,
          range: PILL_RANGE,
          fired: PILL_RANGE,
        });
        pill.cooldown = this.cooldownFor(pill);
      }
    }
  }
}
