/**
 * Offscreen tilemap cache: the whole 256x256 map painted once at 16px/tile,
 * then patched in place as terrain-change deltas arrive. Painting is
 * neighbor-aware (roads connect, coasts get foam), so a dirty tile also
 * repaints its neighbors.
 */
import { hash32, MAP_SIZE, Terrain } from '@bolo/shared';
import { sprites, type SpriteKey } from './sprites';
import type { GameState } from './state';

/** Pick the road tile for a set of connections (Kenney connection set). */
function roadSprite(n: boolean, e: boolean, s: boolean, w: boolean): SpriteKey {
  const count = +n + +e + +s + +w;
  if (count === 4) return 'roadCross';
  if (count === 3) {
    if (!s) return 'roadSplitN'; // straight E-W, branch N
    if (!n) return 'roadSplitS';
    if (!w) return 'roadSplitE';
    return 'roadSplitW';
  }
  if (count === 2) {
    if (n && s) return 'roadNS';
    if (e && w) return 'roadEW';
    if (n && e) return 'roadNE';
    if (n && w) return 'roadNW';
    if (s && e) return 'roadSE';
    return 'roadSW';
  }
  if (count === 1) {
    // a dead end: the road arrives from the connected side and fades out
    if (s) return 'roadEndN';
    if (n) return 'roadEndS';
    if (e) return 'roadEndW';
    return 'roadEndE';
  }
  return 'roadCross'; // isolated pad (e.g. a base plaza)
}

export const TILE_PX = 16;

const T = TILE_PX;

export class TileCache {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  /** per-consumer cursors into GameState's change tracking, so several
   * caches (main view, minimap) can sync off the same state independently */
  private seenVersion = -1;
  private seenIndex = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_SIZE * T;
    this.canvas.height = MAP_SIZE * T;
    this.ctx = this.canvas.getContext('2d')!;
  }

  sync(state: GameState): void {
    if (this.seenVersion !== state.mapVersion) {
      this.seenVersion = state.mapVersion;
      this.seenIndex = state.terrainLog.length;
      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          this.paintTile(state, x, y);
        }
      }
      return;
    }
    if (state.terrainLog.length > this.seenIndex) {
      const repaint = new Set<number>();
      for (let i = this.seenIndex; i < state.terrainLog.length; i++) {
        const [x, y] = state.terrainLog[i];
        repaint.add(y * MAP_SIZE + x);
        // neighbors too: road connections and coastlines depend on us
        if (x > 0) repaint.add(y * MAP_SIZE + x - 1);
        if (x < MAP_SIZE - 1) repaint.add(y * MAP_SIZE + x + 1);
        if (y > 0) repaint.add((y - 1) * MAP_SIZE + x);
        if (y < MAP_SIZE - 1) repaint.add((y + 1) * MAP_SIZE + x);
      }
      this.seenIndex = state.terrainLog.length;
      for (const i of repaint) this.paintTile(state, i % MAP_SIZE, Math.floor(i / MAP_SIZE));
    }
  }

  private terrainAt(state: GameState, x: number, y: number): Terrain {
    if (x < 0 || y < 0 || x >= MAP_SIZE || y >= MAP_SIZE) return Terrain.DeepSea;
    return state.terrain[y * MAP_SIZE + x] as Terrain;
  }

  private paintTile(state: GameState, x: number, y: number): void {
    const t = this.terrainAt(state, x, y);
    const ctx = this.ctx;
    const px = x * T;
    const py = y * T;
    const h = hash32(x, y);
    const h2 = hash32(y, x, 7);

    switch (t) {
      case Terrain.DeepSea:
        this.paintSea(state, ctx, px, py, x, y, h);
        break;
      case Terrain.River:
        this.paintWater(ctx, px, py, h);
        this.paintBanks(state, ctx, px, py, x, y);
        break;
      case Terrain.BoatTile:
        this.paintWater(ctx, px, py, h);
        this.paintBanks(state, ctx, px, py, x, y);
        this.paintBoat(ctx, px, py, h);
        break;
      case Terrain.Grass:
        this.paintGrass(ctx, px, py, h);
        break;
      case Terrain.Forest:
        this.paintGrass(ctx, px, py, h);
        this.paintTrees(ctx, px, py, h);
        break;
      case Terrain.Swamp:
        this.paintSwamp(state, ctx, px, py, x, y, h, h2);
        break;
      case Terrain.Crater:
        this.paintCrater(ctx, px, py, h);
        break;
      case Terrain.Road:
        this.paintRoad(state, ctx, px, py, x, y);
        break;
      case Terrain.Rubble:
        this.paintRubble(ctx, px, py, h, h2);
        break;
      case Terrain.Building:
        this.paintBuilding(ctx, px, py, false);
        break;
      case Terrain.ShotBuilding:
        this.paintBuilding(ctx, px, py, true);
        break;
      default:
        ctx.fillStyle = '#f0f';
        ctx.fillRect(px, py, T, T);
    }
  }

  private paintSea(
    state: GameState,
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    x: number,
    y: number,
    h: number,
  ): void {
    ctx.drawImage(sprites.images[h % 7 === 0 ? 'waterDeepSparkle' : 'waterDeep'], px, py, T, T);
    // extra depth mottling so open sea doesn't tile too visibly
    ctx.fillStyle = (h & 1) === 0 ? 'rgba(8,14,24,0.22)' : 'rgba(30,48,76,0.16)';
    ctx.fillRect(px + (h % 8), py + ((h >>> 4) % 8), 8, 8);
    // foam along coastlines (any non-sea neighbor)
    const coastN = this.terrainAt(state, x, y - 1) !== Terrain.DeepSea;
    const coastS = this.terrainAt(state, x, y + 1) !== Terrain.DeepSea;
    const coastW = this.terrainAt(state, x - 1, y) !== Terrain.DeepSea;
    const coastE = this.terrainAt(state, x + 1, y) !== Terrain.DeepSea;
    ctx.fillStyle = 'rgba(150,190,230,0.35)';
    if (coastN) ctx.fillRect(px, py, T, 2);
    if (coastS) ctx.fillRect(px, py + T - 2, T, 2);
    if (coastW) ctx.fillRect(px, py, 2, T);
    if (coastE) ctx.fillRect(px + T - 2, py, 2, T);
  }

  private paintWater(ctx: CanvasRenderingContext2D, px: number, py: number, h: number): void {
    ctx.drawImage(sprites.images[(h & 3) === 0 ? 'waterRiverCrackle' : 'waterRiver'], px, py, T, T);
  }

  /** Darker shoreline on river edges that touch land, so banks read as banks. */
  private paintBanks(
    state: GameState,
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    x: number,
    y: number,
  ): void {
    const isLand = (tx: number, ty: number) => {
      const t = this.terrainAt(state, tx, ty);
      return t !== Terrain.DeepSea && t !== Terrain.River && t !== Terrain.BoatTile;
    };
    ctx.fillStyle = 'rgba(20,35,52,0.55)';
    if (isLand(x, y - 1)) ctx.fillRect(px, py, T, 2);
    if (isLand(x, y + 1)) ctx.fillRect(px, py + T - 2, T, 2);
    if (isLand(x - 1, y)) ctx.fillRect(px, py, 2, T);
    if (isLand(x + 1, y)) ctx.fillRect(px + T - 2, py, 2, T);
  }

  private paintBoat(ctx: CanvasRenderingContext2D, px: number, py: number, h: number): void {
    const cx = px + T / 2;
    const cy = py + T / 2;
    const rot = ((h % 4) * Math.PI) / 8;
    ctx.save();
    ctx.translate(cx, cy);
    ctx.rotate(rot);
    // dinghy is 20x38 pointing north; sized so any mooring angle stays
    // inside the tile (neighbor repaints would clip overflow)
    ctx.drawImage(sprites.images.boat, -4, -7.6, 8, 15.2);
    ctx.restore();
  }

  /** Draw a trimmed overlay sprite centered at (cx, cy), longest side `sizePx`, aspect kept. */
  private overlay(
    ctx: CanvasRenderingContext2D,
    img: CanvasImageSource,
    cx: number,
    cy: number,
    sizePx: number,
  ): void {
    const iw = (img as HTMLCanvasElement).width;
    const ih = (img as HTMLCanvasElement).height;
    const k = sizePx / Math.max(iw, ih);
    ctx.drawImage(img, cx - (iw * k) / 2, cy - (ih * k) / 2, iw * k, ih * k);
  }

  /** Subtle dark wash so the bright Kenney tiles sit in our moodier palette. */
  private wash(ctx: CanvasRenderingContext2D, px: number, py: number, alpha = 0.16): void {
    ctx.fillStyle = `rgba(12, 20, 16, ${alpha})`;
    ctx.fillRect(px, py, T, T);
  }

  private paintGrass(ctx: CanvasRenderingContext2D, px: number, py: number, h: number): void {
    ctx.drawImage(sprites.images[(h & 3) === 0 ? 'grass2' : 'grass1'], px, py, T, T);
    this.wash(ctx, px, py);
  }

  private paintTrees(ctx: CanvasRenderingContext2D, px: number, py: number, h: number): void {
    // 2-3 canopies with shadow, jittered per tile
    const canopies = 2 + (h % 2);
    for (let i = 0; i < canopies; i++) {
      const hh = hash32(h, i);
      const cx = px + 4 + (hh % 9);
      const cy = py + 4 + ((hh >> 4) % 9);
      const r = 4 + ((hh >> 8) % 3);
      ctx.fillStyle = 'rgba(0,0,0,0.25)';
      ctx.beginPath();
      ctx.arc(cx + 1.5, cy + 1.5, r, 0, Math.PI * 2);
      ctx.fill();
      // the sprite canopy doesn't fill its frame; oversize to compensate
      const img = sprites.images[(hh & 1) === 0 ? 'treeLarge' : 'treeSmall'];
      ctx.drawImage(img, cx - r * 1.5, cy - r * 1.5, r * 3, r * 3);
    }
  }

  /**
   * Swamp reads as WATER first: stagnant green murk with grassy islets and
   * reeds growing out of them, dark-banked where it meets dry land.
   */
  private paintSwamp(
    state: GameState,
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    x: number,
    y: number,
    h: number,
    h2: number,
  ): void {
    ctx.drawImage(sprites.images[(h & 3) === 0 ? 'waterSwampCrackle' : 'waterSwamp'], px, py, T, T);
    this.wash(ctx, px, py, 0.1);

    // grassy islets breaking the water surface; reeds grow out of them
    const islets: [number, number, number][] = [
      [px + 4 + (h % 8), py + 4 + ((h >>> 4) % 8), 3.4],
      [px + 5 + (h2 % 7), py + 5 + ((h2 >>> 4) % 7), 2.6],
    ];
    for (const [ix, iy, ir] of islets) {
      ctx.fillStyle = '#42603a';
      ctx.beginPath();
      ctx.ellipse(ix + 0.6, iy + 0.8, ir, ir * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
      ctx.fillStyle = '#54744a';
      ctx.beginPath();
      ctx.ellipse(ix, iy, ir, ir * 0.62, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    // reed tufts fanning out of the islets; drawn blades read better at 16px
    // than any sprite — the cattail sprite appears only as a rare accent
    const tuft = (tx: number, ty: number) => {
      ctx.lineWidth = 1;
      ctx.strokeStyle = '#3f5c33';
      ctx.beginPath();
      ctx.moveTo(tx, ty);
      ctx.lineTo(tx - 1.5, ty - 4);
      ctx.moveTo(tx + 1.5, ty);
      ctx.lineTo(tx + 2.7, ty - 4.5);
      ctx.stroke();
      ctx.strokeStyle = '#74904c';
      ctx.beginPath();
      ctx.moveTo(tx + 0.7, ty);
      ctx.lineTo(tx + 0.5, ty - 5.2);
      ctx.stroke();
    };
    tuft(islets[0][0], islets[0][1]);
    if ((h2 & 3) !== 0) tuft(islets[1][0], islets[1][1]);
    if ((h & 7) === 0) {
      this.overlay(ctx, sprites.images.reeds, islets[1][0], islets[1][1] - 2, 6);
    }

    // dark banks against dry land, so the swamp reads as a depression
    const isDry = (tx: number, ty: number) => {
      const t = this.terrainAt(state, tx, ty);
      return t !== Terrain.DeepSea && t !== Terrain.River && t !== Terrain.BoatTile && t !== Terrain.Swamp;
    };
    ctx.fillStyle = 'rgba(24,36,26,0.5)';
    if (isDry(x, y - 1)) ctx.fillRect(px, py, T, 2);
    if (isDry(x, y + 1)) ctx.fillRect(px, py + T - 2, T, 2);
    if (isDry(x - 1, y)) ctx.fillRect(px, py, 2, T);
    if (isDry(x + 1, y)) ctx.fillRect(px + T - 2, py, 2, T);
  }

  /**
   * Crater is blast damage ON the land, not a different biome: the grass
   * stays, with a scorch splat and a deep displaced-earth pit on top.
   */
  private paintCrater(ctx: CanvasRenderingContext2D, px: number, py: number, h: number): void {
    this.paintGrass(ctx, px, py, h);
    const cx = px + T / 2 + ((h % 3) - 1);
    const cy = py + T / 2 + (((h >>> 2) % 3) - 1);
    // blast scorch (tinted oil-spill splat) chars the grass around the pit
    ctx.save();
    ctx.globalAlpha = 0.75;
    this.overlay(ctx, sprites.images.scorch, cx, cy, 14);
    ctx.restore();
    // displaced-earth rim, lit from the top-left
    ctx.fillStyle = '#5c4a30';
    ctx.beginPath();
    ctx.arc(cx, cy, 6, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = '#75603f';
    ctx.beginPath();
    ctx.arc(cx - 0.7, cy - 0.7, 5.4, 0, Math.PI * 2);
    ctx.fill();
    // pit
    ctx.fillStyle = '#33271a';
    ctx.beginPath();
    ctx.arc(cx, cy, 4.4, 0, Math.PI * 2);
    ctx.fill();
    // deepest shadow biased to the lit side, so the hole reads concave
    ctx.fillStyle = '#1f1810';
    ctx.beginPath();
    ctx.arc(cx - 0.8, cy - 0.8, 2.7, 0, Math.PI * 2);
    ctx.fill();
  }

  private paintRoad(
    state: GameState,
    ctx: CanvasRenderingContext2D,
    px: number,
    py: number,
    x: number,
    y: number,
  ): void {
    const isRoad = (tx: number, ty: number) => {
      const t = this.terrainAt(state, tx, ty);
      return t === Terrain.Road || t === Terrain.Building || t === Terrain.ShotBuilding;
    };
    const n = isRoad(x, y - 1);
    const s = isRoad(x, y + 1);
    const w = isRoad(x - 1, y);
    const e = isRoad(x + 1, y);
    ctx.drawImage(sprites.images[roadSprite(n, e, s, w)], px, py, T, T);
    this.wash(ctx, px, py);
  }

  /**
   * Rubble is a COLLAPSED BUILDING: broken slabs in the wall palette strewn
   * over the grass it stood on, with smaller masonry chunks between.
   */
  private paintRubble(ctx: CanvasRenderingContext2D, px: number, py: number, h: number, h2: number): void {
    this.paintGrass(ctx, px, py, h);
    // big angular slabs, tilted like fallen wall sections
    const slabs = 2 + (h & 1);
    for (let i = 0; i < slabs; i++) {
      const hh = hash32(h, h2, i);
      const sx = px + 4 + (hh % 8);
      const sy = py + 4 + ((hh >>> 4) % 8);
      const w = 5 + ((hh >>> 8) % 4);
      const ht = 4 + ((hh >>> 12) % 3);
      const rot = (((hh >>> 16) % 7) - 3) * 0.16;
      ctx.save();
      ctx.translate(sx, sy);
      ctx.rotate(rot);
      ctx.fillStyle = 'rgba(0,0,0,0.35)';
      ctx.fillRect(-w / 2 + 1, -ht / 2 + 1.2, w, ht);
      ctx.fillStyle = (hh & 2) === 0 ? '#454c5b' : '#3d4452';
      ctx.fillRect(-w / 2, -ht / 2, w, ht);
      ctx.fillStyle = '#5b6478';
      ctx.fillRect(-w / 2, -ht / 2, w, 1.5);
      ctx.restore();
    }
    // smaller masonry chunks (Tower Defense stones, slate-tinted)
    const stones = [sprites.images.stone1, sprites.images.stone2, sprites.images.stone3];
    this.overlay(ctx, stones[h % 3], px + 4 + (h % 8), py + 4 + ((h >>> 5) % 8), 5);
    if ((h2 & 3) !== 0) this.overlay(ctx, stones[h2 % 3], px + 5 + (h2 % 7), py + 5 + ((h2 >>> 5) % 7), 4);
  }

  private paintBuilding(ctx: CanvasRenderingContext2D, px: number, py: number, damaged: boolean): void {
    ctx.drawImage(sprites.images.wallRock, px, py, T, T);
    if (damaged) this.wash(ctx, px, py, 0.32);
    // bevel so walls read as built fortifications, not rocky ground
    ctx.fillStyle = 'rgba(255,255,255,0.16)';
    ctx.fillRect(px, py, T, 2);
    ctx.fillRect(px, py, 2, T);
    ctx.fillStyle = 'rgba(0,0,0,0.42)';
    ctx.fillRect(px + T - 2, py, 2, T);
    ctx.fillRect(px, py + T - 2, T, 2);
    if (damaged) {
      // cracks and a bite taken out
      ctx.strokeStyle = '#181b21';
      ctx.lineWidth = 1;
      ctx.beginPath();
      ctx.moveTo(px + 3, py + 4);
      ctx.lineTo(px + 8, py + 9);
      ctx.lineTo(px + 6, py + 13);
      ctx.moveTo(px + 12, py + 3);
      ctx.lineTo(px + 9, py + 8);
      ctx.stroke();
      ctx.fillStyle = '#23262e';
      ctx.fillRect(px + T - 7, py + 1, 6, 5);
    }
  }
}
