/** Top-down renderer for players: terrain cache + entities + effects. */
import {
  BASE_MAX_ARMOR_STOCK,
  BASE_MAX_HP,
  BASE_MAX_SHELL_STOCK,
  EMOTE_SHOW_MS,
  type Faction,
  hash32,
  MAP_SIZE,
  PILL_MAX_HP,
  SHELL_RANGE,
  SHELL_SPEED,
  PLAYER_VIEW_RADIUS,
  TANK_RADIUS,
  TICK_MS,
} from '@bolo/shared';
import { BOOM_FRAMES, EMOTE_SPRITES, sprites, type SpriteKey } from './sprites';
import type { GameState, InterpTank } from './state';
import { TILE_PX, TileCache } from './tiles';

export const FACTION_COLORS: Record<Faction | 'neutral', string> = {
  dawn: '#e8a33d',
  dusk: '#9b7df0',
  neutral: '#9aa3ad',
};

const FACTION_DARK: Record<Faction | 'neutral', string> = {
  dawn: '#a06b1c',
  dusk: '#5f48a8',
  neutral: '#5d646b',
};

const TRACER_COLORS: Record<string, string> = {
  dawn: 'rgba(255,200,120,0.5)',
  dusk: 'rgba(190,160,255,0.5)',
  neutral: 'rgba(220,226,236,0.45)',
};

export class Renderer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles = new TileCache();
  private vignette: CanvasGradient | null = null;
  private fog: CanvasGradient | null = null;
  /** fading tread-mark decals stamped behind moving tanks */
  private trackMarks: { x: number; y: number; dir: number; at: number }[] = [];
  private lastTrack = new Map<number, { x: number; y: number }>();
  private dpr = 1;
  /** viewport size in CSS pixels */
  private vw = 0;
  private vh = 0;
  scale = 26; // screen px per tile
  /**
   * Ambient color grade, multiplied over the whole frame: one knob that sits
   * the bright Kenney art in BOLO's moodier dusk palette. White = off.
   */
  ambient = '#aab3c8';
  camX = MAP_SIZE / 2;
  camY = MAP_SIZE / 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const fit = () => {
      this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
      // The CSS sizes the canvas to 100dvh/dvw, so its client box already
      // tracks mobile Safari's collapsing toolbar — measure that rather than
      // innerHeight (which on iOS includes the area behind the chrome).
      this.vw = canvas.clientWidth || innerWidth;
      this.vh = canvas.clientHeight || innerHeight;
      canvas.width = Math.round(this.vw * this.dpr);
      canvas.height = Math.round(this.vh * this.dpr);
      // zoom out a touch on small screens so enough battlefield is visible
      this.scale = Math.min(this.vw, this.vh) < 540 ? 22 : 34;
      this.vignette = null;
      this.fog = null;
    };
    addEventListener('resize', fit);
    addEventListener('orientationchange', fit);
    globalThis.visualViewport?.addEventListener('resize', fit);
    fit();
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [this.camX + (sx - this.vw / 2) / this.scale, this.camY + (sy - this.vh / 2) / this.scale];
  }

  frame(state: GameState, now: number): void {
    const ctx = this.ctx;
    const w = this.vw;
    const h = this.vh;
    ctx.setTransform(this.dpr, 0, 0, this.dpr, 0, 0);
    this.tiles.sync(state);

    // camera follows your tank — predicted for instant response, interpolated for others
    const meInterp = state.you ? state.tanks.get(state.you.tankId) : undefined;
    if (meInterp) {
      const p = state.predictedSelf(now);
      this.camX = p.x;
      this.camY = p.y;
    }

    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, w, h);

    // map
    const sx = this.camX * TILE_PX - (w / 2) * (TILE_PX / this.scale);
    const sy = this.camY * TILE_PX - (h / 2) * (TILE_PX / this.scale);
    ctx.imageSmoothingEnabled = false;
    this.tiles.drawTo(ctx, sx, sy, w * (TILE_PX / this.scale), h * (TILE_PX / this.scale), 0, 0, w, h);

    const toScreen = (wx: number, wy: number): [number, number] => [
      w / 2 + (wx - this.camX) * this.scale,
      h / 2 + (wy - this.camY) * this.scale,
    ];
    const onScreen = (px: number, py: number, m = 60) => px > -m && py > -m && px < w + m && py < h + m;

    this.drawTracks(state, now, toScreen, onScreen);

    // known mines
    for (const i of state.mines) {
      const [px, py] = toScreen((i % MAP_SIZE) + 0.5, Math.floor(i / MAP_SIZE) + 0.5);
      if (!onScreen(px, py, 20)) continue;
      this.drawMine(px, py, now);
    }

    for (const b of state.bases) {
      const [px, py] = toScreen(b.x + 0.5, b.y + 0.5);
      if (onScreen(px, py)) {
        const supply = (b.armorStock + b.shellStock) / (BASE_MAX_ARMOR_STOCK + BASE_MAX_SHELL_STOCK);
        this.drawBase(px, py, b.owner, b.hp, supply, now);
      }
    }

    for (const p of state.pills) {
      if (p.inTank) continue;
      const [px, py] = toScreen(p.x + 0.5, p.y + 0.5);
      if (onScreen(px, py)) this.drawPill(px, py, p.owner, p.hp, now);
    }

    // builders lerp from their previous snapshot position over one tick
    const bt = Math.min(1, (now - state.buildersAt) / TICK_MS);
    for (const b of state.builders) {
      const prev = state.buildersPrev.get(b.tankId);
      const bx = prev ? prev.x + (b.x - prev.x) * bt : b.x;
      const by = prev ? prev.y + (b.y - prev.y) * bt : b.y;
      const [px, py] = toScreen(bx, by);
      if (onScreen(px, py, 20)) this.drawBuilder(px, py, b.faction, b.phase, now);
    }

    for (const it of state.tanks.values()) {
      if (!it.cur.alive) continue;
      this.drawTank(state, it, now, toScreen, onScreen);
    }

    // shells: faction-tinted tracer + bullet sprite. Snapshot positions only
    // change at 10Hz — far too coarse for the fastest object on screen — so
    // extrapolate along the flight path between snapshots (capped so a shell
    // that detonated server-side doesn't sail on for long)
    const shellLead = Math.min((now - state.shellsAt) / 1000, 0.15) * SHELL_SPEED;
    for (const s of state.shells) {
      const [px, py] = toScreen(s.x + Math.cos(s.dir) * shellLead, s.y + Math.sin(s.dir) * shellLead);
      if (!onScreen(px, py, 20)) continue;
      const tail = 0.55 * this.scale;
      ctx.strokeStyle = TRACER_COLORS[s.f] ?? TRACER_COLORS.neutral;
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - Math.cos(s.dir) * tail, py - Math.sin(s.dir) * tail);
      ctx.lineTo(px, py);
      ctx.stroke();
      const bullet = sprites.images[s.f === 'dawn' ? 'bulletDawn' : s.f === 'dusk' ? 'bulletDusk' : 'bulletNeutral'];
      ctx.save();
      ctx.translate(px, py);
      ctx.rotate(s.dir + Math.PI / 2); // sprite points north
      const k = this.scale / 38;
      ctx.drawImage(bullet, -2 * k * 2.4, -5 * k * 2.4, 4 * k * 2.4, 10 * k * 2.4);
      ctx.restore();
    }

    // gun-range cursor: Bolo's targeting cursor — where your shells land,
    // at max range along the hull axis
    if (meInterp && meInterp.cur.alive) {
      const p = state.predictedSelf(now);
      const cross = sprites.images.crosshairBase;
      const range = meInterp.cur.gunRange ?? SHELL_RANGE;
      const [cxs, cys] = toScreen(p.x + Math.cos(p.dir) * range, p.y + Math.sin(p.dir) * range);
      const cs = this.scale * 0.85;
      ctx.save();
      ctx.globalAlpha = 0.75;
      ctx.drawImage(cross, cxs - cs / 2, cys - cs / 2, cs, cs);
      ctx.restore();
    }

    // explosions
    state.booms = state.booms.filter((b) => now - b.at < 500);
    for (const b of state.booms) {
      const t = (now - b.at) / 500;
      const [px, py] = toScreen(b.x, b.y);
      if (!onScreen(px, py)) continue;
      this.drawBoom(px, py, t, b.kind, hash32(Math.round(b.x * 7), Math.round(b.y * 7)));
    }

    // death markers for mutual kills: skull icon that fades over 30s
    state.deathMarkers = state.deathMarkers.filter((d) => now - d.at < 30000);
    for (const d of state.deathMarkers) {
      const age = now - d.at;
      const fade = age > 25000 ? (30000 - age) / 5000 : age < 500 ? age / 500 : 1;
      const [px, py] = toScreen(d.x, d.y);
      if (!onScreen(px, py, 30)) continue;
      ctx.save();
      ctx.globalAlpha = fade * 0.85;
      // skull crosshair circle
      ctx.strokeStyle = '#e85d5d';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.arc(px, py, this.scale * 0.4, 0, Math.PI * 2);
      ctx.stroke();
      // skull text
      ctx.fillStyle = '#e85d5d';
      ctx.font = `${Math.round(this.scale * 0.5)}px monospace`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('☠', px, py);
      // label
      ctx.font = '9px monospace';
      ctx.fillStyle = 'rgba(7,8,12,0.7)';
      const label = `@${d.victimHandle}`;
      const tw = ctx.measureText(label).width;
      ctx.fillRect(px - tw / 2 - 2, py + this.scale * 0.4 + 2, tw + 4, 11);
      ctx.fillStyle = '#e85d5d';
      ctx.fillText(label, px, py + this.scale * 0.4 + 10);
      ctx.restore();
    }

    // ambient grade before fog, so fog stays near-black on top of it
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = this.ambient;
    ctx.fillRect(0, 0, w, h);
    ctx.globalCompositeOperation = 'source-over';

    if (meInterp) {
      // fog of war: vision fades out and dies just inside the server's entity
      // cull ring (PLAYER_VIEW_RADIUS), so the screen edge can't out-see your
      // intel feed and tanks never visibly pop in at the cull boundary
      if (!this.fog) {
        const inner = (PLAYER_VIEW_RADIUS - 10) * this.scale;
        const outer = (PLAYER_VIEW_RADIUS - 2) * this.scale;
        const g = ctx.createRadialGradient(w / 2, h / 2, inner, w / 2, h / 2, outer);
        g.addColorStop(0, 'rgba(7,8,12,0)');
        g.addColorStop(0.55, 'rgba(7,8,12,0.55)');
        g.addColorStop(1, 'rgba(7,8,12,0.97)');
        this.fog = g;
      }
      ctx.fillStyle = this.fog;
      ctx.fillRect(0, 0, w, h);
    } else {
      // soft vignette for atmosphere (spectating / no tank)
      if (!this.vignette) {
        const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
        g.addColorStop(0, 'rgba(0,0,0,0)');
        g.addColorStop(1, 'rgba(0,0,0,0.42)');
        this.vignette = g;
      }
      ctx.fillStyle = this.vignette;
      ctx.fillRect(0, 0, w, h);
    }
  }

  /** Stamp tread marks behind moving tanks and draw them fading out. */
  private drawTracks(
    state: GameState,
    now: number,
    toScreen: (x: number, y: number) => [number, number],
    onScreen: (px: number, py: number, m?: number) => boolean,
  ): void {
    const FADE_MS = 9000;
    const SPACING = 0.55; // tiles of travel between stamps
    const MAX_MARKS = 600;

    for (const id of this.lastTrack.keys()) if (!state.tanks.has(id)) this.lastTrack.delete(id);
    for (const it of state.tanks.values()) {
      const t = it.cur;
      if (!t.alive || t.onBoat) {
        this.lastTrack.delete(t.id);
        continue;
      }
      const p = state.lerpTank(it, now);
      const last = this.lastTrack.get(t.id);
      if (!last) {
        this.lastTrack.set(t.id, { x: p.x, y: p.y });
        continue;
      }
      if (Math.hypot(p.x - last.x, p.y - last.y) >= SPACING) {
        this.trackMarks.push({ x: p.x, y: p.y, dir: p.dir, at: now });
        last.x = p.x;
        last.y = p.y;
      }
    }
    if (this.trackMarks.length > MAX_MARKS) this.trackMarks.splice(0, this.trackMarks.length - MAX_MARKS);
    if (this.trackMarks.length && now - this.trackMarks[0].at >= FADE_MS) {
      this.trackMarks = this.trackMarks.filter((m) => now - m.at < FADE_MS);
    }

    const img = sprites.images.tracks;
    const ctx = this.ctx;
    const tw = TANK_RADIUS * 2.3 * this.scale; // tread width ≈ hull width
    const th = (tw * 52) / 37; // sprite is 37x52, points north
    for (const m of this.trackMarks) {
      const [px, py] = toScreen(m.x, m.y);
      if (!onScreen(px, py, 30)) continue;
      ctx.save();
      ctx.globalAlpha = 0.38 * (1 - (now - m.at) / FADE_MS);
      ctx.translate(px, py);
      ctx.rotate(m.dir + Math.PI / 2);
      ctx.drawImage(img, -tw / 2, -th / 2, tw, th);
      ctx.restore();
    }
  }

  // ---------- entities ----------

  private drawTank(
    state: GameState,
    it: InterpTank,
    now: number,
    toScreen: (x: number, y: number) => [number, number],
    onScreen: (x: number, y: number) => boolean,
  ): void {
    const ctx = this.ctx;
    const t = it.cur;
    const isMe = t.id === state.you?.tankId;
    // own tank: use predicted position for instant response; others: interpolated
    const p = isMe ? state.predictedSelf(now) : state.lerpTank(it, now);
    const [px, py] = toScreen(p.x, p.y);
    if (!onScreen(px, py)) return;
    const r = TANK_RADIUS * this.scale;
    const body = FACTION_COLORS[t.faction];

    ctx.save();
    ctx.translate(px, py);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(2, 3, r * 1.15, r * 0.95, p.dir, 0, Math.PI * 2);
    ctx.fill();

    if (t.onBoat) {
      // landing craft under the tank (dinghy points north)
      ctx.save();
      ctx.rotate(p.dir + Math.PI / 2);
      const bw = r * 2.4;
      const bh = (bw * 38) / 20;
      ctx.drawImage(sprites.images.boat, -bw / 2, -bh / 2, bw, bh);
      ctx.restore();
    }

    // Kenney sprites point north; our headings are 0 = east
    ctx.rotate(p.dir + Math.PI / 2);
    const k = (r * 2.55) / 38; // body sprite is 38px wide
    ctx.drawImage(sprites.images[t.faction === 'dawn' ? 'tankDawn' : 'tankDusk'], (-38 / 2) * k, (-36 / 2) * k, 38 * k, 36 * k);
    // barrel (12x26) pivots at the turret; its base sits near tank center
    ctx.drawImage(sprites.images[t.faction === 'dawn' ? 'barrelDawn' : 'barrelDusk'], (-12 / 2) * k, -24 * k, 12 * k, 26 * k);
    ctx.restore();

    // carried pillbox indicator
    if (isMe && state.me()?.carriedPill != null) {
      ctx.fillStyle = '#fff';
      ctx.font = `${Math.round(this.scale * 0.45)}px monospace`;
      ctx.textAlign = 'center';
      ctx.fillText('◧', px, py - r - 16);
    }

    // label with backing
    const label = (t.npc ? '⚙ ' : '') + t.handle;
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    const tw = ctx.measureText(label).width;
    ctx.fillStyle = 'rgba(7,8,12,0.55)';
    ctx.fillRect(px - tw / 2 - 3, py - r - 14, tw + 6, 11);
    ctx.fillStyle = isMe ? '#ffffff' : body;
    ctx.fillText(label, px, py - r - 5.5);

    // mutual marker: small green dot above mutual tanks
    if (t.mutual) {
      ctx.fillStyle = '#6c8';
      ctx.beginPath();
      ctx.arc(px + tw / 2 + 6, py - r - 9, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // bounty marker: gold coin icon above bounty target tanks
    if (t.bounty) {
      ctx.save();
      ctx.fillStyle = '#e8c75d';
      ctx.beginPath();
      ctx.arc(px - tw / 2 - 8, py - r - 9, 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#a06b1c';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      ctx.fillStyle = '#a06b1c';
      ctx.font = 'bold 8px monospace';
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText('$', px - tw / 2 - 8, py - r - 9);
      ctx.restore();
    }

    // emote bubble: pops in, floats, fades out
    const emote = state.emotes.get(t.id);
    if (emote) {
      const age = now - emote.at;
      if (age > EMOTE_SHOW_MS) {
        state.emotes.delete(t.id);
      } else {
        const img = sprites.images[EMOTE_SPRITES[emote.kind]];
        const pop = Math.min(1, age / 140); // scale-in
        const fade = age > EMOTE_SHOW_MS - 400 ? (EMOTE_SHOW_MS - age) / 400 : 1;
        const size = this.scale * 0.95 * (0.5 + 0.5 * pop);
        const rise = Math.min(age / 300, 1) * 6 + Math.sin(now / 400) * 1.5;
        ctx.save();
        ctx.globalAlpha = fade;
        ctx.drawImage(img, px - size / 2, py - r - 22 - size - rise, size, size);
        ctx.restore();
      }
    }
  }

  /** The little green man (Map Pack sprite). Bobs while walking, rocks while working. */
  private drawBuilder(px: number, py: number, faction: Faction, phase: string, now: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const walking = phase === 'outbound' || phase === 'returning';
    const bob = walking ? Math.sin(now / 90) : 0;
    const img = sprites.images.builderMan;

    ctx.save();
    ctx.translate(px, py + bob * 1.2);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(1, s * 0.2, s * 0.16, s * 0.09, 0, 0, Math.PI * 2);
    ctx.fill();

    // sprites are alpha-trimmed; keep the robot's aspect and plant his
    // feet on the faction ring
    const iw = (img as HTMLCanvasElement).width;
    const ih = (img as HTMLCanvasElement).height;
    const h = s * 0.55;
    const w = (h * iw) / ih;
    // working: rock side to side like he's putting his back into it
    if (phase === 'working') ctx.rotate(Math.sin(now / 120) * 0.3);
    // faction band under his feet so you know whose engineer he is
    ctx.strokeStyle = FACTION_COLORS[faction];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.ellipse(0, s * 0.18, s * 0.15, s * 0.07, 0, 0, Math.PI * 2);
    ctx.stroke();
    ctx.drawImage(img, -w / 2, s * 0.18 - h, w, h);

    // hammer swing while working
    if (phase === 'working') {
      const swing = Math.sin(now / 120) * 0.9;
      ctx.save();
      ctx.translate(s * 0.16, -s * 0.05);
      ctx.rotate(swing);
      ctx.strokeStyle = '#caa86a';
      ctx.lineWidth = 1.5;
      ctx.beginPath();
      ctx.moveTo(0, 0);
      ctx.lineTo(s * 0.16, -s * 0.12);
      ctx.stroke();
      ctx.fillStyle = '#666c78';
      ctx.fillRect(s * 0.12, -s * 0.18, s * 0.09, s * 0.09);
      ctx.restore();
    }

    ctx.restore();
  }

  /** Watchtower sprite, faction-tinted. Glows red when furious. */
  private drawPill(px: number, py: number, owner: Faction | 'neutral', hp: number, now: number): void {
    const ctx = this.ctx;
    const s = this.scale * 0.95;
    const dead = hp <= 0;
    const angry = !dead && hp < PILL_MAX_HP * 0.35;

    const key = dead
      ? 'towerHusk'
      : owner === 'dawn'
        ? 'towerDawn'
        : owner === 'dusk'
          ? 'towerDusk'
          : 'towerNeutral';
    const img = sprites.images[key];

    // anger aura behind the tower
    if (angry) {
      const pulse = 0.35 + 0.25 * Math.sin(now / 110);
      ctx.fillStyle = `rgba(225,60,50,${pulse * 0.55})`;
      ctx.beginPath();
      ctx.arc(px, py, s * 0.72, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = `rgba(255,80,60,${pulse})`;
      ctx.lineWidth = 2;
      ctx.stroke();
    }

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(px + 1.5, py + s * 0.32, s * 0.4, s * 0.18, 0, 0, Math.PI * 2);
    ctx.fill();
    // aspect-correct draw (sprites are alpha-trimmed); the dead husk is
    // the gunless mount sprite, which reads as "empty" on its own
    const iw = (img as HTMLCanvasElement).width;
    const ih = (img as HTMLCanvasElement).height;
    const dw = s * 0.92;
    const dh = (dw * ih) / iw;
    if (dead) ctx.globalAlpha = 0.85;
    ctx.drawImage(img, px - dw / 2, py - dh / 2, dw, dh);
    ctx.globalAlpha = 1;

    if (!dead) {
      ctx.fillStyle = 'rgba(0,0,0,0.55)';
      ctx.fillRect(px - s / 2, py + s / 2 + 3, s, 3);
      ctx.fillStyle = angry ? '#e85d5d' : '#7fc46a';
      ctx.fillRect(px - s / 2, py + s / 2 + 3, (s * hp) / PILL_MAX_HP, 3);
    }
  }

  /**
   * RTS HQ sprite, faction-tinted, flying a waving faction flag, with two
   * gauges: fortification hp (faction-colored — shell it to 0 and the base
   * falls neutral) over supply stock (amber — what it can dispense).
   */
  private drawBase(px: number, py: number, owner: Faction | 'neutral', hp: number, supply: number, now: number): void {
    const ctx = this.ctx;
    const s = this.scale * 1.25;
    const c = FACTION_COLORS[owner];
    const img = sprites.images[owner === 'dawn' ? 'baseDawn' : owner === 'dusk' ? 'baseDusk' : 'baseNeutral'];

    ctx.fillStyle = 'rgba(0,0,0,0.28)';
    ctx.beginPath();
    ctx.ellipse(px + 2, py + s * 0.3, s * 0.45, s * 0.2, 0, 0, Math.PI * 2);
    ctx.fill();
    ctx.drawImage(img, px - s / 2, py - s / 2, s, s);

    // an owned base flies its colors; a neutral one stands bare
    if (owner !== 'neutral') {
      this.drawFlag(px + s * 0.04, py - s * 0.18, c, FACTION_DARK[owner], now);
    }

    // fortification bar (hp): the thing you shell down / watch grow back
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(px - s / 2, py + s / 2 + 3, s, 3);
    ctx.fillStyle = c;
    ctx.fillRect(px - s / 2, py + s / 2 + 3, (s * hp) / BASE_MAX_HP, 3);
    // supply bar: how much the base has to give (refuels slow as hp drops)
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(px - s / 2, py + s / 2 + 7, s, 2);
    ctx.fillStyle = '#e8b44c';
    ctx.fillRect(px - s / 2, py + s / 2 + 7, s * supply, 2);
  }

  /**
   * A pennant on a pole that ripples in the wind. The cloth is a filled strip
   * whose every column is displaced by a traveling sine wave; amplitude grows
   * toward the free (fly) end and stays pinned at the hoist, so it reads as
   * cloth catching wind rather than a rigid sheet sliding around.
   */
  private drawFlag(footX: number, footY: number, color: string, dark: string, now: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const poleH = s * 0.52;
    const topY = footY - poleH;

    // pole
    ctx.lineCap = 'round';
    ctx.strokeStyle = '#b9bfca';
    ctx.lineWidth = Math.max(1.5, s * 0.06);
    ctx.beginPath();
    ctx.moveTo(footX, footY);
    ctx.lineTo(footX, topY);
    ctx.stroke();
    ctx.lineCap = 'butt';
    // finial knob
    ctx.fillStyle = '#e6ebf2';
    ctx.beginPath();
    ctx.arc(footX, topY, Math.max(1.4, s * 0.05), 0, Math.PI * 2);
    ctx.fill();

    // cloth flies to +x from just under the finial
    const fw = s * 0.52;
    const fh = s * 0.24;
    const top = topY + s * 0.03;
    const seg = 10;
    const phase = now / 170;
    const wave = (t: number) => Math.sin(t * 3.2 - phase) * (s * 0.07) * t;
    const billow = (t: number) => Math.cos(t * 3.2 - phase) * (s * 0.02) * t;
    const strip = (yOff: number) => {
      ctx.beginPath();
      for (let i = 0; i <= seg; i++) {
        const t = i / seg;
        const x = footX + t * fw + billow(t);
        const y = top + yOff + wave(t);
        if (i === 0) ctx.moveTo(x, y);
        else ctx.lineTo(x, y);
      }
      for (let i = seg; i >= 0; i--) {
        const t = i / seg;
        const x = footX + t * fw + billow(t);
        const y = top + fh + wave(t);
        ctx.lineTo(x, y);
      }
      ctx.closePath();
    };

    strip(0);
    ctx.fillStyle = color;
    ctx.fill();
    // lower fold in shadow for a bit of depth
    strip(fh * 0.55);
    ctx.globalAlpha = 0.5;
    ctx.fillStyle = dark;
    ctx.fill();
    ctx.globalAlpha = 1;
  }

  private drawMine(px: number, py: number, now: number): void {
    const ctx = this.ctx;
    const blink = Math.sin(now / 350) > 0;
    ctx.fillStyle = blink ? '#e85d5d' : '#a23f3f';
    ctx.beginPath();
    ctx.moveTo(px, py - 4.5);
    ctx.lineTo(px + 4.5, py);
    ctx.lineTo(px, py + 4.5);
    ctx.lineTo(px - 4.5, py);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = 'rgba(0,0,0,0.6)';
    ctx.lineWidth = 1;
    ctx.stroke();
  }

  private drawBoom(px: number, py: number, t: number, kind: 'shell' | 'mine', seed: number): void {
    const ctx = this.ctx;
    // clamp low too: boom.at comes from performance.now() at receipt while t
    // derives from the rAF timestamp, which can lag it slightly
    const frame = Math.max(0, Math.min(BOOM_FRAMES - 1, Math.floor(t * BOOM_FRAMES)));
    const img = sprites.images[`${kind === 'mine' ? 'boomMine' : 'boomShell'}${frame}` as SpriteKey];
    const size = (kind === 'mine' ? 2.6 : 1.6) * this.scale;
    ctx.save();
    ctx.globalAlpha = t > 0.75 ? (1 - t) / 0.25 : 1;
    ctx.translate(px, py);
    ctx.rotate((seed % 7) * 0.9); // varied orientation per explosion
    ctx.drawImage(img, -size / 2, -size / 2, size, size);
    ctx.restore();
  }
}
