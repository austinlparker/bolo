/**
 * Base refuel, capture, and siege logic.
 *
 * Owned bases passively regenerate armor/shell/mine stock (paused while
 * contested). Friendly tanks on the pad are refueled on an interval;
 * enemies on the pad trigger a siege that drains the base's armor stock
 * to damage the attacker, and overruns the base when stock is depleted.
 */
import {
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_MINE_STOCK,
  BASE_MAX_SHELL_STOCK,
  BASE_REFUEL_INTERVAL,
  BASE_REFUEL_RADIUS,
  BASE_REGEN_INTERVAL,
  BASE_SIEGE_DAMAGE,
  BASE_SIEGE_DRAIN_INTERVAL,
  DT,
  TANK_MAX_ARMOR,
  TANK_MAX_MINES,
  TANK_MAX_SHELLS,
  TICK_HZ,
} from '@bolo/shared';
import type { WorldHost } from '../world-host';

export class BaseSystem {
  constructor(private host: WorldHost) {}

  tick(): void {
    const { bases, tanks, refuelTimers, regenTimers, tick, events } = this.host;
    for (const base of bases) {
      const cx = base.x + 0.5;
      const cy = base.y + 0.5;

      // passive restock for owned bases — paused while enemies contest the pad
      let contested = false;
      for (const t of tanks.values()) {
        if (t.alive && t.faction !== base.owner && Math.hypot(t.x - cx, t.y - cy) < 6) {
          contested = true;
          break;
        }
      }
      if (base.owner !== 'neutral' && !contested) {
        const t = (regenTimers.get(base.id) ?? BASE_REGEN_INTERVAL) - DT;
        if (t <= 0) {
          regenTimers.set(base.id, BASE_REGEN_INTERVAL);
          base.armorStock = Math.min(BASE_MAX_ARMOR_STOCK, base.armorStock + 1);
          // shells are the war's working currency; restock them faster
          base.shellStock = Math.min(BASE_MAX_SHELL_STOCK, base.shellStock + 3);
          if (tick % (BASE_REGEN_INTERVAL * TICK_HZ * 4) === 0) {
            base.mineStock = Math.min(BASE_MAX_MINE_STOCK, base.mineStock + 1);
          }
        } else {
          regenTimers.set(base.id, t);
        }
      }

      const timer = (refuelTimers.get(base.id) ?? 0) - DT;
      refuelTimers.set(base.id, timer);

      for (const tank of tanks.values()) {
        if (!tank.alive) continue;
        if (Math.hypot(tank.x - cx, tank.y - cy) > BASE_REFUEL_RADIUS) continue;

        if (base.owner === 'neutral') {
          base.owner = tank.faction;
          tank.caps++;
          this.host.basesChanged = true;
          events.push({ e: 'base_captured', baseId: base.id, by: tank.faction, handle: tank.handle });
        } else if (base.owner === tank.faction) {
          if (timer <= 0) {
            refuelTimers.set(base.id, BASE_REFUEL_INTERVAL);
            let used = false;
            if (tank.armor < TANK_MAX_ARMOR && base.armorStock > 0) {
              tank.armor++;
              base.armorStock--;
              used = true;
              // patched back to full: the next damage starts a new engagement
              if (tank.armor >= TANK_MAX_ARMOR) tank.engagedTick = undefined;
            }
            if (tank.shells < TANK_MAX_SHELLS && base.shellStock > 0) {
              tank.shells++;
              base.shellStock--;
              used = true;
            }
            if (tank.mines < TANK_MAX_MINES && base.mineStock > 0) {
              tank.mines++;
              base.mineStock--;
              used = true;
            }
            if (used) this.host.basesChanged = true;
          }
        } else {
          // enemy on the pad: a siege. The base spends armor stock to repel.
          if (timer <= 0) {
            refuelTimers.set(base.id, BASE_SIEGE_DRAIN_INTERVAL);
            if (base.armorStock > 0) {
              base.armorStock--;
              this.host.damageTank(tank, BASE_SIEGE_DAMAGE, 'pillbox', null);
              this.host.basesChanged = true;
            } else {
              base.owner = tank.faction;
              tank.caps++;
              this.host.basesChanged = true;
              events.push({ e: 'base_captured', baseId: base.id, by: tank.faction, handle: tank.handle });
            }
          }
        }
      }
    }
  }
}
