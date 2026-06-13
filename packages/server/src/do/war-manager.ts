/**
 * War lifecycle management: player profiles, war history, victory
 * resolution, and intermission/new-war transitions.
 *
 * Tracks which players fought in each war (for warsFought/warsWon
 * credit), folds per-war tank stats into persistent profiles, and
 * re-seats connected players into fresh tanks when a new war starts.
 */
import {
  FACTIONS,
  INTERMISSION_SECONDS,
  type Faction,
  type PlayerProfile,
  type WarRecord,
} from '@bolo/shared';
import { nextWarSeed } from '@bolo/shared';
import { World } from '../sim/world';
import type { SessionStore } from './session-store';

export class WarManager {
  profiles = new Map<string, PlayerProfile>();
  /** DIDs that actually fought in the current war (for warsFought/warsWon) */
  fighters = new Set<string>();
  history: WarRecord[] = [];

  getOrCreateProfile(did: string, handle: string, store: SessionStore): PlayerProfile {
    let profile = this.profiles.get(did);
    if (!profile) {
      // auto-balance: join the faction with fewer humans online, then fewer veterans
      const online: Record<Faction, number> = { dawn: 0, dusk: 0 };
      for (const s of store) {
        if (s.role === 'player' && s.did) {
          const f = this.profiles.get(s.did)?.faction;
          if (f) online[f]++;
        }
      }
      const totals: Record<Faction, number> = { dawn: 0, dusk: 0 };
      for (const p of this.profiles.values()) totals[p.faction]++;
      let faction: Faction;
      if (online.dawn !== online.dusk) faction = online.dawn < online.dusk ? 'dawn' : 'dusk';
      else if (totals.dawn !== totals.dusk) faction = totals.dawn < totals.dusk ? 'dawn' : 'dusk';
      else faction = FACTIONS[Math.floor(Math.random() * 2)];
      profile = {
        did,
        handle,
        faction,
        isBot: false,
        kills: 0,
        deaths: 0,
        caps: 0,
        warsFought: 0,
        warsWon: 0,
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
      this.profiles.set(did, profile);
    }
    return profile;
  }

  foldStats(tank: { did: string; kills: number; deaths: number; caps: number }): void {
    const profile = this.profiles.get(tank.did);
    if (!profile) return;
    profile.kills += tank.kills;
    profile.deaths += tank.deaths;
    profile.caps += tank.caps;
    tank.kills = 0;
    tank.deaths = 0;
    tank.caps = 0;
  }

  endWar(world: World, winner: Faction, store: SessionStore): { record: WarRecord; nextWarAt: number } {
    const record: WarRecord = {
      warNumber: world.warNumber,
      seed: world.seed,
      winner,
      startedAt: world.startedAt,
      endedAt: Date.now(),
      durationMinutes: Math.round((Date.now() - world.startedAt) / 60000),
    };
    this.history.push(record);
    // credit only the people who actually fought in this war
    for (const did of this.fighters) {
      const p = this.profiles.get(did);
      if (!p) continue;
      p.warsFought++;
      if (p.faction === winner) p.warsWon++;
    }
    for (const tank of world.tanks.values()) if (!tank.npc) this.foldStats(tank);
    const nextWarAt = Date.now() + INTERMISSION_SECONDS * 1000;
    store.broadcast({ t: 'war_over', winner, record, nextWarAt });
    return { record, nextWarAt };
  }

  startNewWar(oldWorld: World, store: SessionStore): World {
    const seed = nextWarSeed(oldWorld.seed, oldWorld.warNumber + 1);
    const world = new World(oldWorld.warNumber + 1, seed);
    // re-seat connected players in fresh tanks
    for (const session of store) {
      if (session.role === 'player' && session.did && session.handle) {
        const profile = this.getOrCreateProfile(session.did, session.handle, store);
        const tank = world.addTank(session.did, session.handle, profile.faction, false);
        session.tankId = tank.id;
        this.fighters.add(session.did);
      }
    }
    return world;
  }
}
