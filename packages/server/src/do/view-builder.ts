/**
 * Per-player and per-spectator view computation.
 *
 * Translates the authoritative World state into wire messages tailored
 * to each viewer's position, faction, and role. Includes forest
 * concealment, view-radius culling, and mine-intel filtering.
 */
import {
  bytesToBase64,
  type Base,
  FOREST_HIDE_RANGE,
  MAP_SIZE,
  MineState,
  PLAYER_VIEW_RADIUS,
  PROTOCOL_VERSION,
  type Pillbox,
  type SpectateMsg,
  type StateMsg,
  type TankView,
  Terrain,
  TICK_HZ,
  type WelcomeMsg,
} from '@bolo/shared';
import type { PlayerProfile } from '@bolo/shared';
import type { World } from '../sim/world';
import type { Session, SessionStore } from './session-store';

export class ViewBuilder {
  constructor(
    private store: SessionStore,
    private profiles: Map<string, PlayerProfile>,
  ) {}

  welcomeFor(world: World, session: Session, phase: 'active' | 'intermission', nextWarAt: number | null): WelcomeMsg {
    const faction = session.did ? this.profiles.get(session.did)?.faction : undefined;
    const visibleMines: [number, number][] = [];
    if (faction) {
      const mineVal = faction === 'dawn' ? MineState.Dawn : MineState.Dusk;
      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          if (world.mines[y * MAP_SIZE + x] === mineVal) visibleMines.push([x, y]);
        }
      }
    }
    return {
      t: 'welcome',
      v: PROTOCOL_VERSION,
      you:
        session.role === 'player' && session.did && session.handle && faction && session.tankId !== undefined
          ? { did: session.did, handle: session.handle, faction, tankId: session.tankId }
          : null,
      profile: session.did ? this.profiles.get(session.did) : undefined,
      war: world.warInfo(phase, nextWarAt),
      map: { w: MAP_SIZE, h: MAP_SIZE, terrain: bytesToBase64(world.terrain) },
      mines: visibleMines,
      pills: world.pills,
      bases: world.bases,
      tick: world.tick,
    };
  }

  stateFor(
    world: World,
    session: Session,
    mineChanges: [number, number, number][],
    base: { pills?: Pillbox[]; bases?: Base[]; terrain?: [number, number, number][]; events?: StateMsg['events'] },
  ): StateMsg {
    const me = session.tankId !== undefined ? world.tanks.get(session.tankId) : undefined;
    const faction = me?.faction;
    const vx = me?.x ?? MAP_SIZE / 2;
    const vy = me?.y ?? MAP_SIZE / 2;

    const tanks: TankView[] = [];
    const builders: StateMsg['builders'] = [];
    for (const tank of world.tanks.values()) {
      const d = Math.hypot(tank.x - vx, tank.y - vy);
      if (d > PLAYER_VIEW_RADIUS && tank.id !== session.tankId) continue;
      // forest concealment: enemies deep in the trees vanish from your feed
      if (
        faction &&
        tank.faction !== faction &&
        tank.alive &&
        world.tileAt(tank.x, tank.y) === Terrain.Forest &&
        d > FOREST_HIDE_RANGE
      ) {
        continue;
      }
      const view: TankView = {
        id: tank.id,
        handle: tank.handle,
        faction: tank.faction,
        npc: tank.npc,
        x: round2(tank.x),
        y: round2(tank.y),
        dir: round2(tank.dir),
        speed: round2(tank.speed),
        alive: tank.alive,
        onBoat: tank.onBoat,
      };
      if (tank.id === session.tankId) {
        view.armor = tank.armor;
        view.shells = tank.shells;
        view.mines = tank.mines;
        view.trees = tank.trees;
        view.carriedPill = tank.carriedPill;
        view.gunRange = tank.gunRange;
        if (!tank.alive) {
          view.respawnIn = Math.max(0, Math.ceil((tank.respawnTick - world.tick) / TICK_HZ));
        }
        view.kills = tank.kills;
        view.caps = tank.caps;
      }
      tanks.push(view);
      const b = tank.builder;
      if (b.phase !== 'in_tank' && b.phase !== 'dead') {
        builders.push({ tankId: tank.id, faction: tank.faction, phase: b.phase, x: round2(b.x), y: round2(b.y) });
      }
    }

    const shells = world.shells
      .filter((s) => Math.hypot(s.x - vx, s.y - vy) <= PLAYER_VIEW_RADIUS)
      .map((s) => ({ id: s.id, x: round2(s.x), y: round2(s.y), dir: round2(s.dir), f: s.faction }));

    // mine intel: removals are public (the crater is right there); placements only to the owning faction
    let mines: [number, number, 0 | 1][] | undefined;
    if (mineChanges.length) {
      const mineVal = faction === 'dawn' ? MineState.Dawn : MineState.Dusk;
      const visible = mineChanges
        .filter(([, , m]) => m === MineState.None || m === mineVal)
        .map(([x, y, m]) => [x, y, m === MineState.None ? 0 : 1] as [number, number, 0 | 1]);
      if (visible.length) mines = visible;
    }

    return { t: 'state', tick: world.tick, tanks, shells, builders, mines, ...base };
  }

  spectateFrame(world: World, phase: 'active' | 'intermission', nextWarAt: number | null): SpectateMsg {
    const { players, spectators } = this.store.playerSpectatorCounts();
    return {
      t: 'spectate',
      tick: world.tick,
      war: world.warInfo(phase, nextWarAt),
      tanks: [...world.tanks.values()].map((t) => ({
        x: round2(t.x),
        y: round2(t.y),
        faction: t.faction,
        handle: t.handle,
        npc: t.npc,
        alive: t.alive,
      })),
      pills: world.pills,
      bases: world.bases,
      online: { players, spectators },
    };
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}
