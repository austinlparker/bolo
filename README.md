# ATBOLO — the forever war

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

One-time setup:

```sh
pnpm install
pnpm --filter @bolo/server exec wrangler login      # or set CLOUDFLARE_API_TOKEN
openssl rand -hex 32 | pnpm --filter @bolo/server exec wrangler secret put SESSION_SECRET
```

Then, every deploy:

```sh
pnpm deploy    # builds the client, deploys worker + assets + Durable Object
```

That's the whole game — static client, API, WebSockets, simulation, storage —
in a single `wrangler deploy`. World state persists in the Durable Object's
storage; no external database. SQLite-backed Durable Objects run on the
**free plan**, so no paid plan is required to start.

You'll get `https://atbolo.<your-subdomain>.workers.dev`. atproto OAuth works
there out of the box: the client metadata and redirect URLs derive from the
request origin, so no per-domain configuration is needed — the same goes for
a custom domain later (add it on the Worker in the Cloudflare dashboard, or
via `routes` in `wrangler.toml`). Keep `DEV_AUTH = "0"` in production (the
default); `wrangler tail` streams live logs if anything misbehaves.

## Signing in with atproto

Human sign-in is **atproto OAuth** — no passwords, ever. Enter your handle,
get redirected to your own PDS/entryway to consent, and you're in. Under the
hood the server runs the full spec dance (handle → DID → PDS → authorization
server discovery, PAR, PKCE, DPoP with nonce retry), verifies that the
authenticated DID's own PDS endorses the issuer that vouched for it, mints a
30-day HMAC session token, and **discards the atproto tokens** — the game
never acts on your PDS, so it keeps no OAuth credentials at all. Interim flow
state lives in an encrypted HttpOnly cookie; there is no server-side session
store. On localhost the atproto loopback-client convention is used, so OAuth
works in local dev too (you land on `:8787`, the wrangler origin).

Headless bots can't drive a browser consent screen; they authenticate by
creating a session with *their own PDS* themselves and presenting the access
JWT to `/api/login/verify`, which the server validates against that PDS (see
`docs/PROTOCOL.md`). The game server never sees a bot credential either.

## Design divergences from original Bolo

Deliberate adaptations for a persistent, two-faction world:

- Fixed factions replace free-form alliances; friendly fire is off.
- Bases are the win condition (hold all 14). Defended bases can be drained by
  bombardment or sieged by parking on the pad.
- Respawn is automatic at a friendly base (original LAN matches ended; a
  forever war can't).
- Tank-tank collision is not simulated.

## Roadmap

- Boat improvements (builder ferrying, deep-sea travel)
- Per-war terrain inheritance (battle scars carrying into the next island)
- Leaderboard page backed by the existing `/api/war` data
- Hibernatable WebSockets if the player count ever makes it worth it
