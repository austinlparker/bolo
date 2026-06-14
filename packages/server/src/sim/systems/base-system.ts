/**
 * Base fortification, refuel, capture, and siege logic.
 *
 * Owned, uncontested bases fortify (hp) and passively restock
 * armor/shell/mine stock; a battered base supplies more slowly. Friendly
 * tanks on the pad are refueled on an interval; enemies on the pad lay
 * siege, grinding hp down 1 per interval while taking damage. At 0 hp the
 * base falls NEUTRAL and the race to claim the pad begins. Late-war
 * attrition slows fortification and restock so marathon wars can't turtle.
 */
import {
  BASE_CAPTURE_HP,
  BASE_FORTIFY_INTERVAL,
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_HP,
  BASE_MAX_MINE_STOCK,
  BASE_MAX_SHELL_STOCK,
  BASE_REFUEL_INTERVAL,
  BASE_REFUEL_RADIUS,
  BASE_REGEN_INTERVAL,
  BASE_SIEGE_DAMAGE,
  BASE_SIEGE_DRAIN_INTERVAL,
  BASE_SUPPLY_FLOOR,
  DT,
  TANK_MAX_ARMOR,
  TANK_MAX_MINES,
  TANK_MAX_SHELLS,
  TICK_HZ,
} from '@bolo/shared';
import type { WorldHost } from '../world-host';
import { attritionFactor } from '../utils';

export class BaseSystem {
  constructor(private host: WorldHost) {}

  tick(warMinutes: number): void {
    const { bases, tanks, refuelTimers, regenTimers, fortifyTimers, tick, events } = this.host;
    const attrition = attritionFactor(warMinutes);
    for (const base of bases) {
      const cx = base.x + 0.5;
      const cy = base.y + 0.5;

      // fortification + restock pause while enemies contest the pad
      let contested = false;
      for (const t of tanks.values()) {
        if (!t.alive || t.faction === base.owner) continue;
        const dx = t.x - cx;
        const dy = t.y - cy;
        if (dx * dx + dy * dy < 36) {
          contested = true;
          break;
        }
      }

      // a battered base is a slow base: supply rate scales with fortification
      const supplyRate = BASE_SUPPLY_FLOOR + (1 - BASE_SUPPLY_FLOOR) * (base.hp / BASE_MAX_HP);

      if (base.owner !== 'neutral' && !contested) {
        // fortify: defenses rebuild over time (slowed by late-war attrition)
        const f = (fortifyTimers.get(base.id) ?? BASE_FORTIFY_INTERVAL) - DT * attrition;
        if (f <= 0) {
          fortifyTimers.set(base.id, BASE_FORTIFY_INTERVAL);
          if (base.hp < BASE_MAX_HP) {
            base.hp++;
            this.host.basesChanged = true;
          }
        } else {
          fortifyTimers.set(base.id, f);
        }

        const t = (regenTimers.get(base.id) ?? BASE_REGEN_INTERVAL) - DT * supplyRate * attrition;
        if (t <= 0) {
          regenTimers.set(base.id, BASE_REGEN_INTERVAL);
          // flag a change only when stock actually moves, so full bases don't
          // broadcast a no-op bases array every regen interval (which otherwise
          // froze the supply bar on clients until some other base changed).
          const stockBefore = base.armorStock + base.shellStock + base.mineStock;
          base.armorStock = Math.min(BASE_MAX_ARMOR_STOCK, base.armorStock + 1);
          // shells are the war's working currency; restock them faster
          base.shellStock = Math.min(BASE_MAX_SHELL_STOCK, base.shellStock + 3);
          if (tick % (BASE_REGEN_INTERVAL * TICK_HZ * 4) === 0) {
            base.mineStock = Math.min(BASE_MAX_MINE_STOCK, base.mineStock + 1);
          }
          if (base.armorStock + base.shellStock + base.mineStock !== stockBefore) {
            this.host.basesChanged = true;
          }
        } else {
          regenTimers.set(base.id, t);
        }
      }

      // One pad, one timer: it gates a single transfer/siege tick per interval
      // regardless of how many tanks crowd the radius. `timer` is mutable so
      // that once a tank consumes the ready tick, later tanks this iteration
      // see it as not-ready (otherwise N tanks all fired on the same tick).
      let timer = (refuelTimers.get(base.id) ?? 0) - DT;
      refuelTimers.set(base.id, timer);
      const refuelRadiusSq = BASE_REFUEL_RADIUS * BASE_REFUEL_RADIUS;

      for (const tank of tanks.values()) {
        if (!tank.alive) continue;
        const dx = tank.x - cx;
        const dy = tank.y - cy;
        if (dx * dx + dy * dy > refuelRadiusSq) continue;

        if (base.owner === 'neutral') {
          base.owner = tank.faction;
          // a fresh claim starts with token fortifications and digs in from there
          base.hp = Math.max(base.hp, BASE_CAPTURE_HP);
          tank.caps++;
          this.host.basesChanged = true;
          events.push({ e: 'base_captured', baseId: base.id, by: tank.faction, handle: tank.handle });
        } else if (base.owner === tank.faction) {
          if (timer <= 0) {
            timer = BASE_REFUEL_INTERVAL / supplyRate;
            refuelTimers.set(base.id, timer);
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
          // enemy on the pad: a siege. Fortifications grind down 1 hp per
          // interval while zapping the attacker; at 0 the base falls NEUTRAL.
          if (timer <= 0) {
            timer = BASE_SIEGE_DRAIN_INTERVAL;
            refuelTimers.set(base.id, timer);
            if (base.hp > 0) {
              base.hp--;
              this.host.damageTank(tank, BASE_SIEGE_DAMAGE, 'pillbox', null);
              this.host.basesChanged = true;
              if (base.hp <= 0) this.host.neutralizeBase(base, tank.faction);
            }
          }
        }
      }
    }
  }
}
