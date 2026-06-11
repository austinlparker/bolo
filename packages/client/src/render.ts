/** Top-down renderer for players: terrain cache + entities + effects. */
import {
  BASE_MAX_ARMOR_STOCK,
  type Faction,
  hash32,
  MAP_SIZE,
  PILL_MAX_HP,
  TANK_RADIUS,
  TICK_MS,
} from '@bolo/shared';
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

export class Renderer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles = new TileCache();
  private vignette: CanvasGradient | null = null;
  private dpr = 1;
  /** viewport size in CSS pixels */
  private vw = 0;
  private vh = 0;
  scale = 26; // screen px per tile
  camX = MAP_SIZE / 2;
  camY = MAP_SIZE / 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const fit = () => {
      this.dpr = Math.min(globalThis.devicePixelRatio || 1, 2.5);
      this.vw = innerWidth;
      this.vh = innerHeight;
      canvas.width = Math.round(this.vw * this.dpr);
      canvas.height = Math.round(this.vh * this.dpr);
      if (canvas.style) {
        canvas.style.width = `${this.vw}px`;
        canvas.style.height = `${this.vh}px`;
      }
      // zoom out a touch on small screens so enough battlefield is visible
      this.scale = Math.min(this.vw, this.vh) < 540 ? 20 : 26;
      this.vignette = null;
    };
    addEventListener('resize', fit);
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

    // camera follows your tank
    const meInterp = state.you ? state.tanks.get(state.you.tankId) : undefined;
    if (meInterp) {
      const p = state.lerpTank(meInterp, now, TICK_MS);
      this.camX = p.x;
      this.camY = p.y;
    }

    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, w, h);

    // map
    const sx = this.camX * TILE_PX - (w / 2) * (TILE_PX / this.scale);
    const sy = this.camY * TILE_PX - (h / 2) * (TILE_PX / this.scale);
    ctx.imageSmoothingEnabled = false;
    ctx.drawImage(this.tiles.canvas, sx, sy, w * (TILE_PX / this.scale), h * (TILE_PX / this.scale), 0, 0, w, h);

    const toScreen = (wx: number, wy: number): [number, number] => [
      w / 2 + (wx - this.camX) * this.scale,
      h / 2 + (wy - this.camY) * this.scale,
    ];
    const onScreen = (px: number, py: number, m = 60) => px > -m && py > -m && px < w + m && py < h + m;

    // known mines
    for (const i of state.mines) {
      const [px, py] = toScreen((i % MAP_SIZE) + 0.5, Math.floor(i / MAP_SIZE) + 0.5);
      if (!onScreen(px, py, 20)) continue;
      this.drawMine(px, py, now);
    }

    for (const b of state.bases) {
      const [px, py] = toScreen(b.x + 0.5, b.y + 0.5);
      if (onScreen(px, py)) this.drawBase(px, py, b.owner, b.armorStock);
    }

    for (const p of state.pills) {
      if (p.inTank) continue;
      const [px, py] = toScreen(p.x + 0.5, p.y + 0.5);
      if (onScreen(px, py)) this.drawPill(px, py, p.owner, p.hp, now);
    }

    for (const b of state.builders) {
      const [px, py] = toScreen(b.x, b.y);
      if (onScreen(px, py, 20)) this.drawBuilder(px, py, b.faction, b.phase, now);
    }

    for (const it of state.tanks.values()) {
      if (!it.cur.alive) continue;
      this.drawTank(state, it, now, toScreen, onScreen);
    }

    // shells: tracer + trail + muzzle flash on freshly fired ones
    for (const s of state.shells) {
      const [px, py] = toScreen(s.x, s.y);
      if (!onScreen(px, py, 20)) continue;
      const tail = 0.55 * this.scale;
      ctx.strokeStyle = 'rgba(255,224,160,0.5)';
      ctx.lineWidth = 2;
      ctx.beginPath();
      ctx.moveTo(px - Math.cos(s.dir) * tail, py - Math.sin(s.dir) * tail);
      ctx.lineTo(px, py);
      ctx.stroke();
      ctx.fillStyle = '#fff4d0';
      ctx.beginPath();
      ctx.arc(px, py, 2.4, 0, Math.PI * 2);
      ctx.fill();
    }

    // explosions
    state.booms = state.booms.filter((b) => now - b.at < 500);
    for (const b of state.booms) {
      const t = (now - b.at) / 500;
      const [px, py] = toScreen(b.x, b.y);
      if (!onScreen(px, py)) continue;
      this.drawBoom(px, py, t, b.kind, hash32(Math.round(b.x * 7), Math.round(b.y * 7)));
    }

    // soft vignette for atmosphere
    if (!this.vignette) {
      const g = ctx.createRadialGradient(w / 2, h / 2, Math.min(w, h) * 0.45, w / 2, h / 2, Math.max(w, h) * 0.75);
      g.addColorStop(0, 'rgba(0,0,0,0)');
      g.addColorStop(1, 'rgba(0,0,0,0.42)');
      this.vignette = g;
    }
    ctx.fillStyle = this.vignette;
    ctx.fillRect(0, 0, w, h);
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
    const p = state.lerpTank(it, now, TICK_MS);
    const [px, py] = toScreen(p.x, p.y);
    if (!onScreen(px, py)) return;
    const r = TANK_RADIUS * this.scale;
    const body = FACTION_COLORS[t.faction];
    const dark = FACTION_DARK[t.faction];
    const isMe = t.id === state.you?.tankId;

    ctx.save();
    ctx.translate(px, py);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(2, 3, r * 1.15, r * 0.95, p.dir, 0, Math.PI * 2);
    ctx.fill();

    if (t.onBoat) {
      // landing craft under the tank
      ctx.save();
      ctx.rotate(p.dir);
      ctx.fillStyle = '#6e4a26';
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 2.1, r * 1.45, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#9a7644';
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.75, r * 1.15, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }

    ctx.rotate(p.dir);

    // treads with rolling tick marks
    const treadPhase = ((now / 1000) * t.speed * this.scale) % 6;
    for (const side of [-1, 1] as const) {
      ctx.fillStyle = '#15171c';
      ctx.fillRect(-r * 1.05, side * r * 0.52 - r * 0.26, r * 2.1, r * 0.52);
      ctx.fillStyle = '#2e323a';
      for (let i = -3; i <= 3; i++) {
        ctx.fillRect(i * 6 - treadPhase, side * r * 0.52 - r * 0.22, 2, r * 0.44);
      }
    }

    // hull: rounded with a sloped nose
    ctx.fillStyle = dark;
    hullPath(ctx, r * 1.02);
    ctx.fill();
    ctx.fillStyle = body;
    hullPath(ctx, r * 0.88);
    ctx.fill();
    // nose chevron
    ctx.fillStyle = 'rgba(255,255,255,0.18)';
    ctx.beginPath();
    ctx.moveTo(r * 0.55, -r * 0.3);
    ctx.lineTo(r * 0.82, 0);
    ctx.lineTo(r * 0.55, r * 0.3);
    ctx.closePath();
    ctx.fill();

    // barrel
    ctx.fillStyle = '#1a1d23';
    ctx.fillRect(0, -r * 0.09, r * 1.55, r * 0.18);
    ctx.fillStyle = '#3a3f48';
    ctx.fillRect(r * 1.28, -r * 0.13, r * 0.27, r * 0.26);

    // turret
    ctx.fillStyle = '#15171c';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.5, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = dark;
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.4, 0, Math.PI * 2);
    ctx.fill();
    // hatch
    ctx.fillStyle = body;
    ctx.beginPath();
    ctx.arc(-r * 0.08, 0, r * 0.16, 0, Math.PI * 2);
    ctx.fill();

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
  }

  /** The little green man. Bobs while walking, swings a hammer while working. */
  private drawBuilder(px: number, py: number, faction: Faction, phase: string, now: number): void {
    const ctx = this.ctx;
    const s = this.scale;
    const walking = phase === 'outbound' || phase === 'returning';
    const bob = walking ? Math.sin(now / 90) : 0;

    ctx.save();
    ctx.translate(px, py + bob * 1.2);

    // shadow
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    ctx.beginPath();
    ctx.ellipse(1, 2.5, s * 0.16, s * 0.1, 0, 0, Math.PI * 2);
    ctx.fill();

    // legs scuttling
    if (walking) {
      ctx.strokeStyle = '#2a7034';
      ctx.lineWidth = 2;
      const step = Math.sin(now / 90) * s * 0.08;
      ctx.beginPath();
      ctx.moveTo(-s * 0.05, s * 0.08);
      ctx.lineTo(-s * 0.05 + step, s * 0.2);
      ctx.moveTo(s * 0.05, s * 0.08);
      ctx.lineTo(s * 0.05 - step, s * 0.2);
      ctx.stroke();
    }

    // body
    ctx.fillStyle = '#3fae49';
    ctx.beginPath();
    ctx.arc(0, 0, s * 0.15, 0, Math.PI * 2);
    ctx.fill();
    // head
    ctx.fillStyle = '#8ad88f';
    ctx.beginPath();
    ctx.arc(0, -s * 0.1, s * 0.09, 0, Math.PI * 2);
    ctx.fill();
    // faction hard-hat
    ctx.strokeStyle = FACTION_COLORS[faction];
    ctx.lineWidth = 2;
    ctx.beginPath();
    ctx.arc(0, -s * 0.11, s * 0.09, Math.PI * 1.05, Math.PI * 1.95);
    ctx.stroke();

    // hammer swing while working
    if (phase === 'working') {
      const swing = Math.sin(now / 120) * 0.9;
      ctx.save();
      ctx.translate(s * 0.14, -s * 0.02);
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

  /** Classic Bolo octagonal bunker with a dome. Glows red when furious. */
  private drawPill(px: number, py: number, owner: Faction | 'neutral', hp: number, now: number): void {
    const ctx = this.ctx;
    const s = this.scale * 0.82;

    if (hp <= 0) {
      // dead husk: cracked outline, salvageable
      ctx.strokeStyle = '#4a4f58';
      ctx.lineWidth = 1.5;
      octagon(ctx, px, py, s / 2);
      ctx.stroke();
      ctx.strokeStyle = '#383d45';
      ctx.beginPath();
      ctx.moveTo(px - s * 0.2, py - s * 0.15);
      ctx.lineTo(px + s * 0.1, py + s * 0.2);
      ctx.stroke();
      return;
    }

    const angry = hp < PILL_MAX_HP * 0.35;
    // anger aura
    if (angry) {
      const pulse = 0.25 + 0.2 * Math.sin(now / 110);
      ctx.fillStyle = `rgba(232,93,93,${pulse})`;
      octagon(ctx, px, py, s * 0.72);
      ctx.fill();
    }

    // shadow + walls
    ctx.fillStyle = 'rgba(0,0,0,0.3)';
    octagon(ctx, px + 1.5, py + 2, s / 2);
    ctx.fill();
    ctx.fillStyle = '#3a3f48';
    octagon(ctx, px, py, s / 2);
    ctx.fill();
    ctx.fillStyle = '#565d68';
    octagon(ctx, px, py, s * 0.41);
    ctx.fill();

    // gun slits NSEW
    ctx.fillStyle = '#14161b';
    ctx.fillRect(px - 1.5, py - s / 2 + 1, 3, 4);
    ctx.fillRect(px - 1.5, py + s / 2 - 5, 3, 4);
    ctx.fillRect(px - s / 2 + 1, py - 1.5, 4, 3);
    ctx.fillRect(px + s / 2 - 5, py - 1.5, 4, 3);

    // faction dome
    ctx.fillStyle = FACTION_DARK[owner];
    ctx.beginPath();
    ctx.arc(px, py, s * 0.22, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = FACTION_COLORS[owner];
    ctx.beginPath();
    ctx.arc(px - s * 0.04, py - s * 0.04, s * 0.15, 0, Math.PI * 2);
    ctx.fill();

    // hp bar
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(px - s / 2, py + s / 2 + 3, s, 3);
    ctx.fillStyle = angry ? '#e85d5d' : '#7fc46a';
    ctx.fillRect(px - s / 2, py + s / 2 + 3, (s * hp) / PILL_MAX_HP, 3);
  }

  /** Supply pad: corner brackets, center ring, faction flag. */
  private drawBase(px: number, py: number, owner: Faction | 'neutral', armorStock: number): void {
    const ctx = this.ctx;
    const s = this.scale * 1.1;
    const c = FACTION_COLORS[owner];

    // pad plate
    ctx.fillStyle = 'rgba(20,22,28,0.45)';
    ctx.fillRect(px - s / 2, py - s / 2, s, s);

    // corner brackets
    ctx.strokeStyle = c;
    ctx.lineWidth = 2;
    const k = s / 2;
    const b = s * 0.28;
    for (const [mx, my] of [
      [-1, -1], [1, -1], [-1, 1], [1, 1],
    ] as const) {
      ctx.beginPath();
      ctx.moveTo(px + mx * k, py + my * (k - b));
      ctx.lineTo(px + mx * k, py + my * k);
      ctx.lineTo(px + mx * (k - b), py + my * k);
      ctx.stroke();
    }

    // center ring + core
    ctx.strokeStyle = 'rgba(255,255,255,0.25)';
    ctx.lineWidth = 1;
    ctx.beginPath();
    ctx.arc(px, py, s * 0.26, 0, Math.PI * 2);
    ctx.stroke();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.arc(px, py, s * 0.13, 0, Math.PI * 2);
    ctx.fill();

    // flag
    ctx.strokeStyle = '#d8dbe2';
    ctx.lineWidth = 1.5;
    ctx.beginPath();
    ctx.moveTo(px + s * 0.34, py - s * 0.5);
    ctx.lineTo(px + s * 0.34, py - s * 0.18);
    ctx.stroke();
    ctx.fillStyle = c;
    ctx.beginPath();
    ctx.moveTo(px + s * 0.34, py - s * 0.5);
    ctx.lineTo(px + s * 0.62, py - s * 0.42);
    ctx.lineTo(px + s * 0.34, py - s * 0.33);
    ctx.closePath();
    ctx.fill();

    // armor stock = siege bar
    ctx.fillStyle = 'rgba(0,0,0,0.55)';
    ctx.fillRect(px - s / 2, py + s / 2 + 3, s, 3);
    ctx.fillStyle = c;
    ctx.fillRect(px - s / 2, py + s / 2 + 3, (s * armorStock) / BASE_MAX_ARMOR_STOCK, 3);
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
    const max = kind === 'mine' ? 30 : 16;
    // flash core
    if (t < 0.35) {
      ctx.fillStyle = `rgba(255,236,180,${0.8 * (1 - t / 0.35)})`;
      ctx.beginPath();
      ctx.arc(px, py, max * 0.35 * (0.5 + t), 0, Math.PI * 2);
      ctx.fill();
    }
    // shock ring
    ctx.strokeStyle = kind === 'mine' ? `rgba(255,130,60,${1 - t})` : `rgba(255,210,120,${1 - t})`;
    ctx.lineWidth = 3 * (1 - t) + 1;
    ctx.beginPath();
    ctx.arc(px, py, max * t + 3, 0, Math.PI * 2);
    ctx.stroke();
    // debris sparks
    for (let i = 0; i < 6; i++) {
      const hh = hash32(seed, i);
      const ang = (hh % 360) * (Math.PI / 180);
      const speed = 0.6 + ((hh >> 8) % 100) / 160;
      const d = max * 1.1 * t * speed;
      ctx.fillStyle = `rgba(255,${170 + (hh % 60)},90,${(1 - t) * 0.9})`;
      ctx.fillRect(px + Math.cos(ang) * d - 1, py + Math.sin(ang) * d - 1, 2.5, 2.5);
    }
  }
}

/** Tank hull outline: rounded rear, sloped nose. Assumes ctx is translated+rotated. */
function hullPath(ctx: CanvasRenderingContext2D, r: number): void {
  ctx.beginPath();
  ctx.moveTo(-r * 0.9, -r * 0.55);
  ctx.lineTo(r * 0.45, -r * 0.55);
  ctx.lineTo(r * 0.95, -r * 0.22);
  ctx.lineTo(r * 0.95, r * 0.22);
  ctx.lineTo(r * 0.45, r * 0.55);
  ctx.lineTo(-r * 0.9, r * 0.55);
  ctx.quadraticCurveTo(-r * 1.05, 0, -r * 0.9, -r * 0.55);
  ctx.closePath();
}

function octagon(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number): void {
  ctx.beginPath();
  for (let i = 0; i < 8; i++) {
    const a = (Math.PI / 8) * (2 * i + 1);
    const x = cx + Math.cos(a) * r;
    const y = cy + Math.sin(a) * r;
    if (i === 0) ctx.moveTo(x, y);
    else ctx.lineTo(x, y);
  }
  ctx.closePath();
}
