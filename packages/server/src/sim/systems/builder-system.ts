/**
 * Builder unit: resource gathering and construction.
 *
 * Tanks dispatch a builder to harvest trees, pave roads, raise walls,
 * build boats, place pillboxes, or lay mines. The builder travels
 * outbound, works for BUILDER_WORK_SECONDS, then returns. Recall
 * refunds the order. Builders can be killed by shells, mines, or being
 * run over by enemy tanks.
 */
import {
  BUILDER_MAX_RANGE,
  BUILDER_RESPAWN_SECONDS,
  BUILDER_SPEED,
  BUILDER_WATER_SPEED,
  BUILDER_WORK_SECONDS,
  COST_BOAT,
  COST_PILL_PLACE,
  COST_ROAD,
  COST_WALL,
  COST_WALL_REPAIR,
  DT,
  idx,
  MAP_SIZE,
  MineState,
  PILL_MAX_HP,
  PILL_REPAIR_HP,
  PILL_REPAIR_TREES,
  Terrain,
  TERRAIN,
  TICK_HZ,
  TANK_MAX_TREES,
  TANK_MAX_MINES,
  TREES_PER_FOREST_TILE,
} from '@bolo/shared';
import type { BuilderOrderKind, Tank } from '@bolo/shared';
import type { WorldHost } from '../world-host';
import { canBuildOn } from '../utils';

const W = MAP_SIZE;

export class BuilderSystem {
  constructor(private host: WorldHost) {}

  // ---------- public API (called from World) ----------

  order(id: number, kind: BuilderOrderKind, tx: number, ty: number): string | null {
    const tank = this.host.tanks.get(id);
    if (!tank || !tank.alive) return 'not alive';
    const b = tank.builder;
    if (b.phase !== 'in_tank') return 'builder is out';
    // Number.isInteger also rejects NaN/Infinity, which would otherwise slip
    // through the < / >= comparisons (every comparison with NaN is false) and
    // index the terrain array with a garbage key.
    if (!Number.isInteger(tx) || !Number.isInteger(ty) || tx < 0 || ty < 0 || tx >= W || ty >= W) {
      return 'out of bounds';
    }
    // Don't let the builder pave/wall/mine over a base pad: walls would block
    // the pad entirely (no refuel, no capture) and shells couldn't reach it.
    if (this.host.bases.some((base) => base.x === tx && base.y === ty)) return 'cannot build on a base';
    const dist = Math.hypot(tx + 0.5 - tank.x, ty + 0.5 - tank.y);
    if (dist > BUILDER_MAX_RANGE) return 'too far away';

    const t = this.host.terrain[idx(tx, ty)] as Terrain;
    switch (kind) {
      case 'harvest':
        if (t !== Terrain.Forest) return 'no trees there';
        break;
      case 'road':
        if (!canBuildOn(t) && t !== Terrain.River) return 'cannot pave that';
        if (tank.trees < COST_ROAD) return 'not enough trees';
        tank.trees -= COST_ROAD;
        break;
      case 'wall': {
        const cost = t === Terrain.ShotBuilding ? COST_WALL_REPAIR : COST_WALL;
        if (!canBuildOn(t)) return 'cannot build there';
        if (tank.trees < cost) return 'not enough trees';
        tank.trees -= cost;
        break;
      }
      case 'boat':
        if (t !== Terrain.River) return 'boats are built on river';
        if (tank.trees < COST_BOAT) return 'not enough trees';
        tank.trees -= COST_BOAT;
        break;
      case 'pillbox': {
        const pillHere = this.host.pills.find((p) => !p.inTank && p.x === tx && p.y === ty);
        if (pillHere) {
          if (pillHere.owner !== tank.faction && pillHere.hp > 0) return 'hostile pillbox';
          if (tank.trees < PILL_REPAIR_TREES) return 'not enough trees';
          tank.trees -= PILL_REPAIR_TREES;
        } else {
          if (tank.carriedPill === null) return 'no pillbox carried';
          if (!canBuildOn(t)) return 'cannot place there';
          if (tank.trees < COST_PILL_PLACE) return 'not enough trees';
          tank.trees -= COST_PILL_PLACE;
        }
        break;
      }
      case 'mine':
        if (t === Terrain.DeepSea || t === Terrain.River || t === Terrain.BoatTile) return 'cannot mine water';
        if (this.host.mines[idx(tx, ty)] !== MineState.None) return 'already mined';
        if (tank.mines < 1) return 'no mines';
        tank.mines -= 1;
        break;
    }

    b.order = { kind, tx, ty };
    b.phase = 'outbound';
    b.x = tank.x;
    b.y = tank.y;
    return null;
  }

  recall(id: number): void {
    const tank = this.host.tanks.get(id);
    if (!tank) return;
    const b = tank.builder;
    if (b.phase === 'outbound' || b.phase === 'working') {
      this.refundOrder(tank);
      b.order = null;
      b.phase = 'returning';
    }
  }

  killBuilder(tank: Tank): void {
    const b = tank.builder;
    if (b.phase === 'dead' || b.phase === 'in_tank') return;
    this.refundOrder(tank);
    b.order = null;
    b.phase = 'dead';
    b.respawnTick = this.host.tick + BUILDER_RESPAWN_SECONDS * TICK_HZ;
    this.host.events.push({ e: 'builder_killed', tankId: tank.id });
  }

  // ---------- internal ----------

  tick(tank: Tank): void {
    const b = tank.builder;
    switch (b.phase) {
      case 'in_tank':
        return;
      case 'dead':
        if (this.host.tick >= b.respawnTick) b.phase = 'in_tank';
        return;
      case 'outbound': {
        if (!b.order) {
          b.phase = 'returning';
          return;
        }
        const tx = b.order.tx + 0.5;
        const ty = b.order.ty + 0.5;
        // walls are built from OUTSIDE the tile, so he can't entomb himself
        const arrive = b.order.kind === 'wall' ? 0.95 : 0.15;
        if (this.moveBuilder(b, tx, ty, arrive)) {
          b.phase = 'working';
          b.workLeft = BUILDER_WORK_SECONDS;
        }
        return;
      }
      case 'working': {
        b.workLeft -= DT;
        if (b.workLeft <= 0) {
          this.completeBuilderJob(tank);
          b.order = null;
          b.phase = 'returning';
        }
        return;
      }
      case 'returning': {
        if (!tank.alive) {
          this.killBuilder(tank);
          return;
        }
        if (this.moveBuilder(b, tank.x, tank.y)) {
          b.phase = 'in_tank';
        }
        return;
      }
    }
  }

  /** Move builder toward (tx, ty); returns true when within `arrive`. */
  private moveBuilder(b: { x: number; y: number }, tx: number, ty: number, arrive = 0.15): boolean {
    const dx = tx - b.x;
    const dy = ty - b.y;
    const dist = Math.hypot(dx, dy);
    if (dist < arrive) return true;
    const here = this.host.tileAt(b.x, b.y);
    const props = TERRAIN[here];
    const speed = props.builderSpeed > 0 ? BUILDER_SPEED * props.builderSpeed : BUILDER_WATER_SPEED;
    const step = Math.min(dist, speed * DT);
    const nx = b.x + (dx / dist) * step;
    const ny = b.y + (dy / dist) * step;
    // builders walk around buildings rather than through them — unless he's
    // already inside a wall (one was built on top of him); then he clambers
    // out instead of being entombed
    if (this.host.tileAt(nx, ny) === Terrain.Building && here !== Terrain.Building) {
      // try sliding along one axis
      if (this.host.tileAt(nx, b.y) !== Terrain.Building) b.x = nx;
      else if (this.host.tileAt(b.x, ny) !== Terrain.Building) b.y = ny;
      return false;
    }
    b.x = nx;
    b.y = ny;
    return Math.hypot(tx - b.x, ty - b.y) < arrive;
  }

  private completeBuilderJob(tank: Tank): void {
    const o = tank.builder.order;
    if (!o) return;
    // Belt-and-suspenders: order() already rejects base tiles, but guard again
    // here in case the world changed between order and completion.
    if (o.kind !== 'harvest' && this.host.bases.some((base) => base.x === o.tx && base.y === o.ty)) {
      this.refundOrder(tank);
      return;
    }
    const t = this.host.terrain[idx(o.tx, o.ty)] as Terrain;
    switch (o.kind) {
      case 'harvest':
        if (t === Terrain.Forest) {
          this.host.setTerrain(o.tx, o.ty, Terrain.Grass);
          tank.trees = Math.min(TANK_MAX_TREES, tank.trees + TREES_PER_FOREST_TILE);
          tank.treesChopped++;
        }
        break;
      case 'road':
        if (canBuildOn(t) || t === Terrain.River) {
          this.host.setTerrain(o.tx, o.ty, Terrain.Road);
          tank.roadsBuilt++;
        } else this.refundOrder(tank);
        break;
      case 'wall':
        if (canBuildOn(t)) {
          this.host.setTerrain(o.tx, o.ty, Terrain.Building);
          tank.wallsBuilt++;
        } else this.refundOrder(tank);
        break;
      case 'boat':
        if (t === Terrain.River) this.host.setTerrain(o.tx, o.ty, Terrain.BoatTile);
        else this.refundOrder(tank);
        break;
      case 'pillbox': {
        const pillHere = this.host.pills.find((p) => !p.inTank && p.x === o.tx && p.y === o.ty);
        if (pillHere && (pillHere.owner === tank.faction || pillHere.hp <= 0)) {
          pillHere.owner = tank.faction;
          pillHere.hp = Math.min(PILL_MAX_HP, pillHere.hp + PILL_REPAIR_HP);
          this.host.pillsChanged = true;
          tank.pillsBuilt++;
        } else if (tank.carriedPill !== null && canBuildOn(t)) {
          const pill = this.host.pills.find((p) => p.id === tank.carriedPill);
          if (pill) {
            pill.inTank = false;
            pill.owner = tank.faction;
            pill.hp = Math.floor(PILL_MAX_HP * 0.4);
            pill.x = o.tx;
            pill.y = o.ty;
            tank.carriedPill = null;
            this.host.pillsChanged = true;
            tank.pillsBuilt++;
            this.host.events.push({ e: 'pill_placed', pillId: pill.id, x: o.tx, y: o.ty, by: tank.faction });
          }
        } else {
          this.refundOrder(tank);
        }
        break;
      }
      case 'mine':
        if (this.host.mines[idx(o.tx, o.ty)] === MineState.None && t !== Terrain.River && t !== Terrain.DeepSea) {
          this.host.setMine(o.tx, o.ty, tank.faction === 'dawn' ? MineState.Dawn : MineState.Dusk);
        } else {
          this.refundOrder(tank);
        }
        break;
    }
  }

  private refundOrder(tank: Tank): void {
    const o = tank.builder.order;
    if (!o) return;
    switch (o.kind) {
      case 'road':
        tank.trees = Math.min(TANK_MAX_TREES, tank.trees + COST_ROAD);
        break;
      case 'wall': {
        // Refund the exact amount charged at order time. A repair
        // (target was ShotBuilding) costs COST_WALL_REPAIR, not COST_WALL.
        // The builder hasn't completed its work during refund, so the
        // terrain at the target tile is unchanged from when the order was placed.
        const t = this.host.terrain[idx(o.tx, o.ty)] as Terrain;
        const refund = t === Terrain.ShotBuilding ? COST_WALL_REPAIR : COST_WALL;
        tank.trees = Math.min(TANK_MAX_TREES, tank.trees + refund);
        break;
      }
      case 'boat':
        tank.trees = Math.min(TANK_MAX_TREES, tank.trees + COST_BOAT);
        break;
      case 'mine':
        tank.mines = Math.min(TANK_MAX_MINES, tank.mines + 1);
        break;
      default:
        break;
    }
  }
}
