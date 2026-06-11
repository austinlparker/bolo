/**
 * Offscreen tilemap cache: the whole 256x256 map painted once at 8px/tile,
 * then patched in place as terrain-change deltas arrive.
 */
import { hash32, MAP_SIZE, Terrain } from '@bolo/shared';
import type { GameState } from './state';

export const TILE_PX = 8;

const BASE_COLORS: Record<number, string> = {
  [Terrain.DeepSea]: '#15233c',
  [Terrain.River]: '#2e62a8',
  [Terrain.Swamp]: '#4a5a33',
  [Terrain.Crater]: '#54432f',
  [Terrain.Road]: '#83868c',
  [Terrain.Forest]: '#1e4726',
  [Terrain.Rubble]: '#6b6258',
  [Terrain.Grass]: '#3e6b35',
  [Terrain.Building]: '#262a33',
  [Terrain.ShotBuilding]: '#3d4350',
  [Terrain.BoatTile]: '#2e62a8',
};

export class TileCache {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_SIZE * TILE_PX;
    this.canvas.height = MAP_SIZE * TILE_PX;
    this.ctx = this.canvas.getContext('2d')!;
  }

  sync(state: GameState): void {
    if (state.mapReset) {
      state.mapReset = false;
      state.dirtyTiles = [];
      for (let y = 0; y < MAP_SIZE; y++) {
        for (let x = 0; x < MAP_SIZE; x++) {
          this.paintTile(state, x, y);
        }
      }
      return;
    }
    if (state.dirtyTiles.length) {
      for (const [x, y] of state.dirtyTiles) this.paintTile(state, x, y);
      state.dirtyTiles = [];
    }
  }

  private paintTile(state: GameState, x: number, y: number): void {
    const t = state.terrain[y * MAP_SIZE + x] as Terrain;
    const ctx = this.ctx;
    const px = x * TILE_PX;
    const py = y * TILE_PX;
    const h = hash32(x, y);

    ctx.fillStyle = BASE_COLORS[t] ?? '#f0f';
    ctx.fillRect(px, py, TILE_PX, TILE_PX);

    // cheap per-tile texture, deterministic so repaints are stable
    switch (t) {
      case Terrain.Grass:
        ctx.fillStyle = 'rgba(255,255,255,0.04)';
        ctx.fillRect(px + (h % 6), py + ((h >> 3) % 6), 2, 2);
        break;
      case Terrain.Forest:
        ctx.fillStyle = '#143618';
        ctx.fillRect(px + (h % 4), py + ((h >> 2) % 4), 3, 3);
        ctx.fillRect(px + 4 + ((h >> 4) % 3), py + 4 + ((h >> 6) % 3), 3, 3);
        break;
      case Terrain.DeepSea:
        ctx.fillStyle = 'rgba(255,255,255,0.05)';
        if (h % 5 === 0) ctx.fillRect(px + (h % 6), py + ((h >> 3) % 7), 3, 1);
        break;
      case Terrain.River:
        ctx.fillStyle = 'rgba(255,255,255,0.12)';
        ctx.fillRect(px + (h % 5), py + ((h >> 3) % 7), 3, 1);
        break;
      case Terrain.Swamp:
        ctx.fillStyle = '#2e62a8';
        ctx.fillRect(px + (h % 5), py + ((h >> 3) % 5), 3, 2);
        break;
      case Terrain.Crater:
        ctx.strokeStyle = '#3a2d1e';
        ctx.lineWidth = 2;
        ctx.beginPath();
        ctx.arc(px + 4, py + 4, 3, 0, Math.PI * 2);
        ctx.stroke();
        break;
      case Terrain.Road:
        ctx.fillStyle = '#6f7277';
        if ((x + y) % 2 === 0) ctx.fillRect(px + 3, py + 3, 2, 2);
        break;
      case Terrain.Rubble:
        ctx.fillStyle = '#564e45';
        ctx.fillRect(px + (h % 5), py + ((h >> 3) % 5), 2, 2);
        ctx.fillRect(px + ((h >> 5) % 6), py + ((h >> 8) % 6), 2, 2);
        break;
      case Terrain.Building:
        ctx.fillStyle = '#3a404e';
        ctx.fillRect(px, py, TILE_PX, 1);
        ctx.fillRect(px, py, 1, TILE_PX);
        ctx.fillStyle = '#11141a';
        ctx.fillRect(px + TILE_PX - 1, py, 1, TILE_PX);
        ctx.fillRect(px, py + TILE_PX - 1, TILE_PX, 1);
        break;
      case Terrain.ShotBuilding:
        ctx.fillStyle = '#262a33';
        ctx.fillRect(px + (h % 4), py + ((h >> 2) % 4), 4, 4);
        break;
      case Terrain.BoatTile:
        ctx.fillStyle = '#8a6034';
        ctx.beginPath();
        ctx.ellipse(px + 4, py + 4, 3.4, 2, (h % 4) * 0.4, 0, Math.PI * 2);
        ctx.fill();
        break;
      default:
        break;
    }
  }
}
