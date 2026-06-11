/**
 * Sprite registry: Kenney CC0 art (see public/assets/README.md) loaded by
 * URL. Everything degrades gracefully — the renderer and tile painter fall
 * back to their procedural drawing until `sprites.ready`, and forever for
 * entities we deliberately keep procedural (water, bunkers, base pads, the
 * little green man).
 *
 * The headless preview harness injects a filesystem-based loader.
 */

const MANIFEST = {
  // terrain (Topdown Tanks Remastered, 64x64 full tiles)
  grass1: 'terrain/tileGrass1.png',
  grass2: 'terrain/tileGrass2.png',
  roadNS: 'terrain/tileGrass_roadNorth.png',
  roadEW: 'terrain/tileGrass_roadEast.png',
  // corners named by the two edges they connect
  roadSW: 'terrain/tileGrass_roadCornerLL.png',
  roadSE: 'terrain/tileGrass_roadCornerLR.png',
  roadNW: 'terrain/tileGrass_roadCornerUL.png',
  roadNE: 'terrain/tileGrass_roadCornerUR.png',
  roadCross: 'terrain/tileGrass_roadCrossing.png',
  // T-junctions: split<X> = straight road with a branch toward X
  roadSplitN: 'terrain/tileGrass_roadSplitN.png',
  roadSplitE: 'terrain/tileGrass_roadSplitE.png',
  roadSplitS: 'terrain/tileGrass_roadSplitS.png',
  roadSplitW: 'terrain/tileGrass_roadSplitW.png',
  // dead ends: transition<X> = road fading out toward X
  roadEndN: 'terrain/tileGrass_roadTransitionN.png',
  roadEndE: 'terrain/tileGrass_roadTransitionE.png',
  roadEndS: 'terrain/tileGrass_roadTransitionS.png',
  roadEndW: 'terrain/tileGrass_roadTransitionW.png',
  treeLarge: 'terrain/treeGreen_large.png',
  treeSmall: 'terrain/treeGreen_small.png',

  // tanks (bodies + barrels are separate, both pointing north)
  tankDawn: 'tanks/tankBody_sand_outline.png',
  tankDusk: 'tanks/tankBody_blue_outline.png',
  barrelDawn: 'tanks/tankSand_barrel1_outline.png',
  barrelDusk: 'tanks/tankBlue_barrel1_outline.png',

  bullet: 'projectiles/bulletSand1.png',

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

export type SpriteKey = keyof typeof MANIFEST;

export const sprites: { ready: boolean; images: Partial<Record<SpriteKey, CanvasImageSource>> } = {
  ready: false,
  images: {},
};

export const BOOM_FRAMES = 9;

function browserLoad(url: string): Promise<CanvasImageSource> {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`failed to load ${url}`));
    img.src = url;
  });
}

/**
 * Load every sprite in the manifest. `load` is injectable so the headless
 * preview can read from disk. Resolves when all images are in; sets
 * `sprites.ready` so painters switch over on their next frame.
 */
export async function loadSprites(
  load: (url: string) => Promise<CanvasImageSource> = browserLoad,
  baseUrl = '/assets/',
): Promise<void> {
  await Promise.all(
    (Object.keys(MANIFEST) as SpriteKey[]).map(async (key) => {
      sprites.images[key] = await load(baseUrl + MANIFEST[key]);
    }),
  );
  sprites.ready = true;
}
