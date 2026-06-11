# Game art assets

Curated sprites for BOLO, sourced from the **Kenney Game Assets All-in-1** collection.
Lives under `public/` so files keep stable URLs — load in the canvas renderer via
`new Image(); img.src = '/assets/tanks/tankBody_blue.png'` (no bundler import needed).

The renderer is still 100% procedural (see `src/render.ts`, `src/tiles.ts`); nothing here is
wired up yet. This is the candidate library to draw from when sprite-ifying.

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
| `crosshair/` | Crosshair Pack | Aiming reticle for touch aim (`touch.ts`) and spectator. 6 outline styles. |
| `mobile/joystick/` | Mobile Controls | Virtual stick + buttons for `touch.ts`. `joystick_circle_pad_*` (base) + `joystick_circle_nub_*` (thumb); `button_circle/diamond/...` for fire/action. |
| `mobile/icons/` | Mobile Controls | HUD glyphs: `icon_crosshair`, `icon_fire`, `icon_cog` (NPC/builder), `icon_lock`, `icon_menu`, `icon_burst`, etc. |
| `ui/grey/`, `ui/blue/` | UI Pack | Panels, buttons (9-slice `button_rectangle_*`), arrows, sliders for HUD + login chrome. Grey = neutral, blue = accent. |

## Notes

- Non-retina (`Default size`) variants only, to keep the lib lean. Retina/2× and the full
  200-design crosshair set were dropped — re-pull from the source pack if needed.
- Map Pack water is a light icy blue, not BOLO's deep navy. Either recolor or keep the
  procedural sea — a style call for later.
</content>
</invoke>
