/**
 * Reference external bot. Connects over the same public protocol the web
 * client uses, authenticated with its own atproto identity.
 *
 * Usage:
 *   BOLO_URL=https://bolo.example.com \
 *   BOT_HANDLE=mybot.bsky.social BOT_PASSWORD=app-password \
 *   pnpm --filter @bolo/bot start
 *
 * For a local DEV_AUTH=1 server you can skip atproto entirely:
 *   BOLO_URL=http://localhost:8787 BOT_DEV_NAME=ferris pnpm --filter @bolo/bot start
 */
import {
  base64ToBytes,
  type Base,
  type ClientMsg,
  MAP_SIZE,
  type ServerMsg,
  SHELL_RANGE,
  type TankView,
  Terrain,
  TERRAIN,
  type WelcomeMsg,
} from '@bolo/shared';

const BOLO_URL = process.env.BOLO_URL ?? 'http://localhost:8787';

async function login(): Promise<string> {
  if (process.env.BOLO_TOKEN) return process.env.BOLO_TOKEN;

  if (process.env.BOT_DEV_NAME) {
    const res = await fetch(`${BOLO_URL}/api/login/dev`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle: process.env.BOT_DEV_NAME }),
    });
    const data = (await res.json()) as { token?: string; error?: string };
    if (!data.token) throw new Error(`dev login failed: ${data.error}`);
    return data.token;
  }

  const handle = process.env.BOT_HANDLE;
  const password = process.env.BOT_PASSWORD;
  if (!handle || !password) throw new Error('set BOT_HANDLE + BOT_PASSWORD (or BOT_DEV_NAME / BOLO_TOKEN)');

  const start = (await (
    await fetch(`${BOLO_URL}/api/login/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ handle }),
    })
  ).json()) as { did?: string; pds?: string; error?: string };
  if (!start.did || !start.pds) throw new Error(`resolve failed: ${start.error}`);

  const sess = (await (
    await fetch(`${start.pds.replace(/\/$/, '')}/xrpc/com.atproto.server.createSession`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identifier: handle, password }),
    })
  ).json()) as { did?: string; accessJwt?: string };
  if (!sess.accessJwt) throw new Error('PDS rejected credentials');

  const verify = (await (
    await fetch(`${BOLO_URL}/api/login/verify`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ did: sess.did, accessJwt: sess.accessJwt }),
    })
  ).json()) as { token?: string; error?: string };
  if (!verify.token) throw new Error(`verify failed: ${verify.error}`);
  return verify.token;
}

interface BotBrain {
  me: WelcomeMsg['you'];
  terrain: Uint8Array;
  bases: Base[];
  myTank: TankView | null;
  enemies: TankView[];
  lastSent: string;
}

function think(b: BotBrain): ClientMsg | null {
  const me = b.myTank;
  if (!me || !me.alive || !b.me) return null;

  // nearest enemy in shell range -> fight; else march on a base we don't own
  let target: { x: number; y: number } | null = null;
  let fire = false;
  let enemy: TankView | null = null;
  let enemyD = SHELL_RANGE;
  for (const e of b.enemies) {
    const d = Math.hypot(e.x - me.x, e.y - me.y);
    if (d < enemyD) {
      enemyD = d;
      enemy = e;
    }
  }
  if (enemy) {
    target = enemy;
    fire = (me.shells ?? 0) > 0;
  } else {
    let bestD = Infinity;
    for (const base of b.bases) {
      if (base.owner === b.me.faction) continue;
      const d = Math.hypot(base.x + 0.5 - me.x, base.y + 0.5 - me.y) + (base.owner === 'neutral' ? 0 : 50);
      if (d < bestD) {
        bestD = d;
        target = { x: base.x + 0.5, y: base.y + 0.5 };
      }
    }
  }
  if (!target) return null;

  const want = Math.atan2(target.y - me.y, target.x - me.x);
  let delta = want - me.dir;
  while (delta > Math.PI) delta -= 2 * Math.PI;
  while (delta < -Math.PI) delta += 2 * Math.PI;

  // don't drive into buildings or off the island
  const ax = me.x + Math.cos(me.dir) * 1.5;
  const ay = me.y + Math.sin(me.dir) * 1.5;
  const xi = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(ax)));
  const yi = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(ay)));
  const ahead = b.terrain[yi * MAP_SIZE + xi] as Terrain;
  const blocked = ahead === Terrain.Building || (ahead === Terrain.DeepSea && !me.onBoat) || TERRAIN[ahead].tankSpeed === 0;

  const turn = blocked ? 1 : delta > 0.07 ? 1 : delta < -0.07 ? -1 : 0;
  const advance = enemy ? enemyD > 3 : true;
  return {
    t: 'input',
    accel: advance || blocked ? 1 : 0,
    turn,
    fire: fire && Math.abs(delta) < 0.15 && !blocked,
  };
}

async function main(): Promise<void> {
  const token = await login();
  const wsUrl = BOLO_URL.replace(/^http/, 'ws') + '/ws';
  const ws = new WebSocket(wsUrl);

  const brain: BotBrain = {
    me: null,
    terrain: new Uint8Array(MAP_SIZE * MAP_SIZE),
    bases: [],
    myTank: null,
    enemies: [],
    lastSent: '',
  };

  ws.onopen = () => {
    ws.send(JSON.stringify({ t: 'hello', token, role: 'player', client: 'bot' } satisfies ClientMsg));
    console.log('connected to', wsUrl);
  };

  ws.onmessage = (ev) => {
    const msg = JSON.parse(String(ev.data)) as ServerMsg;
    switch (msg.t) {
      case 'welcome':
        brain.me = msg.you;
        brain.terrain = base64ToBytes(msg.map.terrain);
        brain.bases = msg.bases;
        console.log(`enlisted as ${msg.you?.handle} [${msg.you?.faction}] — war ${msg.war.warNumber}`);
        break;
      case 'state': {
        if (msg.bases) brain.bases = msg.bases;
        if (msg.terrain) for (const [x, y, t] of msg.terrain) brain.terrain[y * MAP_SIZE + x] = t;
        brain.myTank = msg.tanks.find((t) => t.id === brain.me?.tankId) ?? null;
        brain.enemies = msg.tanks.filter((t) => t.alive && t.faction !== brain.me?.faction);
        const decision = think(brain);
        if (decision) {
          const key = JSON.stringify(decision);
          if (key !== brain.lastSent) {
            brain.lastSent = key;
            ws.send(key);
          }
        }
        break;
      }
      case 'war_over':
        console.log(`war over — ${msg.winner} wins`);
        break;
      case 'error':
        console.error('server error:', msg.code, msg.msg);
        break;
      default:
        break;
    }
  };

  ws.onclose = () => {
    console.log('disconnected, retrying in 5s');
    setTimeout(() => void main(), 5000);
  };
}

void main().catch((err) => {
  console.error(err);
  process.exit(1);
});
