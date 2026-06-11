# ATBOLO wire protocol

JSON text frames over a WebSocket at `wss://<host>/ws`. The same protocol
serves the web client, external bots, and spectators. Canonical message
types live in `packages/shared/src/protocol.ts` — this document is the prose
version. The server simulates at **10 Hz** and is fully authoritative.

## Authentication

### Humans (atproto OAuth)

Browsers just navigate to:

```
GET /oauth/login?handle=you.bsky.social
```

The server resolves your handle → DID → PDS → authorization server, performs
a pushed authorization request (PKCE + DPoP), and redirects you to your own
PDS/entryway to consent. The callback lands on `/#token=...&did=...&handle=...`
— the web client stores that session token. Client metadata is served at
`/oauth/client-metadata.json`. The game keeps **no** atproto tokens.

### Headless bots

A bot can't click a consent screen, so it authenticates by proving control
of its account to its *own* PDS and showing the result:

```
POST /api/login/start   { "handle": "mybot.bsky.social" }
  -> { "did": "did:plc:...", "pds": "https://..." }

# call your own PDS yourself — credentials never touch the game server:
POST {pds}/xrpc/com.atproto.server.createSession
  { "identifier": "mybot.bsky.social", "password": "<credential>" }
  -> { "did": "...", "accessJwt": "..." }

POST /api/login/verify  { "did": "...", "accessJwt": "..." }
  -> { "token": "<session token>", "did": "...", "handle": "..." }
```

Session tokens are valid for 30 days for both flows. Keep it; you do not
need to re-verify per connection.

### Dev mode

When the server runs with `DEV_AUTH=1` (local only):

```
POST /api/login/dev     { "handle": "ferris" }
  -> { "token": "...", "did": "did:dev:ferris", "handle": "ferris.dev" }
```

## Connecting

Open the WebSocket and send `hello` as your first frame:

```json
{ "t": "hello", "token": "<session token>", "role": "player", "client": "bot" }
{ "t": "hello", "role": "spectator" }
```

`client` (optional: `keyboard | touch | bot`) declares what's driving the
tank; it only segments balance telemetry and has no gameplay effect.

Players receive `welcome`, then `state` at 10 Hz. Spectators receive
`welcome` (with `you: null`), then `spectate` at 1 Hz. One connection per
identity: a second login closes the first (code 4000). Auth failure closes
with code 4001 — don't reconnect with the same token.

## Client → server

| message | fields | notes |
|---|---|---|
| `input` | `accel`, `turn` ∈ [-1, 1], `fire: bool`, `nudge?: number` | held controls, Bolo-style: applies every tick until replaced. Fractional `turn` enables fine aiming. Positive turn is clockwise (screen space, y-down). Send only on change. `nudge` is a discrete extra rotation in radians (clamped to ±0.35/message), queued server-side and drained at the standard turn rate — lossless fine aiming for tap-style inputs, can't out-turn a held key. |
| `builder` | `order`, `x`, `y` (tile coords) | dispatch the engineer. `order` ∈ `harvest \| road \| wall \| boat \| pillbox \| mine`. Max range 12 tiles from tank. Costs trees/mines (see below); invalid orders return an `error` frame with the reason. |
| `builder_recall` | — | abort the current trip; refunds the order's cost |
| `respawn` | `baseId?` | request respawn at a friendly base (note: auto-respawn at a random friendly base fires 6 s after death; this mainly matters for choosing *where*) |
| `chat` | `text` (≤240 chars) | global chat |
| `emote` | `kind` | float an emote bubble over your tank. `kind` ∈ `happy \| angry \| sad \| heart \| laugh \| alert \| question \| sleep`. Rate-limited to one per 1.5 s; broadcast to everyone as `emoted { tankId, kind }`. |
| `ping` | `n` | server echoes `pong` with same `n` |

### Builder orders & costs

| order | target tile must be | cost | effect |
|---|---|---|---|
| `harvest` | forest | — | tile → grass, +4 trees |
| `road` | open land or river | 2 trees | tile → road (river = bridge) |
| `wall` | open land | 2 trees (1 to repair a shot wall) | tile → building |
| `boat` | river | 10 trees | tile → boat; drive on to embark |
| `pillbox` | friendly/dead pill: repair (+15 hp, 4 trees). Else: place carried pill (2 trees) | see left | captured pills are picked up by driving over their husk |
| `mine` | any land without a mine | 1 tank mine | hidden from the enemy; visible to your faction |

The builder is killable (shells, mines, enemy treads). He respawns in your
tank 30 s later.

## Server → client

- `welcome` — your identity & faction, war info, **full map** (`map.terrain`
  is base64 of 256×256 bytes; values are the `Terrain` enum below), all
  pillboxes & bases, and mine tiles your faction knows about.
- `state` (10 Hz, players) — all tanks/shells/builders within **24 tiles** of
  your tank (enemy tanks deep in forest are omitted — concealment is real);
  `pills`/`bases` arrays only when something changed; `terrain` as
  `[x, y, newTerrain]` deltas; `mines` as `[x, y, present]` deltas
  (your faction's mines + all removals); `events` (kills, captures, booms).
  Your own tank entry additionally carries `armor/shells/mines/trees/carriedPill`.
- `spectate` (1 Hz, spectators) — every tank, all pills/bases, war info,
  terrain deltas, online counts. No mines, full visibility.
- `chat`, `emoted`, `war_over`, `new_war` (a fresh `welcome` follows), `pong`, `error`.

## Stats & leaderboard

Per-DID profiles persist across wars (kills, deaths, captures, wars fought
and won — you're only credited for wars you actually connected to). `GET
/api/war` returns the top 50 by rating (`kills + 3×caps`) plus war history;
the web leaderboard at `/leaderboard` enriches rows with live atproto
identity (avatars/display names from the public AppView, linking to
bsky.app). With `DEV_AUTH=1`, `POST /api/dev/seed` injects test
profiles/history for UI work.

## Terrain enum

| value | terrain | tank speed | notes |
|---|---|---|---|
| 0 | deep sea | — | lethal without a boat |
| 1 | river | 25% | fordable; bridgeable; boats live here |
| 2 | swamp | 25% | |
| 3 | crater | 25% | battle scar; mines and dying tanks make these |
| 4 | road | 100% | |
| 5 | forest | 50% | hides tanks from enemies & pillboxes |
| 6 | rubble | 25% | |
| 7 | grass | 75% | |
| 8 | building | blocked | stops shells; shootable → 9 |
| 9 | shot building | 25% | repairable; shootable → rubble |
| 10 | boat | 25% | drive on to embark |

## Combat numbers worth knowing

- Tank: 40 armor, 40 shells max, shell = 5 damage, range 7, fire every 0.35 s.
- Pillbox: 75 hp, range 8, fires faster the more damaged it is (2.0 s → 0.4 s
  cooldown), self-repairs slowly. At 0 hp it's a husk — drive over it to
  carry it, then `pillbox`-order to re-emplace it for your side.
- Bases refuel friendly tanks standing on them (armor/shells/mines, 2/s from
  stock). Enemy bases: shell them to drain `armorStock`, or park on the pad
  (drains 2 stock/s, costs you 2 armor/s) — at 0 stock it flips. Stock
  regenerates only while uncontested.
- Mines: 20 damage, chain-react with adjacent mines, leave craters. ~40
  neutral mines are buried on every island and visible to no one.
- War ends when one faction owns all 14 bases (10-minute minimum war length).

## Bot tips

- The reference implementation in `packages/bot/` is ~200 lines and beats the
  built-in garrison NPCs — start there.
- You get the full map in `welcome` and deltas afterwards; maintaining your
  own terrain mirror is cheap and worth it for pathfinding.
- Don't spam `input`: it's held state. The server drops connections flooding
  more than ~80 messages/sec.
- Spectator role is allowed for bots too — useful for map analysis or a
  strategy co-processor connection.
