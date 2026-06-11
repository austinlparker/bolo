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

  // tread-mark decal (points north, like the tank sprites)
  tracks: 'tanks/tracksSmall.png',

  // dark splat, re-tinted into the crater scorch ring
  oilLarge: 'tanks/oilSpill_large.png',

  // Tower Defense tilesheet (sliced via TD_ATLAS below)
  tdAtlas: 'tower-defense/towerDefense_tilesheet.png',

  // rowboat (Pirate Pack dinghy): moored boat tiles + the landing craft under tanks
  boat: 'boats/dinghyLarge1.png',

  // single-color bases that get faction-tinted below
  tankBase: 'tanks/tankBody_sand_outline.png',
  barrelBase: 'tanks/tankSand_barrel1_outline.png',
  bulletBase: 'projectiles/bulletSand1.png',
  crosshairBase: 'crosshair/crosshair029.png',
  baseStructure: 'rts-scifi/structures/scifiStructure_07.png', // RTS domed HQ -> capturable base
  pillTurret: 'rts-scifi/structures/scifiStructure_13.png', // gun turret -> live pillbox
  pillMount: 'rts-scifi/structures/scifiStructure_14.png', // gunless mount -> dead pillbox husk
  builderBot: 'rts-scifi/units/scifiUnit_39.png', // worker robot with tool -> the LGM

  // emote bubbles (raw, no tint)
  emoteHappy: 'emotes/emote_faceHappy.png',
  emoteAngry: 'emotes/emote_faceAngry.png',
  emoteSad: 'emotes/emote_faceSad.png',
  emoteHeart: 'emotes/emote_heart.png',
  emoteLaugh: 'emotes/emote_laugh.png',
  emoteAlert: 'emotes/emote_exclamation.png',
  emoteQuestion: 'emotes/emote_question.png',
  emoteSleep: 'emotes/emote_sleep.png',

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
  rock: [768, 576, 64, 64], // mapTile_015: gray rock, textured
  reeds: [320, 192, 64, 64], // mapTile_119: cattail clump
} as const;

/** Tower Defense tilesheet frames (uniform 23x13 grid of 64px tiles). */
const TD_ATLAS = {
  stone1: [1280, 320, 64, 64], // angular gray stones, three shapes
  stone2: [1344, 320, 64, 64],
  stone3: [1408, 320, 64, 64],
} as const;

type FileKey = keyof typeof FILES;
type AtlasKey = keyof typeof ATLAS;
type TdKey = keyof typeof TD_ATLAS;

/** Derived (tinted) sprite keys, generated at load time. */
type DerivedKey =
  | 'waterDeep'
  | 'waterDeepSparkle'
  | 'waterRiver'
  | 'waterRiverCrackle'
  | 'waterSwamp'
  | 'waterSwampCrackle'
  | 'scorch'
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

export type SpriteKey = FileKey | AtlasKey | TdKey | DerivedKey;

export const sprites: { ready: boolean; images: Partial<Record<SpriteKey, CanvasImageSource>> } = {
  ready: false,
  images: {},
};

export const BOOM_FRAMES = 9;

/** emote kind -> sprite key (kinds come from shared EMOTES) */
export const EMOTE_SPRITES: Record<string, SpriteKey> = {
  happy: 'emoteHappy',
  angry: 'emoteAngry',
  sad: 'emoteSad',
  heart: 'emoteHeart',
  laugh: 'emoteLaugh',
  alert: 'emoteAlert',
  question: 'emoteQuestion',
  sleep: 'emoteSleep',
};

/** emote kind -> asset URL (for DOM <img> in the picker) */
export const EMOTE_FILES: Record<string, string> = Object.fromEntries(
  Object.entries(EMOTE_SPRITES).map(([kind, key]) => [kind, `/assets/${FILES[key as FileKey]}`]),
);

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
  /** crop transparent padding so draw sizes reflect actual content */
  trim?: boolean;
}

/** Cut a region from `src` and recolor it into a standalone canvas. */
function tinted(
  src: CanvasImageSource,
  rect: readonly [number, number, number, number] | null,
  opts: TintOpts,
): HTMLCanvasElement {
  const [sx, sy, sw, sh] = rect ?? [0, 0, (src as HTMLImageElement).width, (src as HTMLImageElement).height];
  let c = mkCanvas(sw, sh);
  let ctx = c.getContext('2d')!;
  ctx.drawImage(src, sx, sy, sw, sh, 0, 0, sw, sh);

  if (opts.trim) {
    const data = ctx.getImageData(0, 0, sw, sh).data;
    let minX = sw, minY = sh, maxX = -1, maxY = -1;
    for (let y = 0; y < sh; y++) {
      for (let x = 0; x < sw; x++) {
        if (data[(y * sw + x) * 4 + 3] > 8) {
          if (x < minX) minX = x;
          if (x > maxX) maxX = x;
          if (y < minY) minY = y;
          if (y > maxY) maxY = y;
        }
      }
    }
    if (maxX >= minX) {
      const tw = maxX - minX + 1;
      const th = maxY - minY + 1;
      const trimmedC = mkCanvas(tw, th);
      const tctx = trimmedC.getContext('2d')!;
      tctx.drawImage(c, minX, minY, tw, th, 0, 0, tw, th);
      c = trimmedC;
      ctx = tctx;
    }
  }

  const w = c.width;
  const h = c.height;
  const mask = mkCanvas(w, h);
  mask.getContext('2d')!.drawImage(c, 0, 0);
  if (opts.color) {
    ctx.globalCompositeOperation = 'color';
    ctx.fillStyle = opts.color;
    ctx.fillRect(0, 0, w, h);
  }
  if (opts.multiply) {
    ctx.globalCompositeOperation = 'multiply';
    ctx.fillStyle = opts.multiply;
    ctx.fillRect(0, 0, w, h);
  }
  // blends paint the whole rect; restore the sprite's alpha mask
  ctx.globalCompositeOperation = 'destination-in';
  ctx.drawImage(mask, 0, 0);
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

  // overlay sprites get alpha-trimmed so painters can place them tightly:
  // cattails muted toward swamp olive; Tower Defense stones slate-tinted to
  // match the building/wall palette (rubble = collapsed masonry, not gravel)
  img.reeds = tinted(atlas, ATLAS.reeds, { multiply: '#a9b07a', trim: true });
  const td = sprites.images.tdAtlas!;
  for (const key of Object.keys(TD_ATLAS) as TdKey[]) {
    img[key] = tinted(td, TD_ATLAS[key], { multiply: '#8e95a4', trim: true });
  }

  // --- water: Map Pack ice-blue retargeted to BOLO navy ---
  img.waterDeep = tinted(atlas, ATLAS.water, { color: '#39629c', multiply: '#46536e' });
  img.waterDeepSparkle = tinted(atlas, ATLAS.waterSparkle, { color: '#39629c', multiply: '#46536e' });
  img.waterRiver = tinted(atlas, ATLAS.water, { color: '#4577b8', multiply: '#7e90ad' });
  img.waterRiverCrackle = tinted(atlas, ATLAS.waterCrackle, { color: '#4577b8', multiply: '#7e90ad' });
  // swamp: the same water retargeted to a stagnant green murk
  img.waterSwamp = tinted(atlas, ATLAS.water, { color: '#48684e', multiply: '#76855f' });
  img.waterSwampCrackle = tinted(atlas, ATLAS.waterCrackle, { color: '#48684e', multiply: '#76855f' });

  // --- terrain features ---
  img.scorch = tinted(img.oilLarge!, null, { multiply: '#2a241c', trim: true });
  img.wallRock = tinted(atlas, ATLAS.rock, { multiply: '#8e95a4' });

  // --- faction structures ---
  // pillbox: RTS gun turret, faction-tinted; the gunless mount is the husk
  img.towerDawn = tinted(img.pillTurret, null, { multiply: TINT.dawnLight, trim: true });
  img.towerDusk = tinted(img.pillTurret, null, { multiply: TINT.duskLight, trim: true });
  img.towerNeutral = tinted(img.pillTurret, null, { color: '#9aa3ad', multiply: TINT.neutralLight, trim: true });
  img.towerHusk = tinted(img.pillMount, null, { color: '#70767e', multiply: '#878c95', trim: true });
  img.baseDawn = tinted(img.baseStructure, null, { multiply: TINT.dawnLight, trim: true });
  img.baseDusk = tinted(img.baseStructure, null, { multiply: TINT.duskLight, trim: true });
  img.baseNeutral = tinted(img.baseStructure, null, { color: '#9aa3ad', multiply: TINT.neutralLight, trim: true });

  // --- the little green man, now a little green machine: worker robot, green-tinted ---
  img.builderMan = tinted(img.builderBot, null, { multiply: '#9fe89b', trim: true });

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
