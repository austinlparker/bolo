/** First-person (well, top-down) renderer for players. */
import {
  BASE_MAX_ARMOR_STOCK,
  type Faction,
  MAP_SIZE,
  PILL_MAX_HP,
  TANK_RADIUS,
  TICK_MS,
} from '@bolo/shared';
import type { GameState, InterpTank } from './state';
import { TILE_PX, TileCache } from './tiles';

export const FACTION_COLORS: Record<Faction | 'neutral', string> = {
  dawn: '#e8a33d',
  dusk: '#8a6de8',
  neutral: '#9aa3ad',
};

export class Renderer {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private tiles = new TileCache();
  scale = 26; // screen px per tile
  camX = MAP_SIZE / 2;
  camY = MAP_SIZE / 2;

  constructor(canvas: HTMLCanvasElement) {
    this.canvas = canvas;
    this.ctx = canvas.getContext('2d')!;
    const fit = () => {
      canvas.width = innerWidth;
      canvas.height = innerHeight;
    };
    addEventListener('resize', fit);
    fit();
  }

  screenToWorld(sx: number, sy: number): [number, number] {
    return [
      this.camX + (sx - this.canvas.width / 2) / this.scale,
      this.camY + (sy - this.canvas.height / 2) / this.scale,
    ];
  }

  frame(state: GameState, now: number): void {
    const ctx = this.ctx;
    const { width: w, height: h } = this.canvas;
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
    ctx.drawImage(
      this.tiles.canvas,
      sx,
      sy,
      w * (TILE_PX / this.scale),
      h * (TILE_PX / this.scale),
      0,
      0,
      w,
      h,
    );

    const toScreen = (wx: number, wy: number): [number, number] => [
      w / 2 + (wx - this.camX) * this.scale,
      h / 2 + (wy - this.camY) * this.scale,
    ];

    // known mines
    ctx.fillStyle = '#e85d5d';
    for (const i of state.mines) {
      const mx = i % MAP_SIZE;
      const my = Math.floor(i / MAP_SIZE);
      const [px, py] = toScreen(mx + 0.5, my + 0.5);
      if (px < -20 || py < -20 || px > w + 20 || py > h + 20) continue;
      ctx.beginPath();
      ctx.arc(px, py, 3, 0, Math.PI * 2);
      ctx.fill();
    }

    // bases
    for (const b of state.bases) {
      const [px, py] = toScreen(b.x + 0.5, b.y + 0.5);
      if (px < -40 || py < -40 || px > w + 40 || py > h + 40) continue;
      const s = this.scale;
      ctx.strokeStyle = FACTION_COLORS[b.owner];
      ctx.lineWidth = 2;
      ctx.strokeRect(px - s / 2, py - s / 2, s, s);
      ctx.fillStyle = FACTION_COLORS[b.owner];
      ctx.fillRect(px - s / 6, py - s / 6, s / 3, s / 3);
      // armor stock = siege bar
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(px - s / 2, py + s / 2 + 2, s, 3);
      ctx.fillStyle = FACTION_COLORS[b.owner];
      ctx.fillRect(px - s / 2, py + s / 2 + 2, (s * b.armorStock) / BASE_MAX_ARMOR_STOCK, 3);
    }

    // pillboxes
    for (const p of state.pills) {
      if (p.inTank) continue;
      const [px, py] = toScreen(p.x + 0.5, p.y + 0.5);
      if (px < -40 || py < -40 || px > w + 40 || py > h + 40) continue;
      const s = this.scale * 0.7;
      if (p.hp <= 0) {
        ctx.strokeStyle = '#555';
        ctx.lineWidth = 1.5;
        ctx.strokeRect(px - s / 2, py - s / 2, s, s);
        continue;
      }
      ctx.fillStyle = '#30343c';
      ctx.fillRect(px - s / 2, py - s / 2, s, s);
      ctx.strokeStyle = FACTION_COLORS[p.owner];
      ctx.lineWidth = 2;
      ctx.strokeRect(px - s / 2, py - s / 2, s, s);
      ctx.fillStyle = FACTION_COLORS[p.owner];
      ctx.beginPath();
      ctx.arc(px, py, s / 5, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = 'rgba(0,0,0,0.5)';
      ctx.fillRect(px - s / 2, py + s / 2 + 2, s, 3);
      ctx.fillStyle = '#e86d6d';
      ctx.fillRect(px - s / 2, py + s / 2 + 2, (s * p.hp) / PILL_MAX_HP, 3);
    }

    // builders
    for (const b of state.builders) {
      const [px, py] = toScreen(b.x, b.y);
      ctx.fillStyle = FACTION_COLORS[b.faction];
      ctx.beginPath();
      ctx.arc(px, py, this.scale * 0.14, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = '#000';
      ctx.lineWidth = 1;
      ctx.stroke();
    }

    // tanks
    for (const it of state.tanks.values()) {
      if (!it.cur.alive) continue;
      this.drawTank(state, it, now, toScreen);
    }

    // shells
    ctx.fillStyle = '#fff1c4';
    for (const s of state.shells) {
      const [px, py] = toScreen(s.x, s.y);
      ctx.beginPath();
      ctx.arc(px, py, 2.5, 0, Math.PI * 2);
      ctx.fill();
    }

    // explosions
    state.booms = state.booms.filter((b) => now - b.at < 450);
    for (const b of state.booms) {
      const t = (now - b.at) / 450;
      const [px, py] = toScreen(b.x, b.y);
      ctx.strokeStyle = b.kind === 'mine' ? `rgba(255,120,60,${1 - t})` : `rgba(255,220,120,${1 - t})`;
      ctx.lineWidth = 3 * (1 - t) + 1;
      ctx.beginPath();
      ctx.arc(px, py, (b.kind === 'mine' ? 26 : 14) * t + 3, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  private drawTank(
    state: GameState,
    it: InterpTank,
    now: number,
    toScreen: (x: number, y: number) => [number, number],
  ): void {
    const ctx = this.ctx;
    const t = it.cur;
    const p = state.lerpTank(it, now, TICK_MS);
    const [px, py] = toScreen(p.x, p.y);
    if (px < -60 || py < -60 || px > this.canvas.width + 60 || py > this.canvas.height + 60) return;
    const r = TANK_RADIUS * this.scale;
    const color = FACTION_COLORS[t.faction];

    ctx.save();
    ctx.translate(px, py);

    if (t.onBoat) {
      ctx.fillStyle = '#8a6034';
      ctx.beginPath();
      ctx.ellipse(0, 0, r * 1.9, r * 1.3, p.dir, 0, Math.PI * 2);
      ctx.fill();
    }

    ctx.rotate(p.dir);
    // treads
    ctx.fillStyle = '#1b1d22';
    ctx.fillRect(-r, -r, r * 2, r * 0.55);
    ctx.fillRect(-r, r * 0.45, r * 2, r * 0.55);
    // hull
    ctx.fillStyle = color;
    ctx.fillRect(-r * 0.85, -r * 0.5, r * 1.7, r);
    // turret + barrel
    ctx.fillStyle = '#11141a';
    ctx.beginPath();
    ctx.arc(0, 0, r * 0.42, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillRect(0, -r * 0.1, r * 1.5, r * 0.2);
    ctx.restore();

    // label
    ctx.font = '10px monospace';
    ctx.textAlign = 'center';
    ctx.fillStyle = t.id === state.you?.tankId ? '#fff' : color;
    ctx.fillText(t.npc ? '⚙ ' + t.handle : t.handle, px, py - r - 6);
  }
}
