/**
 * Sprite registry + recolor pipeline. All art comes from the Kenney packs
 * (see public/assets/README.md); palette consistency comes from tinting at
 * load time — sprites are drawn into offscreen canvases and recolored with
 * blend modes ('color' to retarget hue/saturation, 'multiply' to darken),
 * so faction colors, our navy water, and neutral greys all derive from the
 * same source art. Painters keep procedural fallbacks until `sprites.ready`.
 *
 * The headless preview harness injects a filesystem-based image loader.
 */

// ---------- source files ----------

const FILES = {
  // terrain (Topdown Tanks Remastered, 64x64 full tiles)
  grass1: 'terrain/tileGrass1.png',
  grass2: 'terrain/tileGrass2.png',
  roadNS: 'terrain/tileGrass_roadNorth.png',
  roadEW: 'terrain/tileGrass_roadEast.png',
  roadSW: 'terrain/tileGrass_roadCornerLL.png',
  roadSE: 'terrain/tileGrass_roadCornerLR.png',
  roadNW: 'terrain/tileGrass_roadCornerUL.png',
  roadNE: 'terrain/tileGrass_roadCornerUR.png',
  roadCross: 'terrain/tileGrass_roadCrossing.png',
  roadSplitN: 'terrain/tileGrass_roadSplitN.png',
  roadSplitE: 'terrain/tileGrass_roadSplitE.png',
  roadSplitS: 'terrain/tileGrass_roadSplitS.png',
  roadSplitW: 'terrain/tileGrass_roadSplitW.png',
  roadEndN: 'terrain/tileGrass_roadTransitionN.png',
  roadEndE: 'terrain/tileGrass_roadTransitionE.png',
  roadEndS: 'terrain/tileGrass_roadTransitionS.png',
  roadEndW: 'terrain/tileGrass_roadTransitionW.png',
  treeLarge: 'terrain/treeGreen_large.png',
  treeSmall: 'terrain/treeGreen_small.png',

  // single-color bases that get faction-tinted below
  tankBase: 'tanks/tankBody_sand_outline.png',
  barrelBase: 'tanks/tankSand_barrel1_outline.png',
  bulletBase: 'projectiles/bulletSand1.png',
  crosshairBase: 'crosshair/crosshair029.png',
  baseStructure: 'rts-scifi/structures/scifiStructure_07.png', // RTS domed HQ -> capturable base

  // Map Pack atlas (sliced via ATLAS below)
  atlas: 'mappack-atlas/mapPack_spritesheet.png',

  // explosion frame sequences (192x192)
  boomShell0: 'fx/regularExplosion00.png',
  boomShell1: 'fx/regularExplosion01.png',
  boomShell2: 'fx/regularExplosion02.png',
  boomShell3: 'fx/regularExplosion03.png',
  boomShell4: 'fx/regularExplosion04.png',
  boomShell5: 'fx/regularExplosion05.png',
  boomShell6: 'fx/regularExplosion06.png',
  boomShell7: 'fx/regularExplosion07.png',
  boomShell8: 'fx/regularExplosion08.png',
  boomMine0: 'fx/groundExplosion00.png',
  boomMine1: 'fx/groundExplosion01.png',
  boomMine2: 'fx/groundExplosion02.png',
  boomMine3: 'fx/groundExplosion03.png',
  boomMine4: 'fx/groundExplosion04.png',
  boomMine5: 'fx/groundExplosion05.png',
  boomMine6: 'fx/groundExplosion06.png',
  boomMine7: 'fx/groundExplosion07.png',
  boomMine8: 'fx/groundExplosion08.png',
} as const;

/** Map Pack atlas frames we use (rects baked from mapPack_spritesheet.xml). */
const ATLAS = {
  water: [64, 448, 64, 64], // mapTile_171: plain water
  waterSparkle: [0, 320, 64, 64], // mapTile_187: water with sparkles
  waterCrackle: [0, 256, 64, 64], // mapTile_188: water with wave crackle
  dirt: [448, 640, 64, 64], // mapTile_084: plain dirt
  dirtMarked: [448, 320, 64, 64], // mapTile_089: textured dirt
  rock: [768, 576, 64, 64], // mapTile_015: gray rock, textured
  tower: [832, 320, 64, 64], // mapTile_099: watchtower -> pillbox
  man: [256, 0, 64, 64], // mapTile_136: the little green man
} as const;

type FileKey = keyof typeof FILES;
type AtlasKey = keyof typeof ATLAS;

/** Derived (tinted) sprite keys, generated at load time. */
type DerivedKey =
  | 'waterDeep'
  | 'waterDeepSparkle'
  | 'waterRiver'
  | 'waterRiverCrackle'
  | 'craterBase'
  | 'wallRock'
  | 'towerDawn'
  | 'towerDusk'
  | 'towerNeutral'
  | 'towerHusk'
  | 'baseDawn'
  | 'baseDusk'
  | 'baseNeutral'
  | 'builderMan'
  | 'tankDawn'
  | 'tankDusk'
  | 'barrelDawn'
  | 'barrelDusk'
  | 'bulletDawn'
  | 'bulletDusk'
  | 'bulletNeutral'
  | 'crosshairDawn'
  | 'crosshairDusk';

export type SpriteKey = FileKey | AtlasKey | DerivedKey;

export const sprites: { ready: boolean; images: Partial<Record<SpriteKey, CanvasImageSource>> } = {
  ready: false,
  images: {},
};

export const BOOM_FRAMES = 9;

// faction tint palette (multiply targets; light so shading survives)
const TINT = {
  dawnLight: '#ffc97d',
  duskLight: '#b69cff',
  neutralLight: '#d4d9e0',
};

// ---------- loading ----------

function browserLoad(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

function mkCanvas(w: number, h: number): HTMLCanvasElement {
  const c = document.createElement('canvas');
  c.width = w;
  c.height = h;
  return c;
}

interface TintOpts {
  /** 'color' blend: retarget hue+saturation, keep luminosity */
  color?: string;
  /** 'multiply' blend: darken / colorize toward this */
  multiply?: string;
}

/** Cut a region from `src` and recolor it into a standalone canvas. */
function tinted(
  src: CanvasImageSource,
  rect: readonly [number, number, number, number] | null,
  opts: TintOpts,
): HTMLCanvasElement {
  const [sx, sy, sw, sh] = rect ?? [0, 0, (src as HTMLImageElement).width, (src as HTMLImageElement).height];
  const c = mkCanvas(sw, sh);
  const ctx = c.getContext('2d')!;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  if (opts.color) {
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = opts.color;
    ctx.fillRect(0, 0, sw, sh);
  }
  if (opts.multiply) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = opts.multiply;
    ctx.fillRect(0, 0, sw, sh);
  }
  // blends paint the whole rect; restore the sprite's alpha mask
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);
  ctx.globalCompositeOperation = 'source-over';
  return c;
}

/**
 * Load all art and build the tinted variants. `load` is injectable so the
 * headless preview can read from disk. Sets `sprites.ready` when done.
 */
export async function loadSprites(
  load: (url: string) => Promise<CanvasImageSource> = browserLoad,
  baseUrl = '/assets/',
): Promise<void> {
  await Promise.all(
    (Object.keys(FILES) as FileKey[]).map(async (key) => {
      sprites.images[key] = await load(baseUrl + FILES[key]);
    }),
  );

  const atlas = sprites.images.atlas!;
  const img = sprites.images as Record<SpriteKey, CanvasImageSource>;

  // raw atlas slices
  for (const key of Object.keys(ATLAS) as AtlasKey[]) {
    img[key] = tinted(atlas, ATLAS[key], {});
  }

  // --- water: Map Pack ice-blue retargeted to BOLO navy ---
  img.waterDeep = tinted(atlas, ATLAS.water, { color: '#39629c', multiply: '#46536e' });
  img.waterDeepSparkle = tinted(atlas, ATLAS.waterSparkle, { color: '#39629c', multiply: '#46536e' });
  img.waterRiver = tinted(atlas, ATLAS.water, { color: '#4577b8', multiply: '#7e90ad' });
  img.waterRiverCrackle = tinted(atlas, ATLAS.waterCrackle, { color: '#4577b8', multiply: '#7e90ad' });

  // --- terrain features ---
  img.craterBase = tinted(atlas, ATLAS.dirtMarked, { multiply: '#9b8468' });
  img.wallRock = tinted(atlas, ATLAS.rock, { multiply: '#8e95a4' });

  // --- faction structures ---
  img.towerDawn = tinted(atlas, ATLAS.tower, { multiply: TINT.dawnLight });
  img.towerDusk = tinted(atlas, ATLAS.tower, { multiply: TINT.duskLight });
  img.towerNeutral = tinted(atlas, ATLAS.tower, { color: '#9aa3ad', multiply: TINT.neutralLight });
  img.towerHusk = tinted(atlas, ATLAS.tower, { color: '#70767e', multiply: '#6d727b' });
  img.baseDawn = tinted(img.baseStructure, null, { multiply: TINT.dawnLight });
  img.baseDusk = tinted(img.baseStructure, null, { multiply: TINT.duskLight });
  img.baseNeutral = tinted(img.baseStructure, null, { color: '#9aa3ad', multiply: TINT.neutralLight });

  // --- the little green man (already green; just lift him off the atlas) ---
  img.builderMan = img.man;

  // --- vehicles & ordnance: one sand-colored base, faction-multiplied ---
  img.tankDawn = tinted(img.tankBase, null, { multiply: TINT.dawnLight });
  img.tankDusk = tinted(img.tankBase, null, { multiply: TINT.duskLight });
  img.barrelDawn = tinted(img.barrelBase, null, { multiply: TINT.dawnLight });
  img.barrelDusk = tinted(img.barrelBase, null, { multiply: TINT.duskLight });
  img.bulletDawn = tinted(img.bulletBase, null, { multiply: TINT.dawnLight });
  img.bulletDusk = tinted(img.bulletBase, null, { multiply: TINT.duskLight });
  img.bulletNeutral = tinted(img.bulletBase, null, { multiply: TINT.neutralLight });

  // gun-range cursor (the crosshair pack art is white; multiply colors it)
  img.crosshairDawn = tinted(img.crosshairBase, null, { multiply: '#f5b04a' });
  img.crosshairDusk = tinted(img.crosshairBase, null, { multiply: '#a98ef5' });

  sprites.ready = true;
}
