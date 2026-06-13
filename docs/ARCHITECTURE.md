# Architecture

## Shape of the thing

```
 browser client (canvas)──┐
 external bots ───────────┼── wss /ws ──► Worker ──► GameDO (Durable Object)
 spectators / map page ───┘                 │            │
                                            │            ├─ World (pure TS sim @ 10 Hz)
 atproto PDS ◄── /api/login/* ──────────────┘            ├─ NPC garrison AI
 (createSession by client; getSession                    └─ DO storage (map, entities,
  verification by server)                                   profiles, war history)
```

One Durable Object instance (`idFromName("world")`) owns the entire game:
every WebSocket, the authoritative simulation, and all persistence. At the
target scale — O(tens) of concurrent players — this is comfortably within a
single DO's capacity (the headless smoke test runs the sim ~300–3000×
realtime), and it buys us strict consistency with zero coordination.

## The simulation (`server/src/sim/`)

Pure TypeScript, no Workers APIs — testable headlessly (`pnpm --filter
@bolo/server smoke <seed> <minutes>` runs whole NPC wars in seconds). The DO
drives `doTick()` at 10 Hz and fans out the returned deltas:

- **terrain/mine deltas** as `[x, y, value]` triples (clients hold a full
  mirror from `welcome`),
- **pills/bases** broadcast in full only on change,
- **tanks/shells/builders** rebroadcast every tick, filtered per player by
  view radius (24 tiles) and forest concealment.

The sim only ticks while at least one socket is connected. With nobody
watching, the world freezes — which is fine for a persistent war, and means
idle cost is zero. An alarm still rolls an intermission into the next war on
schedule.

### File structure

The `World` class (`world.ts`) is a thin orchestrator that owns entity
collections and per-tick accumulators, delegating simulation logic to six
subsystem classes in `systems/`:

| File | Responsibility |
|---|---|
| `world.ts` | Public API, entity state, tick orchestration, persistence |
| `context.ts` | `SimContext` interface (shared mutable state view) |
| `world-host.ts` | `WorldHost` interface (cross-system method delegation) |
| `utils.ts` | `canBuildOn`, `clamp`, `clampInt`, `round2stat` |
| `systems/tank-system.ts` | Tank physics: turn inertia, terrain speed, firing |
| `systems/shell-system.ts` | Shell flight, collision, detonation, telemetry |
| `systems/pill-system.ts` | Pillbox self-repair and autonomous fire |
| `systems/base-system.ts` | Base refuel, capture, siege |
| `systems/builder-system.ts` | Builder orders, lifecycle, movement |
| `systems/damage-system.ts` | Damage, death, mines, tile transitions |

Each system receives a `WorldHost` reference (the `World` instance) in its
constructor, giving it read/write access to shared state and cross-system
methods (damage, kill, setTerrain, etc.).

## Persistence

DO storage keys, written every 30 s of active play, on last-disconnect, and
at war transitions:

| key | contents |
|---|---|
| `meta` | war number/seed/phase, entity tables (bases, pills), sim tick |
| `terrain`, `mines` | raw `Uint8Array(65536)` map layers |
| `profiles` | per-DID: faction, kills/deaths/caps, wars fought |
| `history` | one `WarRecord` per finished war |

Tanks are *not* persisted across disconnects — your resources reset when you
log back in, but the world (and your profile) remembers everything else.

## War lifecycle

1. `World(warNumber, seed)` generates the island (see below) with 3 starting
   bases per faction and 8 neutral.
2. Victory check (all 14 bases, ≥10 min in): record history, broadcast
   `war_over`, enter a 2-minute intermission.
3. New war: `seed' = hash(seed, warNumber+1)` — geography is a chain, every
   island descended from the last. Connected players are re-seated and get a
   fresh `welcome`.

## Map generation (`shared/src/mapgen.ts`)

Seeded value-noise fBm (no dependencies) builds an island: radial falloff to
deep sea, shallow coastal water, ridge-line rivers, forest and swamp from
separate noise fields. Then base/pill sites are picked with spacing
constraints, roads (and bridges) connect each base to its nearest neighbour,
and ~40 hidden neutral mines are buried mid-island.

**Fairness**: every map is 180°-rotationally symmetric — tile `(x, y)`
mirrors `(W-1-x, W-1-y)`, and every base/pill placement is mirrored. Dawn
starts NW, Dusk starts SE, geometrically identical.

## NPC garrison (`server/src/sim/npc.ts`)

Keeps each faction at ≥3 tanks so the war progresses with zero humans
online (culled as humans join). Priority ladder: resupply when low → duel
visible enemies → bombard pillboxes/bases from stand-off range → march on
the nearest takeable base. Navigation is tile-level Dijkstra weighted by
terrain speed with a coastline penalty, recomputed every ~4 s, plus local
probe-and-veer steering and analog (fractional) turn control.

All state (name counter, per-tank AI memories, A* scratch buffers) lives in
an `NpcController` class instance, one per `GameDO`. Module-level facade
functions (`balanceNpcs`, `npcThink`) remain for backward compatibility.

Hard-won tuning notes, so nobody re-learns them:
- waypoint "reached" radius must exceed the full-speed turn radius
  (v/ω ≈ 0.94 tiles) or tanks orbit waypoints forever;
- quantized ±1 turn input cannot settle inside the firing cone — fine aim
  needs fractional turn;
- unweighted shortest paths hug the coast through shallow water and wedge
  tanks against the sea edge.

The smoke test is the regression harness for all of this: wars across seeds
must end (typically 20–130 NPC-only minutes) with either side able to win.

## Auth

`/api/login/*` lives in the stateless Worker. Handle → DID via the public
bsky AppView; DID → PDS via plc.directory (or did:web). The server never
sees a password: clients call `createSession` on their own PDS and hand over
the access JWT, which the server verifies by calling `getSession` on that
PDS. Successful verification mints a 30-day HMAC-SHA256 session token
(`SESSION_SECRET`), checked locally (no network) when a socket says hello.

## GameDO collaborators (`server/src/do/`)

`GameDO` (`game.ts`) is a thin Durable Object that owns storage and the tick
loop, delegating to three collaborators:

| File | Responsibility |
|---|---|
| `game.ts` | DO interface, fetch routing, socket accept, tick orchestration |
| `session-store.ts` | Session tracking, broadcast/send plumbing |
| `view-builder.ts` | Per-player/spectator view computation (welcome, state, spectate) |
| `war-manager.ts` | Player profiles, war history, victory/new-war transitions |

## Scaling, if it ever matters

Not needed at O(tens), but the seams are already there: the world is a
single class keyed by DO name, and the NPC controller and all subsystems are
per-instance (no module-global state), so sharding to N islands (or a
hex-grid of region DOs, Foxhole-style) is a routing change in the Worker;
the spectator feed could move to a fan-out DO; per-player state messages
could switch to binary frames. The protocol's `welcome`+delta design
wouldn't change.
