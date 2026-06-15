/**
 * Tank physics: rotational inertia, terrain-dependent speed, movement,
 * firing, and builder-squashing.
 *
 * Turn rate ramps up toward the input target (a tank has mass) but
 * releasing or reversing is instant. Held turn and queued fine-aim nudges
 * share one per-tick rotation budget. Tanks die instantly in deep sea
 * without a boat.
 */
import {
  BOAT_SPEED,
  DT,
  MAP_SIZE,
  TANK_RADIUS,
  Terrain,
  TERRAIN,
} from '@bolo/shared';
import type { Tank } from '@bolo/shared';
import type { WorldHost } from '../world-host';
import { clamp } from '../utils';

const W = MAP_SIZE;
const TANK_RADIUS_SQ = TANK_RADIUS * TANK_RADIUS;

/** Tread corner sample points for the road-shoulder speed check. */
const TREAD_OFFSETS: [number, number][] = [
  [TANK_RADIUS * 0.9, TANK_RADIUS * 0.9],
  [TANK_RADIUS * 0.9, -TANK_RADIUS * 0.9],
  [-TANK_RADIUS * 0.9, TANK_RADIUS * 0.9],
  [-TANK_RADIUS * 0.9, -TANK_RADIUS * 0.9],
];

export class TankSystem {
  constructor(private host: WorldHost) {}

  tick(tank: Tank): void {
    const input = this.host.inputs.get(tank.id) ?? { accel: 0, turn: 0, fire: false };
    const tuning = this.host.tuning;

    // rotational inertia: the turn rate ramps UP toward the input's target
    // (a tank has mass), but slowing, releasing or reversing is instant so
    // aim never overshoots the moment you let go
    const targetRate = clamp(input.turn, -1, 1) * tuning.turnRate;
    if (targetRate * tank.turnSpeed < 0) tank.turnSpeed = 0; // reversal restarts the ramp
    if (Math.abs(targetRate) <= Math.abs(tank.turnSpeed)) {
      tank.turnSpeed = targetRate;
    } else {
      tank.turnSpeed =
        targetRate > 0
          ? Math.min(targetRate, tank.turnSpeed + tuning.turnAccel * DT)
          : Math.max(targetRate, tank.turnSpeed - tuning.turnAccel * DT);
    }
    // held turn + queued fine-aim nudges, under one per-tick rotation budget:
    // the held key takes priority, nudges drain from whatever budget remains
    const turnStep = tank.turnSpeed * DT;
    const pending = this.host.nudges.get(tank.id) ?? 0;
    const budget = tuning.turnRate * DT - Math.abs(turnStep);
    const nudgeStep = clamp(pending, -budget, budget);
    tank.dir += turnStep + nudgeStep;
    if (Math.abs(pending - nudgeStep) > 1e-6) this.host.nudges.set(tank.id, pending - nudgeStep);
    else this.host.nudges.delete(tank.id);
    if (tank.dir > Math.PI) tank.dir -= 2 * Math.PI;
    else if (tank.dir < -Math.PI) tank.dir += 2 * Math.PI;

    const here = this.host.tileAt(tank.x, tank.y);
    const onWater = here === Terrain.DeepSea || here === Terrain.River || here === Terrain.BoatTile;
    let maxSpeed: number;
    if (tank.onBoat && onWater) {
      maxSpeed = BOAT_SPEED;
    } else {
      let terrainSpeed = TERRAIN[here].tankSpeed;
      // road shoulder: keeping the hull centered on a 1-tile road is
      // fiddly, so any road under the treads grants road speed (playtest:
      // "I need to find the rules for using the roads!!!")
      if (terrainSpeed > 0 && here !== Terrain.Road) {
        for (const [ox, oy] of TREAD_OFFSETS) {
          if (this.host.tileAt(tank.x + ox, tank.y + oy) === Terrain.Road) {
            terrainSpeed = TERRAIN[Terrain.Road].tankSpeed;
            break;
          }
        }
      }
      maxSpeed = tuning.maxSpeed * terrainSpeed;
    }

    // accel is a TARGET-SPEED fraction in [-1, 1], not just a direction: the
    // tank cruises toward accel * maxSpeed, so a held throttle holds a speed.
    // (Keyboard sends ±1/0, so W is still full ahead and release is a stop;
    // touch sends a held cruise fraction.) Input opposing the current motion
    // brakes harder than plain accel/coast.
    const target =
      input.accel >= 0 ? input.accel * maxSpeed : input.accel * maxSpeed * tuning.reverseFactor;
    const opposing = (input.accel < 0 && tank.speed > 0) || (input.accel > 0 && tank.speed < 0);
    // accel tapers as speed builds (punchy start, soft top end); braking doesn't
    const rate = opposing
      ? tuning.brake
      : tuning.accel * (1 - tuning.accelCurve * Math.min(1, Math.abs(tank.speed) / tuning.maxSpeed));
    if (tank.speed < target) tank.speed = Math.min(target, tank.speed + rate * DT);
    else if (tank.speed > target) tank.speed = Math.max(target, tank.speed - rate * DT);

    if (tank.speed !== 0) {
      const nx = tank.x + Math.cos(tank.dir) * tank.speed * DT;
      const ny = tank.y + Math.sin(tank.dir) * tank.speed * DT;
      const nextTile = this.host.tileAt(nx, ny);
      const blocked =
        nextTile === Terrain.Building ||
        (!tank.onBoat && nextTile === Terrain.DeepSea && here !== Terrain.DeepSea);
      if (blocked) {
        tank.speed = 0;
      } else {
        const prevTileX = Math.floor(tank.x);
        const prevTileY = Math.floor(tank.y);
        tank.x = clamp(nx, 0.5, W - 0.5);
        tank.y = clamp(ny, 0.5, W - 0.5);
        this.host.handleTileTransitions(tank, prevTileX, prevTileY);
      }
    }

    // sinking: in deep sea with no boat
    if (!tank.onBoat && this.host.tileAt(tank.x, tank.y) === Terrain.DeepSea) {
      this.host.killTank(tank, 'sea', null);
      return;
    }

    // firing
    tank.fireCooldown = Math.max(0, tank.fireCooldown - DT);
    if (input.fire && tank.fireCooldown <= 0 && tank.shells > 0) {
      tank.shells--;
      tank.fireCooldown = tuning.fireCooldown;
      this.host.shells.push({
        id: this.host.nextId++,
        x: tank.x + Math.cos(tank.dir) * (TANK_RADIUS + 0.1),
        y: tank.y + Math.sin(tank.dir) * (TANK_RADIUS + 0.1),
        dir: tank.dir,
        faction: tank.faction,
        ownerTank: tank.id,
        range: tank.gunRange,
        fired: tank.gunRange,
      });
    }

    // squash enemy builders under the treads
    for (const other of this.host.tanks.values()) {
      const b = other.builder;
      if (other.faction === tank.faction) continue;
      if (b.phase === 'outbound' || b.phase === 'working' || b.phase === 'returning') {
        const bdx = b.x - tank.x;
        const bdy = b.y - tank.y;
        if (bdx * bdx + bdy * bdy < TANK_RADIUS_SQ) {
          this.host.killBuilder(other);
        }
      }
    }
  }
}
