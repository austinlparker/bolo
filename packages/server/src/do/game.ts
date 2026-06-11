/**
 * GameDO: a single Durable Object instance ("world") owns the entire
 * persistent war — map, entities, profiles, and every live WebSocket.
 *
 * The sim ticks at TICK_HZ only while at least one socket is connected;
 * with nobody watching, the world simply freezes in place (and an alarm
 * still fires to roll intermissions over into new wars).
 */
import {
  bytesToBase64,
  type Base,
  type BuilderOrderKind,
  type ClientMsg,
  type Faction,
  FACTIONS,
  FOREST_HIDE_RANGE,
  INTERMISSION_SECONDS,
  MAP_SIZE,
  MineState,
  nextWarSeed,
  type Pillbox,
  PLAYER_VIEW_RADIUS,
  type PlayerProfile,
  type ServerMsg,
  SPECTATOR_HZ,
  type SpectateMsg,
  type StateMsg,
  type TankView,
  Terrain,
  TICK_HZ,
  TICK_MS,
  type WarRecord,
  type WelcomeMsg,
} from '@bolo/shared';
import { verifyToken } from '../auth';
import { type Env, sessionSecret } from '../env';
import { balanceNpcs, npcThink } from '../sim/npc';
import { World } from '../sim/world';

interface Session {
  ws: WebSocket;
  role: 'player' | 'spectator';
  did?: string;
  handle?: string;
  tankId?: number;
  /** spectators accumulate terrain deltas between their 1Hz frames */
  pendingTerrain: [number, number, number][];
  msgBudget: number;
}

const PERSIST_EVERY_TICKS = TICK_HZ * 30;
const MSG_BUDGET_PER_TICK = 8; // ~80 msgs/sec ceiling per connection

export class GameDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private world: World | null = null;
  private sessions = new Set<Session>();
  private profiles = new Map<string, PlayerProfile>();
  private history: WarRecord[] = [];
  private phase: 'active' | 'intermission' = 'active';
  private nextWarAt: number | null = null;
  private interval: ReturnType<typeof setInterval> | null = null;
  private loaded: Promise<void>;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.loaded = this.load();
  }

  private async load(): Promise<void> {
    const [meta, terrain, mines, profiles, history] = await Promise.all([
      this.state.storage.get<Record<string, unknown>>('meta'),
      this.state.storage.get<Uint8Array>('terrain'),
      this.state.storage.get<Uint8Array>('mines'),
      this.state.storage.get<Record<string, PlayerProfile>>('profiles'),
      this.state.storage.get<WarRecord[]>('history'),
    ]);
    if (profiles) this.profiles = new Map(Object.entries(profiles));
    if (history) this.history = history;
    if (meta && terrain && mines) {
      this.phase = (meta.phase as 'active' | 'intermission') ?? 'active';
      this.nextWarAt = (meta.nextWarAt as number | null) ?? null;
      this.world = World.restore(meta.world as Record<string, unknown>, new Uint8Array(terrain), new Uint8Array(mines));
    } else {
      this.world = new World(1, (Date.now() ^ 0xb010b010) >>> 0);
      await this.persist();
    }
  }

  private async persist(): Promise<void> {
    if (!this.world) return;
    await this.state.storage.put({
      meta: {
        phase: this.phase,
        nextWarAt: this.nextWarAt,
        world: this.world.serializeMeta(),
      },
      terrain: this.world.terrain,
      mines: this.world.mines,
      profiles: Object.fromEntries(this.profiles),
      history: this.history,
    });
  }

  async fetch(request: Request): Promise<Response> {
    await this.loaded;
    const url = new URL(request.url);

    if (url.pathname === '/ws') {
      if (request.headers.get('Upgrade') !== 'websocket') {
        return new Response('expected websocket', { status: 426 });
      }
      const pair = new WebSocketPair();
      this.handleSocket(pair[1]);
      return new Response(null, { status: 101, webSocket: pair[0] });
    }

    if (url.pathname === '/status') {
      const world = this.world!;
      let players = 0;
      let spectators = 0;
      for (const s of this.sessions) (s.role === 'player' ? players++ : spectators++);
      const leaderboard = [...this.profiles.values()]
        .filter((p) => p.kills + p.caps > 0)
        .sort((a, b) => b.kills + b.caps * 3 - (a.kills + a.caps * 3))
        .slice(0, 20);
      return Response.json({
        war: world.warInfo(this.phase, this.nextWarAt),
        online: { players, spectators },
        history: this.history.slice(-20).reverse(),
        leaderboard,
      });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.loaded;
    // The alarm only matters for rolling an intermission into the next war
    // when no sockets are connected to drive the tick loop.
    if (this.phase === 'intermission' && this.nextWarAt && Date.now() >= this.nextWarAt) {
      this.startNewWar();
      await this.persist();
    }
  }

  // ---------- sockets ----------

  private handleSocket(ws: WebSocket): void {
    ws.accept();
    const session: Session = { ws, role: 'spectator', pendingTerrain: [], msgBudget: MSG_BUDGET_PER_TICK };
    let helloed = false;

    ws.addEventListener('message', (ev) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ClientMsg;
      } catch {
        this.send(session, { t: 'error', code: 'bad_message', msg: 'invalid JSON' });
        return;
      }
      if (!helloed) {
        if (msg.t !== 'hello') {
          this.send(session, { t: 'error', code: 'bad_message', msg: 'expected hello' });
          ws.close(1002, 'expected hello');
          return;
        }
        helloed = true;
        void this.handleHello(session, msg.token, msg.role === 'player' ? 'player' : 'spectator');
        return;
      }
      if (--session.msgBudget < 0) return; // silently drop floods
      this.handleMessage(session, msg);
    });

    const drop = () => {
      if (!this.sessions.has(session)) return;
      this.sessions.delete(session);
      if (session.tankId !== undefined) {
        const tank = this.world?.tanks.get(session.tankId);
        if (tank) this.foldStats(tank);
        this.world?.removeTank(session.tankId);
      }
      if (this.sessions.size === 0) {
        this.stopTicking();
        void this.persist();
      }
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  private async handleHello(session: Session, token: string | undefined, role: 'player' | 'spectator'): Promise<void> {
    const world = this.world!;
    if (role === 'player') {
      const payload = token ? await verifyToken(sessionSecret(this.env), token) : null;
      if (!payload) {
        this.send(session, { t: 'error', code: 'auth_failed', msg: 'invalid or expired token' });
        session.ws.close(4001, 'auth failed');
        return;
      }
      // one connection per identity: the newest wins
      for (const other of this.sessions) {
        if (other.did === payload.did) {
          other.ws.close(4000, 'signed in from another connection');
        }
      }
      const profile = this.getOrCreateProfile(payload.did, payload.handle);
      profile.handle = payload.handle;
      profile.lastSeen = Date.now();
      session.role = 'player';
      session.did = payload.did;
      session.handle = payload.handle;
      if (this.phase === 'active') {
        const tank = world.addTank(payload.did, payload.handle, profile.faction, false);
        session.tankId = tank.id;
      }
    } else {
      session.role = 'spectator';
    }
    this.sessions.add(session);
    this.send(session, this.welcomeFor(session));
    this.broadcastChat('system', `${session.handle ?? 'a spectator'} ${role === 'player' ? 'joined the war' : 'is watching'}`);
    this.startTicking();
  }

  private getOrCreateProfile(did: string, handle: string): PlayerProfile {
    let profile = this.profiles.get(did);
    if (!profile) {
      // auto-balance: join the faction with fewer humans online, then fewer veterans
      const online: Record<Faction, number> = { dawn: 0, dusk: 0 };
      for (const s of this.sessions) {
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
        firstSeen: Date.now(),
        lastSeen: Date.now(),
      };
      this.profiles.set(did, profile);
    }
    return profile;
  }

  private foldStats(tank: { did: string; kills: number; deaths: number; caps: number }): void {
    const profile = this.profiles.get(tank.did);
    if (!profile) return;
    profile.kills += tank.kills;
    profile.deaths += tank.deaths;
    profile.caps += tank.caps;
    tank.kills = 0;
    tank.deaths = 0;
    tank.caps = 0;
  }

  private handleMessage(session: Session, msg: ClientMsg): void {
    const world = this.world!;
    if (msg.t === 'ping') {
      this.send(session, { t: 'pong', n: msg.n });
      return;
    }
    if (msg.t === 'chat') {
      const text = String(msg.text ?? '').slice(0, 240);
      if (!text.trim()) return;
      const faction = session.did ? this.profiles.get(session.did)?.faction ?? 'system' : 'system';
      this.broadcastChat(session.handle ?? 'spectator', text, faction);
      return;
    }
    if (session.role !== 'player' || session.tankId === undefined || this.phase !== 'active') {
      this.send(session, { t: 'error', code: 'not_in_game', msg: 'not an active player' });
      return;
    }
    switch (msg.t) {
      case 'input':
        world.setInput(session.tankId, {
          accel: clamp1(msg.accel),
          turn: clamp1(msg.turn),
          fire: !!msg.fire,
        });
        break;
      case 'builder': {
        const err = world.builderOrder(
          session.tankId,
          msg.order as BuilderOrderKind,
          Math.floor(msg.x),
          Math.floor(msg.y),
        );
        if (err) this.send(session, { t: 'error', code: 'invalid_order', msg: err });
        break;
      }
      case 'builder_recall':
        world.builderRecall(session.tankId);
        break;
      case 'respawn':
        world.respawn(session.tankId, typeof msg.baseId === 'number' ? msg.baseId : undefined);
        break;
      default:
        this.send(session, { t: 'error', code: 'bad_message', msg: `unknown message type` });
    }
  }

  // ---------- tick loop ----------

  private startTicking(): void {
    if (this.interval !== null) return;
    let tickCounter = 0;
    this.interval = setInterval(() => {
      tickCounter++;
      this.tick(tickCounter);
    }, TICK_MS);
  }

  private stopTicking(): void {
    if (this.interval !== null) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private tick(counter: number): void {
    const world = this.world!;
    for (const s of this.sessions) s.msgBudget = MSG_BUDGET_PER_TICK;

    if (this.phase === 'intermission') {
      if (this.nextWarAt && Date.now() >= this.nextWarAt) {
        this.startNewWar();
      }
      return;
    }

    // garrison AI
    if (counter % (TICK_HZ * 2) === 0) balanceNpcs(world);
    for (const tank of world.tanks.values()) {
      if (tank.npc) world.setInput(tank.id, npcThink(world, tank));
    }

    const warMinutes = (Date.now() - world.startedAt) / 60000;
    const result = world.doTick(warMinutes);

    // fan out per-player state
    const stateBase = {
      pills: result.pillsChanged ? world.pills : undefined,
      bases: result.basesChanged ? world.bases : undefined,
      terrain: result.terrainChanges.length ? result.terrainChanges : undefined,
      events: result.events.length ? result.events : undefined,
    };
    for (const session of this.sessions) {
      if (session.role === 'spectator') {
        session.pendingTerrain.push(...result.terrainChanges);
        continue;
      }
      this.send(session, this.stateFor(session, result.mineChanges, stateBase));
    }

    // spectator frames at SPECTATOR_HZ
    if (counter % Math.round(TICK_HZ / SPECTATOR_HZ) === 0) {
      const frame = this.spectateFrame();
      for (const session of this.sessions) {
        if (session.role !== 'spectator') continue;
        this.send(session, { ...frame, terrain: session.pendingTerrain.length ? session.pendingTerrain : undefined });
        session.pendingTerrain = [];
      }
    }

    if (result.warEnded) {
      this.endWar(result.warEnded);
    }

    if (counter % PERSIST_EVERY_TICKS === 0) {
      void this.persist();
    }
  }

  // ---------- war lifecycle ----------

  private endWar(winner: Faction): void {
    const world = this.world!;
    const record: WarRecord = {
      warNumber: world.warNumber,
      seed: world.seed,
      winner,
      startedAt: world.startedAt,
      endedAt: Date.now(),
      durationMinutes: Math.round((Date.now() - world.startedAt) / 60000),
    };
    this.history.push(record);
    for (const p of this.profiles.values()) p.warsFought++;
    for (const tank of world.tanks.values()) if (!tank.npc) this.foldStats(tank);
    this.phase = 'intermission';
    this.nextWarAt = Date.now() + INTERMISSION_SECONDS * 1000;
    this.broadcast({ t: 'war_over', winner, record, nextWarAt: this.nextWarAt });
    void this.persist();
    void this.state.storage.setAlarm(this.nextWarAt);
  }

  private startNewWar(): void {
    const old = this.world!;
    const seed = nextWarSeed(old.seed, old.warNumber + 1);
    this.world = new World(old.warNumber + 1, seed);
    this.phase = 'active';
    this.nextWarAt = null;
    // re-seat connected players in fresh tanks
    for (const session of this.sessions) {
      if (session.role === 'player' && session.did && session.handle) {
        const profile = this.getOrCreateProfile(session.did, session.handle);
        const tank = this.world.addTank(session.did, session.handle, profile.faction, false);
        session.tankId = tank.id;
      }
    }
    balanceNpcs(this.world);
    this.broadcast({ t: 'new_war', war: this.world.warInfo('active', null) });
    for (const session of this.sessions) {
      this.send(session, this.welcomeFor(session));
    }
    void this.persist();
  }

  // ---------- message builders ----------

  private welcomeFor(session: Session): WelcomeMsg {
    const world = this.world!;
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
      you:
        session.role === 'player' && session.did && session.handle && faction && session.tankId !== undefined
          ? { did: session.did, handle: session.handle, faction, tankId: session.tankId }
          : null,
      war: world.warInfo(this.phase, this.nextWarAt),
      map: { w: MAP_SIZE, h: MAP_SIZE, terrain: bytesToBase64(world.terrain) },
      mines: visibleMines,
      pills: world.pills,
      bases: world.bases,
      tick: world.tick,
    };
  }

  private stateFor(
    session: Session,
    mineChanges: [number, number, number][],
    base: { pills?: Pillbox[]; bases?: Base[]; terrain?: [number, number, number][]; events?: StateMsg['events'] },
  ): StateMsg {
    const world = this.world!;
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
        if (!tank.alive) {
          view.respawnIn = Math.max(0, Math.ceil((tank.respawnTick - world.tick) / TICK_HZ));
        }
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

  private spectateFrame(): SpectateMsg {
    const world = this.world!;
    let players = 0;
    let spectators = 0;
    for (const s of this.sessions) (s.role === 'player' ? players++ : spectators++);
    return {
      t: 'spectate',
      tick: world.tick,
      war: world.warInfo(this.phase, this.nextWarAt),
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

  // ---------- plumbing ----------

  private send(session: Session, msg: ServerMsg): void {
    try {
      session.ws.send(JSON.stringify(msg));
    } catch {
      // socket already closing; the close handler cleans up
    }
  }

  private broadcast(msg: ServerMsg): void {
    for (const s of this.sessions) this.send(s, msg);
  }

  private broadcastChat(from: string, text: string, faction: Faction | 'system' = 'system'): void {
    this.broadcast({ t: 'chat', from, faction, text });
  }
}

function round2(n: number): number {
  return Math.round(n * 100) / 100;
}

function clamp1(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}
