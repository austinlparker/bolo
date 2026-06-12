# Game art assets

Curated sprites for BOLO, sourced from the **Kenney Game Assets All-in-1** collection.
Lives under `public/` so files keep stable URLs — load in the canvas renderer via
`new Image(); img.src = '/assets/tanks/tankBody_blue.png'` (no bundler import needed).

Wiring status (`src/sprites.ts` is the manifest/loader; sprites load behind a loading
screen before the first frame — there is NO fallback art, painters assume the registry
is populated):

- **Wired, with load-time recoloring** (blend-mode tints in `src/sprites.ts` keep one
  consistent palette): grass, the full road connection set, forest trees; Map Pack water
  retargeted to BOLO navy (deep/river variants); Map Pack dirt -> craters, gray rock ->
  walls; RTS Sci-fi gun turret (scifiStructure_13) -> pillboxes with the gunless mount
  (scifiStructure_14) as the dead husk, and RTS Sci-fi HQ -> bases, all faction-tinted (dawn
  amber / dusk violet / neutral gray); tank+barrel+bullet from single sand bases,
  faction-multiplied; tracers colored per faction; the LGM is now a little green *machine* -
  worker robot scifiUnit_39, green-tinted; explosion frame sequences; joystick pad skins. Owned bases also fly a **procedural
  waving flag** (`drawFlag` in render.ts — sine-rippled pennant, faction-colored).
- **Wired, untinted**: `tanks/tracksSmall` → fading tread-mark decals behind moving tanks;
  `boats/dinghyLarge1` (Pirate Pack) → moored boat tiles + the landing craft under tanks.
- **Wired terrain overlays** (atlas slices, alpha-trimmed + tinted in `src/sprites.ts`):
  Map Pack water retinted to stagnant green → swamp base (reads as wetland, with drawn
  reed tufts + the Map Pack cattail mapTile_119 as a rare accent); Tower Defense stones
  (tilesheet r5 c20-22, slate-tinted) → rubble masonry chunks over drawn slabs;
  `tanks/oilSpill_large` tinted near-black → crater blast scorch under the procedural pit.
  Design rule: crater/rubble keep a GRASS base (damage on the land, not a new biome).
- **Still procedural**: mine markers, hp/stock bars, anger auras, shadows, coast foam and
  river/swamp banks, reed tufts, crater pit rings, rubble slabs, minimap blips.
  (No top-down blast-crater or landmine sprite exists anywhere in the Kenney collection -
  audited 2026-06; Tank Pack mines are side-view.)
- **UI chrome**: buttons across login/HUD/tray/spectator are 9-sliced UI Pack sprites
  (`.kbtn` in style.css) recolored with CSS filters — dark slate for normal chrome, the
  blue gradient hue-rotated to amber for primary actions. Crosshair 029 (faction-tinted)
  is the in-world gun-range cursor; crosshair 049 dials the aim stick.

## License

All Kenney assets are **CC0 1.0** (public domain) — free for commercial use, attribution
optional but appreciated (kenney.nl). No license file needs to ship, but crediting Kenney is
the decent thing to do.

## Layout & BOLO mapping

| Folder | Source pack | Maps to |
|---|---|---|
| `tanks/` | Topdown Tanks Remastered | Player tanks. `tankBody_<color>.png` + `tank<Color>_barrel1.png` are **separate sprites** — body rotates with hull dir, barrel rotates to aim, mirroring the current hull/barrel split in `drawTank`. `tracks*` → tread marks; `oilSpill*` → damage decals. Colors: blue/red/green/sand/dark. Natural faction map: **dusk → blue**, **dawn → sand** (gold). `_outline` variants read better on busy terrain. |
| `terrain/` | Topdown Tanks Remastered | `tileGrass1/2` → Grass; `tileGrass_road*` (full connection set: N/E, corners, crossing, split, transition) → Road, replacing the neighbor-aware `paintRoad`; `tileSand*` → beach/shore; `treeGreen/Brown_*` → Forest canopies. |
| `projectiles/` | Topdown Tanks Remastered | `bullet*1.png` → shells in flight; `shot*.png` → muzzle flash / tracer. |
| `fx/` | Explosion Pack | `regularExplosion00–08` → shell `drawBoom` animation; ground explosion + particles → mine booms. Frame-sequence, not single sprite. |
| `mappack-atlas/` | Map Pack | **Texture atlas** (`mapPack_spritesheet.png` + `.xml` frame coords; `mapPack_tilesheet.png` is the contact sheet). Same cartoon style as the tanks. Covers what Topdown Tanks lacks: **water** (DeepSea/River/BoatTile), brown dirt + crater tiles, gray rock, lava, **castle → Base**, **tower → Pillbox**, extra trees/bushes/rocks. Tiles are named only `mapTile_NNN` — needs visual slicing to pick specific ones. |
| `boats/` | Pirate Pack | `dinghyLarge1.png` → moored boat tiles (BoatTile) + the landing craft under a tank on water. Same cartoon style as the tank packs; more dinghy/ship variants in the source pack. |
| `crosshair/` | Crosshair Pack | Aiming reticle for touch aim (`touch.ts`) and spectator. 6 outline styles. |
| `mobile/joystick/` | Mobile Controls | Virtual stick + buttons for `touch.ts`. `joystick_circle_pad_*` (base) + `joystick_circle_nub_*` (thumb); `button_circle/diamond/...` for fire/action. |
| `mobile/icons/` | Mobile Controls | HUD glyphs: `icon_crosshair`, `icon_fire`, `icon_cog` (NPC/builder), `icon_lock`, `icon_menu`, `icon_burst`, etc. |
| `ui/grey/`, `ui/blue/` | UI Pack | Panels, buttons (9-slice `button_rectangle_*`), arrows, sliders for HUD + login chrome. Grey = neutral, blue = accent. |
| `ui/scifi/` | UI Pack - Sci-fi | `metalPanel.png` 9-sliced (`.kpanel` in style.css) → the desktop HUD's gunmetal console frames, darkened with CSS filters. `glassPanel*` unused so far (dialog candidates). |
| `fonts/` | UI Pack - Sci-fi | **Kenney Future** (`--font-display`) → big ALL-CAPS headlines only; body chrome is Verdana, terminal text monospace. Future Narrow shipped but currently unused. |
| `sfx/` | Sci-Fi Sounds + Interface Sounds (Audio/) | `fire*` (laserSmall) → cannon shots; `boom*` (explosionCrunch) → shell hits; `bigboom*` (lowFrequency_explosion) → mines + your own death; `error0`/`capture0`/`click0` (Interface) → UI cues. Loaded by `src/sound.ts`, distance-attenuated, M mutes. |
| `characters-1bit/` | 1-Bit Pack | **Atlas** (`*_packed.png`, transparent, no inter-tile margin → uniform-grid slice). A whole roguelike set: characters/monsters, weapons, items, terrain, UI glyphs, a font. Alt art direction if we ever want a 1-bit look; or cherry-pick icons. Colored + monochrome. |
| `tower-defense/` | Tower Defense | **Atlas** (`towerDefense_tilesheet.png`, uniform grid). Same cartoon style as the tank/map packs: **turrets → Pillbox** options, terrain plots, road tiles, projectiles, gems/pickups. 299 source tiles packed; slice the grid to pick. |
| `patterns/` | Pattern Pack | Seamless B/W tileable patterns (stripes, chevrons, bricks, dots, hearts…) for menu/HUD backgrounds or faction texturing. `patternPack_tilesheet.png` is the full contact sheet; `pattern_NN.png` are a curated sample — recolor as needed. |
| `ranks/` | Ranks Pack | Full **Gold** insignia ladder (`rank000–077`: chevrons, bars, stars) for player progression / leaderboard tiers. Bronze/Silver/Black variants also exist in the source pack. |
| `emotes/` | Emote Pack | Full **Style 1** emote set (anger, alert, heart, cash, cloud, sleep…) for chat reactions / status bubbles over tanks. 8 vector styles + pixel variants in the source pack. |
| `rts-scifi/` | RTS Sci-fi | `structures/scifiStructure_11` → **Base** (HQ), faction-tinted, replacing the Map Pack castle. Other structures (turrets/factories) + a 48-sprite **unit** set in blue/orange/green/gray are candidates for faction infantry / alt pillboxes. `scifi_tilesheet.png` is the contact sheet. |

## Notes

- Non-retina (`Default size`) variants only, to keep the lib lean. Retina/2× and the full
  200-design crosshair set were dropped — re-pull from the source pack if needed.
- Map Pack water is a light icy blue, not BOLO's deep navy. Either recolor or keep the
  procedural sea — a style call for later.
