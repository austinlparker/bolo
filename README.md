# BOLO — the forever war

A web-based, persistent-world reimagining of [Bolo](https://en.wikipedia.org/wiki/Bolo_(1987_video_game)),
Stuart Cheshire's classic networked Macintosh tank game — rebuilt as a
foxhole-esque, two-faction territorial war that grinds on around the clock.

- **Persistent world**: one shared 256×256 procedurally generated island,
  simulated server-side in a Cloudflare Durable Object. Terrain scars,
  fortifications, and frontlines persist across sessions.
- **War cycles**: two factions — **Dawn Concord** and **Dusk Pact** — fight
  over 14 bases. When one faction holds them all, the war is recorded in
  history and a fresh island is generated (its seed chained from the last
  war), and the next war begins.
- **Classic Bolo mechanics**: terrain types (road/swamp/forest/river/crater…),
  an engineer ("builder") you dispatch to chop trees, pave roads, raise walls,
  build boats, lay mines and emplace pillboxes; capturable pillboxes that get
  *angrier* as they take damage; bases that refuel armor/shells/mines and can
  be besieged or bombarded.
- **atproto identity**: log in with your Bluesky / atproto handle. Your
  faction, kills, captures, and wars-fought follow your DID.
- **Humans and bots are peers**: the same documented JSON-over-WebSocket
  protocol serves the web client, external bots, and spectators. Server-side
  NPC garrisons keep the war alive when nobody's online.
- **Public war map**: `/map` shows the whole island, every unit, and war
  history live — no login needed.

## Repo layout

```
packages/
  shared/   types, constants, wire protocol, RNG + procedural map generator
  server/   Cloudflare Worker + GameDO Durable Object (authoritative sim)
  client/   Vite + canvas web client (play at /, spectate at /map)
  bot/      reference external bot (Node, same protocol as the web client)
docs/
  PROTOCOL.md       wire protocol reference (for bot authors)
  ARCHITECTURE.md   server design, persistence, war lifecycle
```

## Quickstart (local)

```sh
pnpm install

# terminal 1 — API + sim on :8787 (dev auth enabled via .dev.vars)
echo 'DEV_AUTH = "1"' > packages/server/.dev.vars   # if not already present
pnpm --filter @bolo/server dev

# terminal 2 — hot-reloading client on :5173 (proxies /api and /ws to :8787)
pnpm --filter @bolo/client dev
```

Open http://localhost:5173, click **dev login** (no atproto round-trip
locally), and drive: **WASD** to move, **space** to fire, **1–6** to choose a
builder tool, **click** the map to dispatch the builder, **R** to recall him,
**enter** to chat. http://localhost:5173/map is the public spectator view.

Run the reference bot against it:

```sh
BOLO_URL=http://localhost:8787 BOT_DEV_NAME=ferris pnpm --filter @bolo/bot start
```

Simulate a full NPC-only war headlessly (great for balance work):

```sh
pnpm --filter @bolo/server smoke <seed> <max-minutes>
```

## Deploy (Cloudflare)

```sh
wrangler secret put SESSION_SECRET --cwd packages/server   # any long random string
pnpm deploy    # builds the client, deploys worker + assets + Durable Object
```

The whole game — static client, API, WebSockets, simulation, storage — is a
single `wrangler deploy`. World state persists in the Durable Object's
storage; no external database.

## Signing in with atproto

Production sign-in uses an [app password](https://bsky.app/settings/app-passwords):

1. The server resolves your handle → DID → PDS.
2. **Your browser** calls `com.atproto.server.createSession` against *your own
   PDS* — the password never touches the game server.
3. The game server verifies the returned access JWT against your PDS
   (`getSession`), confirms the DID, and mints its own HMAC session token.

Bots authenticate the same way (see `docs/PROTOCOL.md`). Migrating to full
atproto OAuth is the planned next step; the session-token layer is what it
will plug into.

## Design divergences from original Bolo

Deliberate adaptations for a persistent, two-faction world:

- Fixed factions replace free-form alliances; friendly fire is off.
- Bases are the win condition (hold all 14). Defended bases can be drained by
  bombardment or sieged by parking on the pad.
- Respawn is automatic at a friendly base (original LAN matches ended; a
  forever war can't).
- Tank-tank collision is not simulated.

## Roadmap

- atproto OAuth (replace app-password flow)
- Boat improvements (builder ferrying, deep-sea travel)
- Per-war terrain inheritance (battle scars carrying into the next island)
- Leaderboard page backed by the existing `/api/war` data
- Hibernatable WebSockets if the player count ever makes it worth it
