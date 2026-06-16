/**
 * GameDO: a single Durable Object instance ("world") owns the entire
 * persistent war — map, entities, profiles, and every live WebSocket.
 *
 * The sim ticks at TICK_HZ only while at least one socket is connected;
 * with nobody watching, the world simply freezes in place (and an alarm
 * still fires to roll intermissions over into new wars).
 *
 * Responsibilities are delegated to three collaborators:
 * - SessionStore: WebSocket session tracking + broadcast plumbing
 * - ViewBuilder: per-player/spectator view computation
 * - WarManager: profiles, war history, victory/new-war transitions
 */
import {
  type BuilderOrderKind,
  type ClientMsg,
  EMOTE_COOLDOWN_MS,
  EMOTES,
  type Faction,
  type PlayerProfile,
  SPECTATOR_HZ,
  type StateMsg,
  TICK_HZ,
  TICK_MS,
  type WarRecord,
} from '@bolo/shared';
import { verifyToken } from '../auth';
import { type Env, sessionSecret } from '../env';
import { NpcController } from '../sim/npc';
import { World } from '../sim/world';
import { StatsSink } from '../stats';
import { fetchProfiles, computeMutuals } from '../social';
import { BountyManager } from './bounty-manager';
import { SessionStore, type Session } from './session-store';
import { ViewBuilder } from './view-builder';
import { WarManager } from './war-manager';

const PERSIST_EVERY_TICKS = TICK_HZ * 30;
const MSG_BUDGET_PER_TICK = 8; // ~80 msgs/sec ceiling per connection
// Per-tick work and memory scale with connection count, and spectators need no
// auth — without a ceiling, an attacker can open unlimited sockets and starve
// the single shared world. Generous relative to the ~12-tank design scale.
const MAX_SESSIONS = 80;
const MAX_SPECTATORS = 64;

/** Builder order kinds, as a runtime guard for untrusted wire input. */
const BUILDER_KINDS: ReadonlySet<string> = new Set(['harvest', 'road', 'wall', 'boat', 'pillbox', 'mine']);

export class GameDO implements DurableObject {
  private state: DurableObjectState;
  private env: Env;
  private world: World | null = null;
  private store = new SessionStore();
  private war = new WarManager();
  private bounty = new BountyManager(this.war.profiles, this.store);
  private views = new ViewBuilder(this.store, this.war.profiles, (did: string) => this.computeNemesis(did), (viewerDid: string, targetDid: string) => this.bounty.isBountyTargetFor(viewerDid, targetDid));
  private npc = new NpcController();
  private phase: 'active' | 'intermission' = 'active';
  private nextWarAt: number | null = null;
  /**
   * Alarm-driven tick loop: instead of setInterval (whose CPU time accumulates
   * against the originating /ws invocation until the DO is hard-reset), each
   * alarm() fire is a fresh invocation with its own CPU budget. The DO stays
   * in memory between alarms (it holds active WebSockets), so in-memory state
   * (World, SessionStore, etc.) survives across ticks.
   */
  private ticking = false;
  private tickCounter = 0;
  /** True when a social data refresh is needed (set on connect, cleared by tick). */
  private socialRefreshPending = false;
  /** Tick counter at which the last social refresh ran (for debounce spacing). */
  private lastSocialRefreshTick = 0;
  private loaded: Promise<void>;
  private statsSink: StatsSink;

  constructor(state: DurableObjectState, env: Env) {
    this.state = state;
    this.env = env;
    this.statsSink = new StatsSink(env.HONEYCOMB_API_KEY, env.HONEYCOMB_DATASET ?? 'atbolo-sim');
    this.loaded = this.load();
  }

  private get profiles(): Map<string, PlayerProfile> {
    return this.war.profiles;
  }

  private get fighters(): Set<string> {
    return this.war.fighters;
  }

  private get history(): WarRecord[] {
    return this.war.history;
  }

  private async load(): Promise<void> {
    const [meta, terrain, mines, profiles, history] = await Promise.all([
      this.state.storage.get<Record<string, unknown>>('meta'),
      this.state.storage.get<Uint8Array>('terrain'),
      this.state.storage.get<Uint8Array>('mines'),
      this.state.storage.get<Record<string, PlayerProfile>>('profiles'),
      this.state.storage.get<WarRecord[]>('history'),
    ]);
    // Populate the EXISTING profiles map in place — never reassign it. ViewBuilder
    // captured this.war.profiles by reference at construction; swapping in a new Map
    // here would leave it reading a stale (empty) map, so welcomeFor could never
    // resolve a player's faction and every spawn would come back as a spectator.
    if (profiles) for (const [did, prof] of Object.entries(profiles)) this.war.profiles.set(did, prof);
    if (history) this.war.history = history;
    if (meta && terrain && mines) {
      this.phase = (meta.phase as 'active' | 'intermission') ?? 'active';
      this.nextWarAt = (meta.nextWarAt as number | null) ?? null;
      this.war.fighters = new Set((meta.fighters as string[]) ?? []);
      for (const prof of this.war.profiles.values()) prof.warsWon ??= 0;
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
        fighters: [...this.war.fighters],
        world: this.world.serializeMeta(),
      },
      terrain: this.world.terrain,
      mines: this.world.mines,
      profiles: Object.fromEntries(this.war.profiles),
      history: this.war.history,
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

    // dev-only: seed profiles/history for UI work (gated again in the Worker)
    if (url.pathname === '/seed' && request.method === 'POST' && this.env.DEV_AUTH === '1') {
      const body = (await request.json().catch(() => ({}))) as {
        profiles?: PlayerProfile[];
        history?: WarRecord[];
      };
      for (const p of body.profiles ?? []) {
        if (typeof p?.did === 'string') this.war.profiles.set(p.did, { ...p, warsWon: p.warsWon ?? 0 });
      }
      if (body.history) this.war.history.push(...body.history);
      await this.persist();
      return Response.json({ ok: true, profiles: this.war.profiles.size });
    }

    if (url.pathname === '/status') {
      const world = this.world!;
      const { players, spectators } = this.store.playerSpectatorCounts();

      // Merge live session stats (kills/caps/deaths on the Tank object) into
      // the persistent profile stats. foldStats only runs on disconnect or
      // war end, so without this the leaderboard is stale for connected
      // players — their current-session performance wouldn't show up.
      const liveStats = new Map<string, { kills: number; deaths: number; caps: number }>();
      for (const session of this.store) {
        if (session.role !== 'player' || session.tankId === undefined || !session.did) continue;
        const tank = world.tanks.get(session.tankId);
        if (tank) liveStats.set(session.did, { kills: tank.kills, deaths: tank.deaths, caps: tank.caps });
      }

      const leaderboard = [...this.war.profiles.values()]
        .map((p) => {
          const live = liveStats.get(p.did);
          if (!live) return p;
          return { ...p, kills: p.kills + live.kills, deaths: p.deaths + live.deaths, caps: p.caps + live.caps };
        })
        .filter((p) => p.kills + p.caps > 0)
        .sort((a, b) => {
          const dr = b.kills + b.caps * 3 - (a.kills + a.caps * 3);
          if (dr !== 0) return dr;
          // tiebreaker: fewer deaths first (same rating, more efficient), then earlier veteran
          if (a.deaths !== b.deaths) return a.deaths - b.deaths;
          return a.firstSeen - b.firstSeen;
        })
        .slice(0, 50);
      return Response.json({
        war: world.warInfo(this.phase, this.nextWarAt),
        online: { players, spectators },
        history: this.war.history.slice(-20).reverse(),
        leaderboard,
      });
    }

    if (url.pathname === '/regenerate') {
      // Debug: generate a fresh map with a new seed and restart the war.
      const oldWar = this.world?.warNumber ?? 0;
      this.world = new World(oldWar + 1, (Date.now() ^ 0xb010b010) >>> 0);
      this.npc.reset();
      this.phase = 'active';
      this.nextWarAt = null;
      this.npc.balanceNpcs(this.world);
      this.store.broadcast({ t: 'new_war', war: this.world.warInfo('active', null) });
      for (const session of this.store) {
        this.store.send(session, this.views.welcomeFor(this.world, session, this.phase, this.nextWarAt));
      }
      void this.persist();
      return Response.json({ ok: true, warNumber: this.world.warNumber, seed: this.world.seed });
    }

    return new Response('not found', { status: 404 });
  }

  async alarm(): Promise<void> {
    await this.loaded;

    // Game tick (alarm-driven loop): simulate one tick, then reschedule if
    // sessions are still active. Each alarm fire is a fresh invocation with
    // its own CPU budget — this is why we replaced setInterval, whose CPU
    // accumulated against the originating /ws request until the DO was reset.
    if (this.ticking) {
      this.tickCounter++;
      try {
        this.tick(this.tickCounter);
      } catch (err) {
        console.error(`tick ${this.tickCounter} (war ${this.world?.warNumber}) threw`, err);
      }
      // Reschedule for the next tick. The DO stays in memory (WebSockets hold
      // it alive), so state is preserved across alarm fires.
      if (this.store.size > 0) {
        this.state.storage.setAlarm(Date.now() + TICK_MS);
      } else {
        // Last session dropped between this alarm and now — stop ticking.
        this.ticking = false;
        this.statsSink.flush();
      }
      return;
    }

    // Intermission alarm: roll over to the next war when no sockets are
    // connected to drive the tick loop.
    if (this.phase === 'intermission' && this.nextWarAt && Date.now() >= this.nextWarAt) {
      this.startNewWar();
      await this.persist();
    }
  }

  // ---------- sockets ----------

  private handleSocket(ws: WebSocket): void {
    ws.accept();
    const session: Session = {
      ws,
      role: 'spectator',
      pendingTerrain: [],
      msgBudget: MSG_BUDGET_PER_TICK,
      lastEmoteAt: 0,
      mutuals: new Set(),
    };
    let helloed = false;

    ws.addEventListener('message', (ev) => {
      let msg: ClientMsg;
      try {
        msg = JSON.parse(typeof ev.data === 'string' ? ev.data : '') as ClientMsg;
      } catch {
        this.store.send(session, { t: 'error', code: 'bad_message', msg: 'invalid JSON' });
        return;
      }
      if (!helloed) {
        if (msg.t !== 'hello') {
          this.store.send(session, { t: 'error', code: 'bad_message', msg: 'expected hello' });
          ws.close(1002, 'expected hello');
          return;
        }
        helloed = true;
        this.handleHello(session, msg.token, msg.role === 'player' ? 'player' : 'spectator', msg.client).catch(
          (err) => {
            console.error('[ws] handleHello failed:', err);
            try {
              this.store.send(session, { t: 'error', code: 'bad_message', msg: String(err?.message ?? err) });
            } catch {
              /* socket may already be closed */
            }
          },
        );
        return;
      }
      if (--session.msgBudget < 0) return; // silently drop floods
      this.handleMessage(session, msg);
    });

    const drop = () => {
      if (!this.store.has(session)) return;
      this.store.remove(session);
      // remove this player from other sessions' mutual sets
      if (session.did) {
        for (const other of this.store) {
          if (other.mutuals.has(session.did)) {
            other.mutuals.delete(session.did);
            this.store.send(other, { t: 'mutuals', dids: [...other.mutuals] });
          }
        }
      }
      if (session.tankId !== undefined) {
        const tank = this.world?.tanks.get(session.tankId);
        if (tank) this.war.foldStats(tank);
        this.world?.removeTank(session.tankId);
      }
      if (this.store.size === 0) {
        this.stopTicking();
        void this.persist();
      }
    };
    ws.addEventListener('close', drop);
    ws.addEventListener('error', drop);
  }

  private async handleHello(
    session: Session,
    token: string | undefined,
    role: 'player' | 'spectator',
    client?: string,
  ): Promise<void> {
    const world = this.world!;
    // Capacity guard (closes the unauthenticated-spectator flood vector). Reject
    // before auth/addTank so an over-cap socket never enters the tick loop.
    const { spectators } = this.store.playerSpectatorCounts();
    if (this.store.size >= MAX_SESSIONS || (role === 'spectator' && spectators >= MAX_SPECTATORS)) {
      this.store.send(session, { t: 'error', code: 'at_capacity', msg: 'world is at capacity' });
      session.ws.close(4002, 'at capacity');
      return;
    }
    if (role === 'player') {
      const payload = token ? await verifyToken(sessionSecret(this.env), token) : null;
      if (!payload) {
        this.store.send(session, { t: 'error', code: 'auth_failed', msg: 'invalid or expired token' });
        session.ws.close(4001, 'auth failed');
        return;
      }
      // one connection per identity: the newest wins
      for (const other of this.store) {
        if (other.did === payload.did) {
          other.ws.close(4000, 'signed in from another connection');
        }
      }
      const profile = this.war.getOrCreateProfile(payload.did, payload.handle, this.store);
      profile.handle = payload.handle;
      profile.lastSeen = Date.now();
      session.role = 'player';
      session.did = payload.did;
      session.handle = payload.handle;
      if (this.phase === 'active') {
        const clientKind = client === 'keyboard' || client === 'touch' || client === 'bot' ? client : 'unknown';
        const tank = world.addTank(payload.did, payload.handle, profile.faction, false, clientKind);
        session.tankId = tank.id;
        this.war.fighters.add(payload.did);
      }
    } else {
      session.role = 'spectator';
    }
    this.store.add(session);
    this.store.send(session, this.views.welcomeFor(world, session, this.phase, this.nextWarAt));
    this.store.broadcastChat('system', `${session.handle ?? 'a spectator'} ${role === 'player' ? 'joined the war' : 'is watching'}`);
    // Defer social data fetching out of the connect path entirely.
    // On cold KV cache these calls can take seconds (or hang up to 30s),
    // and a Durable Object's input gate blocks the alarm/tick until they
    // settle — freezing the game load. The tick loop picks this up and
    // runs a debounced refresh within 5s instead.
    this.socialRefreshPending = true;
    // send current active bounties
    this.bounty.sendBountiesTo(session);
    this.startTicking();
  }

  // ---------- social ----------

  /**
   * Fetch profiles for all connected real-DID players and broadcast a
   * SocialDataMsg to everyone. KV-cached so reconnects are fast.
   * Called on player connect and when a new player joins.
   */
  private async sendSocialData(): Promise<void> {
    const dids = this.connectedDids();
    if (dids.length === 0) return;
    const profiles = await fetchProfiles(dids, this.env);
    const obj: Record<string, { avatar?: string; displayName?: string; handle?: string }> = {};
    for (const did of dids) {
      const p = profiles.get(did);
      if (p) {
        obj[did] = { avatar: p.avatar, displayName: p.displayName, handle: p.handle };
      }
    }
    if (Object.keys(obj).length > 0) {
      this.store.broadcast({ t: 'social_data', profiles: obj });
    }
  }

  /** DIDs of all connected player sessions with real atproto DIDs. */
  private connectedDids(): string[] {
    const out: string[] = [];
    for (const s of this.store) {
      if (s.role === 'player' && s.did && (s.did.startsWith('did:plc:') || s.did.startsWith('did:web:'))) {
        out.push(s.did);
      }
    }
    return out;
  }

  /**
   * Compute mutuals for a newly-connected player and update existing sessions.
   * Mutuals are symmetric, so when the new player is mutual with an existing
   * player, both sessions get updated.
   */
  private async updateMutualsOnConnect(session: Session): Promise<void> {
    if (!session.did || !session.did.startsWith('did:plc:') && !session.did.startsWith('did:web:')) return;
    const others = this.connectedDids().filter((d) => d !== session.did);
    if (others.length === 0) return;

    const mutualDids = await computeMutuals(session.did, others, this.env);
    session.mutuals = mutualDids;

    // symmetry: for each mutual, add the new player to their session's set too
    for (const s of this.store) {
      if (s === session || !s.did) continue;
      if (mutualDids.has(s.did)) {
        s.mutuals.add(session.did);
        this.store.send(s, { t: 'mutuals', dids: [...s.mutuals] });
      }
    }

    // send the new player their own mutuals list
    if (session.mutuals.size > 0) {
      this.store.send(session, { t: 'mutuals', dids: [...session.mutuals] });
    }
  }

  /**
   * Debounced social data refresh, invoked from the tick loop instead of the
   * connect path. Broadcasts profiles to all sessions and computes mutuals for
   * any session that joined since the last refresh. Running here (inside the
   * alarm callback) means the I/O is charged to the alarm's own invocation,
   * not stacked behind a WebSocket message — the input gate stays responsive.
   */
  private async refreshSocialData(): Promise<void> {
    // Profile broadcast (existing sendSocialData, unchanged)
    await this.sendSocialData();

    // Mutuals: compute for sessions that haven't been resolved yet.
    for (const session of this.store) {
      if (session.role !== 'player' || !session.did) continue;
      if (!session.did.startsWith('did:plc:') && !session.did.startsWith('did:web:')) continue;
      if (session.mutuals.size > 0 || session.socialResolved) continue;
      session.socialResolved = true;
      void this.updateMutualsOnConnect(session);
    }
  }

  /**
   * Process kill events for rivalry tracking. Updates each player's rivalry
   * record on their profile and emits revenge/payback events when conditions
   * are met. Returns extra events to inject into the per-player state.
   */
  private processRivalries(events: { e: string; killerDid?: string; victimDid?: string; killer?: string; victim?: string }[]): { e: 'revenge' | 'payback'; killerHandle: string; victimHandle: string }[] {
    const extra: { e: 'revenge' | 'payback'; killerHandle: string; victimHandle: string }[] = [];
    for (const ev of events) {
      if (ev.e !== 'kill' || !ev.killerDid || !ev.victimDid) continue;
      const killerProfile = this.profiles.get(ev.killerDid);
      const victimProfile = this.profiles.get(ev.victimDid);
      if (!killerProfile || !victimProfile) continue;

      // update rivalry records on both profiles
      killerProfile.rivalries ??= {};
      victimProfile.rivalries ??= {};
      const kr = (killerProfile.rivalries[ev.victimDid] ??= { k: 0, d: 0 });
      const vr = (victimProfile.rivalries[ev.killerDid] ??= { k: 0, d: 0 });
      kr.k++;
      vr.d++;

      // revenge: killer just killed their top nemesis (the person who killed them most)
      let nemesisDid: string | null = null;
      let nemesisDeaths = 0;
      for (const [otherDid, counts] of Object.entries(killerProfile.rivalries)) {
        if (counts.d > nemesisDeaths) {
          nemesisDeaths = counts.d;
          nemesisDid = otherDid;
        }
      }
      if (nemesisDid && nemesisDid === ev.victimDid && nemesisDeaths >= 3) {
        extra.push({ e: 'revenge', killerHandle: ev.killer!, victimHandle: ev.victim! });
      }

      // payback: killer just killed someone who killed them at least once this war
      if (vr.k > 0 && kr.d > 0) {
        extra.push({ e: 'payback', killerHandle: ev.killer!, victimHandle: ev.victim! });
      }
    }
    return extra;
  }

  /**
   * Compute a player's top nemesis (the DID that has killed them the most).
   * Returns null if no rivalries exist.
   */
  private computeNemesis(did: string): { did: string; handle: string; killedBy: number; youKilled: number; online: boolean } | null {
    const profile = this.profiles.get(did);
    if (!profile?.rivalries) return null;
    let nemesisDid: string | null = null;
    let killedBy = 0;
    for (const [otherDid, counts] of Object.entries(profile.rivalries)) {
      if (counts.d > killedBy) {
        killedBy = counts.d;
        nemesisDid = otherDid;
      }
    }
    if (!nemesisDid || killedBy === 0) return null;
    const nemesisProfile = this.profiles.get(nemesisDid);
    if (!nemesisProfile) return null;
    const online = [...this.store].some((s) => s.did === nemesisDid);
    const youKilled = profile.rivalries[nemesisDid]?.k ?? 0;
    return { did: nemesisDid, handle: nemesisProfile.handle, killedBy, youKilled, online };
  }

  // Bounty logic lives in BountyManager (this.bounty). See bounty-manager.ts.

  private handleMessage(session: Session, msg: ClientMsg): void {
    const world = this.world!;
    if (msg.t === 'ping') {
      this.store.send(session, { t: 'pong', n: msg.n });
      return;
    }
    if (msg.t === 'chat') {
      const text = String(msg.text ?? '').slice(0, 240);
      if (!text.trim()) return;
      const faction = session.did ? this.profiles.get(session.did)?.faction ?? 'system' : 'system';
      this.store.broadcastChat(session.handle ?? 'spectator', text, faction);
      return;
    }
    if (msg.t === 'emote') {
      if (session.tankId === undefined) return;
      const kind = EMOTES.find((e) => e === msg.kind);
      if (!kind) return;
      const now = Date.now();
      if (now - session.lastEmoteAt < EMOTE_COOLDOWN_MS) return;
      session.lastEmoteAt = now;
      this.store.broadcast({ t: 'emoted', tankId: session.tankId, kind });
      return;
    }
    if (msg.t === 'bounty') {
      if (!session.did) return;
      this.bounty.escalate(session.did, msg.targetDid);
      return;
    }
    if (session.role !== 'player' || session.tankId === undefined || this.phase !== 'active') {
      this.store.send(session, { t: 'error', code: 'not_in_game', msg: 'not an active player' });
      return;
    }
    switch (msg.t) {
      case 'input':
        world.setInput(session.tankId, {
          accel: clamp1(msg.accel),
          turn: 0, // unused for player tanks (heading is client-authoritative)
          fire: !!msg.fire,
        });
        if (typeof msg.dir === 'number' && Number.isFinite(msg.dir)) {
          world.setHeading(session.tankId, msg.dir);
        }
        break;
      case 'builder': {
        if (!BUILDER_KINDS.has(msg.order) || !Number.isFinite(msg.x) || !Number.isFinite(msg.y)) {
          this.store.send(session, { t: 'error', code: 'invalid_order', msg: 'malformed builder order' });
          break;
        }
        const err = world.builderOrder(
          session.tankId,
          msg.order as BuilderOrderKind,
          Math.floor(msg.x),
          Math.floor(msg.y),
        );
        if (err) this.store.send(session, { t: 'error', code: 'invalid_order', msg: err });
        break;
      }
      case 'builder_recall':
        world.builderRecall(session.tankId);
        break;
      case 'range':
        world.setGunRange(session.tankId, Number(msg.range));
        break;
      case 'respawn':
        world.respawn(session.tankId, typeof msg.baseId === 'number' ? msg.baseId : undefined);
        break;
      default:
        this.store.send(session, { t: 'error', code: 'bad_message', msg: `unknown message type` });
    }
  }

  // ---------- tick loop ----------

  private startTicking(): void {
    if (this.ticking) return;
    this.ticking = true;
    this.tickCounter = 0;
    // Kick off the alarm-driven tick loop. Each alarm() fire is a separate
    // invocation with its own CPU budget, so CPU can't accumulate across
    // ticks and trigger a DO reset.
    this.state.storage.setAlarm(Date.now() + TICK_MS);
  }

  private stopTicking(): void {
    if (!this.ticking) return;
    this.ticking = false;
    // No need to cancel the alarm: the next alarm() fire will see ticking=false
    // and simply not reschedule. Flushing stats here ensures no data is lost.
    this.statsSink.flush();
  }

  private tick(counter: number): void {
    const world = this.world!;
    for (const s of this.store) s.msgBudget = MSG_BUDGET_PER_TICK;

    if (this.phase === 'intermission') {
      if (this.nextWarAt && Date.now() >= this.nextWarAt) {
        this.startNewWar();
      }
      return;
    }

    // garrison AI
    if (counter % (TICK_HZ * 2) === 0) this.npc.balanceNpcs(world);
    this.npc.preTick(world); // build team awareness before individual decisions
    for (const tank of world.tanks.values()) {
      if (tank.npc) world.setInput(tank.id, this.npc.think(world, tank));
    }
    this.npc.emitState(world);

    // War age is SIMULATED time, not wall-clock: the sim freezes when no socket
    // is connected, so wall-clock would jump warMinutes forward across an idle
    // gap and slam bases with full late-war attrition (and satisfy the victory
    // min-duration) on the first reconnect tick. Tick-based also matches the
    // dominance countdown, which is already tick-based.
    const warMinutes = world.tick / TICK_HZ / 60;
    const result = world.doTick(warMinutes);

    // rivalry tracking: update kill counts between real players and emit
    // revenge/payback events for per-viewer event injection
    const extraEvents = this.processRivalries(result.events);

    // bounty system: create bounties from mutual kills, check claims, expire
    this.bounty.processBounties(result.events, this.world!);

    if (this.statsSink.enabled && result.stats.length) {
      const { players } = this.store.playerSpectatorCounts();
      const allStats = [...result.stats, ...this.npc.drainStats()];
      for (const ev of allStats) {
        this.statsSink.push({
          ...ev,
          war_number: world.warNumber,
          war_minute: Math.round(warMinutes * 10) / 10,
          online_players: players,
        });
      }
    }
    if (counter % (TICK_HZ * 10) === 0) this.statsSink.flush();

    // shared event/pills/bases/terrain base for all player state messages
    const stateBase = {
      pills: result.pillsChanged ? world.pills : undefined,
      bases: result.basesChanged ? world.bases : undefined,
      terrain: result.terrainChanges.length ? result.terrainChanges : undefined,
      events: [...result.events, ...extraEvents].length ? [...result.events, ...extraEvents] : undefined,
    };

    // fan out per-player state with per-viewer mutual_killed events
    for (const session of this.store) {
      if (session.role === 'spectator') {
        session.pendingTerrain.push(...result.terrainChanges);
        continue;
      }
      // inject mutual_killed events for this viewer's mutuals
      const perViewerEvents: StateMsg['events'] = [];
      if (session.did) {
        for (const ev of result.events) {
          if (ev.e === 'kill' && ev.victimDid && ev.killerDid && session.mutuals.has(ev.victimDid)) {
            perViewerEvents.push({
              e: 'mutual_killed',
              killerDid: ev.killerDid,
              killerHandle: ev.killer,
              victimDid: ev.victimDid,
              victimHandle: ev.victim,
              x: ev.x ?? 0,
              y: ev.y ?? 0,
              cause: ev.cause,
            });
          } else if (ev.e === 'base_captured' && ev.byDid && session.mutuals.has(ev.byDid)) {
            perViewerEvents.push({
              e: 'mutual_capture',
              baseId: ev.baseId,
              byDid: ev.byDid,
              byHandle: ev.handle,
              x: ev.x ?? 0,
              y: ev.y ?? 0,
            });
          }
        }
      }
      const sessionBase = perViewerEvents.length > 0
        ? { ...stateBase, events: [...(stateBase.events ?? []), ...perViewerEvents] }
        : stateBase;
      this.store.send(session, this.views.stateFor(world, session, result.mineChanges, sessionBase));
    }

    // spectator frames at SPECTATOR_HZ; most spectators get byte-identical
    // frames, so serialize the terrain-free variant once
    if (counter % Math.round(TICK_HZ / SPECTATOR_HZ) === 0) {
      const frame = this.views.spectateFrame(world, this.phase, this.nextWarAt);
      let plainRaw: string | null = null;
      for (const session of this.store) {
        if (session.role !== 'spectator') continue;
        if (session.pendingTerrain.length) {
          this.store.send(session, { ...frame, terrain: session.pendingTerrain });
          session.pendingTerrain = [];
        } else {
          plainRaw ??= JSON.stringify(frame);
          this.store.sendRaw(session, plainRaw);
        }
      }
    }

    // Debounced social refresh: coalesces joins into one fetch every 5s
    // so the connect path performs zero social I/O and the input gate
    // never blocks the first tick.
    if (this.socialRefreshPending && counter - this.lastSocialRefreshTick >= TICK_HZ * 5) {
      this.socialRefreshPending = false;
      this.lastSocialRefreshTick = counter;
      void this.refreshSocialData();
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
    // emit war-end telemetry before the intermission transition
    this.statsSink.push({
      name: 'war_end',
      winner,
      duration_minutes: Math.round(world.tick / TICK_HZ / 60),
      total_kills: [...world.tanks.values()].reduce((s, t) => s + t.kills, 0),
      total_captures: [...world.tanks.values()].reduce((s, t) => s + t.caps, 0),
      war_number: world.warNumber,
    });
    this.statsSink.flush();
    const { nextWarAt } = this.war.endWar(world, winner, this.store);
    this.phase = 'intermission';
    this.nextWarAt = nextWarAt;
    void this.state.storage.setAlarm(this.nextWarAt);
    void this.persist();
  }

  private startNewWar(): void {
    const old = this.world!;
    this.world = this.war.startNewWar(old, this.store);
    this.npc.reset(); // the new World restarts tank ids at 1; drop stale AI memory
    // Clear bounties from the previous war. The new world's tick starts at 0,
    // so old bounties with high createdAtTick values would survive expiry math
    // (tick - createdAtTick would be negative, never exceeding TTL).
    this.bounty.clear();
    this.phase = 'active';
    this.nextWarAt = null;
    this.npc.balanceNpcs(this.world);
    this.store.broadcast({ t: 'new_war', war: this.world.warInfo('active', null) });
    for (const session of this.store) {
      this.store.send(session, this.views.welcomeFor(this.world, session, this.phase, this.nextWarAt));
    }
    void this.persist();
  }
}

function clamp1(n: unknown): number {
  const v = Number(n);
  return Number.isFinite(v) ? Math.max(-1, Math.min(1, v)) : 0;
}
