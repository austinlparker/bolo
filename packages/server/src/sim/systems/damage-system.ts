/**
 * Damage, death, mine detonation, and tile transitions.
 *
 * The damage system is the central hub for combat resolution: shells,
 * pillboxes, mines, and sieges all funnel through damageTank/killTank.
 * Tile transitions (embark/disembark boats, mine detonation, pill
 * pickup) are also handled here because they're triggered by tank
 * movement and can cause damage.
 */
import {
  DT,
  idx,
  MAP_SIZE,
  MineState,
  MINE_DAMAGE,
  minedTerrain,
  PILL_MAX_HP,
  Terrain,
  TERRAIN,
  TICK_HZ,
  TANK_RESPAWN_SECONDS,
} from '@bolo/shared';
import type { Tank } from '@bolo/shared';
import type { WorldHost } from '../world-host';
import { round2stat, clampInt } from '../utils';

const W = MAP_SIZE;

export class DamageSystem {
  constructor(private host: WorldHost) {}

  handleTileTransitions(tank: Tank, prevX: number, prevY: number): void {
    const { terrain, mines, pills, events } = this.host;
    const xi = Math.floor(tank.x);
    const yi = Math.floor(tank.y);
    if (xi === prevX && yi === prevY) return;
    const t = terrain[idx(xi, yi)] as Terrain;

    // embark: drive onto a built boat
    if (t === Terrain.BoatTile && !tank.onBoat) {
      tank.onBoat = true;
      this.host.setTerrain(xi, yi, Terrain.River);
    }
    // disembark: boat -> land leaves the boat moored on the water tile behind you
    if (tank.onBoat && TERRAIN[t].tankSpeed > 0 && t !== Terrain.River && t !== Terrain.DeepSea && t !== Terrain.BoatTile) {
      tank.onBoat = false;
      const prevT = terrain[idx(prevX, prevY)] as Terrain;
      if (prevT === Terrain.River) this.host.setTerrain(prevX, prevY, Terrain.BoatTile);
    }

    // mines
    const m = mines[idx(xi, yi)];
    if (m !== MineState.None) this.detonateMine(xi, yi);

    // pick up a dead pillbox
    const pill = pills.find((p) => !p.inTank && p.hp <= 0 && p.x === xi && p.y === yi);
    if (pill && tank.carriedPill === null) {
      pill.inTank = true;
      pill.owner = tank.faction;
      tank.carriedPill = pill.id;
      tank.caps++;
      this.host.pillsChanged = true;
      events.push({ e: 'pill_captured', pillId: pill.id, by: tank.faction, handle: tank.handle });
    }
  }

  detonateMine(x: number, y: number): void {
    const { mines, terrain, tanks, events } = this.host;
    if (mines[idx(x, y)] === MineState.None) return;
    this.host.setMine(x, y, MineState.None);
    events.push({ e: 'boom', x: x + 0.5, y: y + 0.5, kind: 'mine' });
    const nt = minedTerrain(terrain[idx(x, y)] as Terrain);
    if (nt !== null) this.host.setTerrain(x, y, nt);

    for (const tank of tanks.values()) {
      if (!tank.alive) continue;
      if (Math.abs(tank.x - (x + 0.5)) < 1 && Math.abs(tank.y - (y + 0.5)) < 1) {
        this.damageTank(tank, MINE_DAMAGE, 'mine', null);
      }
      const b = tank.builder;
      if (b.phase !== 'in_tank' && b.phase !== 'dead' && Math.hypot(b.x - (x + 0.5), b.y - (y + 0.5)) < 1) {
        this.host.killBuilder(tank);
      }
    }

    // chain reaction with adjacent mines, classic Bolo
    for (const [dx, dy] of [
      [1, 0],
      [-1, 0],
      [0, 1],
      [0, -1],
    ] as const) {
      const ax = x + dx;
      const ay = y + dy;
      if (ax >= 0 && ay >= 0 && ax < W && ay < W && mines[idx(ax, ay)] !== MineState.None) {
        this.detonateMine(ax, ay);
      }
    }
  }

  /** A killed tank's carried pillbox is dumped on the ground, battered but salvageable. */
  dropCarriedPill(tank: Tank): void {
    const { pills } = this.host;
    if (tank.carriedPill === null) return;
    const pill = pills.find((p) => p.id === tank.carriedPill);
    tank.carriedPill = null;
    if (!pill) return;
    pill.inTank = false;
    pill.owner = 'neutral';
    pill.hp = 0;
    pill.x = clampInt(Math.floor(tank.x), 0, W - 1);
    pill.y = clampInt(Math.floor(tank.y), 0, W - 1);
    this.host.pillsChanged = true;
  }

  damageTank(tank: Tank, amount: number, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void {
    if (!tank.alive) return;
    if (tank.engagedTick === undefined) tank.engagedTick = this.host.tick;
    tank.armor -= amount;
    if (tank.armor <= 0) this.killTank(tank, cause, killer);
  }

  killTank(tank: Tank, cause: 'shell' | 'mine' | 'pillbox' | 'sea', killer: Tank | null): void {
    const { terrain, events, tick } = this.host;
    if (!tank.alive) return;
    this.host.stats.push({
      name: 'kill',
      cause,
      ttk_s: tank.engagedTick !== undefined ? (tick - tank.engagedTick) / TICK_HZ : undefined,
      victim_npc: tank.npc,
      victim_client: tank.client,
      victim_faction: tank.faction,
      killer_npc: killer?.npc,
      killer_client: killer?.client,
      killer_faction: killer?.faction,
      kill_dist_tiles: killer ? round2stat(Math.hypot(killer.x - tank.x, killer.y - tank.y)) : undefined,
    });
    tank.engagedTick = undefined;
    tank.alive = false;
    tank.deaths++;
    tank.respawnTick = tick + TANK_RESPAWN_SECONDS * TICK_HZ;
    if (killer && killer.id !== tank.id) killer.kills++;
    this.dropCarriedPill(tank);
    if (tank.builder.phase !== 'in_tank' && tank.builder.phase !== 'dead') this.host.killBuilder(tank);
    tank.builder.phase = 'dead';
    tank.builder.respawnTick = tank.respawnTick;
    // a tank death scars the land
    const xi = clampInt(Math.floor(tank.x), 0, W - 1);
    const yi = clampInt(Math.floor(tank.y), 0, W - 1);
    const here = terrain[idx(xi, yi)] as Terrain;
    const nt = minedTerrain(here);
    if (nt !== null && here !== Terrain.Road) this.host.setTerrain(xi, yi, nt);
    events.push({
      e: 'kill',
      killer: killer?.handle ?? (cause === 'sea' ? 'the sea' : cause),
      victim: tank.handle,
      cause,
    });
    events.push({ e: 'boom', x: tank.x, y: tank.y, kind: 'shell' });
  }
}
