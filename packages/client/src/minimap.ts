/**
 * 1px-per-tile terrain image for the HUD minimap. The old approach reused
 * the full-resolution TileCache — a SECOND 4096x4096 canvas (the largest
 * iOS Safari tolerates) — and downscaled all 16 megapixels of it with
 * smoothing every frame. This paints the same intel into a 256x256
 * ImageData: ~260KB of backing memory instead of ~67MB, patched per-tile
 * as terrain deltas arrive.
 */
import { MAP_SIZE, Terrain } from '@bolo/shared';
import type { GameState } from './state';

/** Flat tile colors echoing the main tileset's palette. */
const TILE_RGB: Record<Terrain, [number, number, number]> = {
  [Terrain.DeepSea]: [13, 24, 38],
  [Terrain.River]: [46, 84, 122],
  [Terrain.Swamp]: [56, 78, 56],
  [Terrain.Crater]: [76, 60, 41],
  [Terrain.Road]: [122, 124, 118],
  [Terrain.Forest]: [38, 70, 40],
  [Terrain.Rubble]: [82, 86, 96],
  [Terrain.Grass]: [74, 104, 62],
  [Terrain.Building]: [150, 155, 168],
  [Terrain.ShotBuilding]: [104, 108, 120],
  [Terrain.BoatTile]: [120, 144, 170],
};

export class MiniMapCache {
  canvas: HTMLCanvasElement;
  private ctx: CanvasRenderingContext2D;
  private img: ImageData;
  /** the ImageData's pixels as packed 32-bit values (little-endian RGBA) */
  private px: Uint32Array;
  /** Terrain byte -> packed pixel */
  private palette = new Uint32Array(16);
  /** cursors into GameState's terrain-change tracking (see state.ts) */
  private seenVersion = -1;
  private seenIndex = 0;

  constructor() {
    this.canvas = document.createElement('canvas');
    this.canvas.width = MAP_SIZE;
    this.canvas.height = MAP_SIZE;
    this.ctx = this.canvas.getContext('2d')!;
    this.img = this.ctx.createImageData(MAP_SIZE, MAP_SIZE);
    this.px = new Uint32Array(this.img.data.buffer);
    for (const [t, [r, g, b]] of Object.entries(TILE_RGB)) {
      this.palette[Number(t)] = (0xff << 24) | (b << 16) | (g << 8) | r;
    }
  }

  sync(state: GameState): void {
    if (this.seenVersion !== state.mapVersion) {
      this.seenVersion = state.mapVersion;
      this.seenIndex = state.terrainLog.length;
      for (let i = 0; i < state.terrain.length; i++) this.px[i] = this.palette[state.terrain[i]];
      this.ctx.putImageData(this.img, 0, 0);
      return;
    }
    if (state.terrainLog.length > this.seenIndex) {
      for (let i = this.seenIndex; i < state.terrainLog.length; i++) {
        const [x, y] = state.terrainLog[i];
        const idx = y * MAP_SIZE + x;
        this.px[idx] = this.palette[state.terrain[idx]];
      }
      this.seenIndex = state.terrainLog.length;
      this.ctx.putImageData(this.img, 0, 0);
    }
  }
}
