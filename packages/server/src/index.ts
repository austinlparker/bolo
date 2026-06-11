/**
 * Worker entry: API routes + WebSocket handoff to the world Durable Object,
 * falling through to static client assets.
 */
import { mintToken, pdsFromDidDoc, resolveDidDoc, resolveHandle, verifyAtprotoSession } from './auth';
import { type Env, sessionSecret } from './env';
import { clientMetadata, handleOauthCallback, handleOauthLogin } from './oauth';

export { GameDO } from './do/game';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
};

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS },
  });
}

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS' && url.pathname.startsWith('/api/')) {
      return new Response(null, { headers: CORS });
    }

    // the single world instance
    const world = () => env.GAME.get(env.GAME.idFromName('world'));

    if (url.pathname === '/ws') {
      return world().fetch(request);
    }

    // atproto OAuth (human sign-in)
    if (url.pathname === '/oauth/client-metadata.json') {
      return json(clientMetadata(url.origin));
    }
    if (url.pathname === '/oauth/login') {
      return handleOauthLogin(request, env);
    }
    if (url.pathname === '/oauth/callback') {
      return handleOauthCallback(request, env);
    }

    if (url.pathname === '/api/war' || url.pathname === '/api/status') {
      const res = await world().fetch(new Request(new URL('/status', url.origin)));
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (url.pathname === '/api/login/start' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { handle?: string };
      const handle = (body.handle ?? '').trim().replace(/^@/, '');
      if (!handle) return json({ error: 'handle required' }, 400);
      const did = await resolveHandle(handle);
      if (!did) return json({ error: `could not resolve handle ${handle}` }, 404);
      const doc = await resolveDidDoc(did);
      const pds = doc ? pdsFromDidDoc(doc) : null;
      if (!pds) return json({ error: 'could not resolve PDS for DID' }, 404);
      return json({ did, pds });
    }

    if (url.pathname === '/api/login/verify' && request.method === 'POST') {
      const body = (await request.json().catch(() => ({}))) as { did?: string; accessJwt?: string };
      if (!body.did || !body.accessJwt) return json({ error: 'did and accessJwt required' }, 400);
      const verified = await verifyAtprotoSession(body.did, body.accessJwt);
      if (!verified) return json({ error: 'atproto session verification failed' }, 401);
      const token = await mintToken(sessionSecret(env), verified.did, verified.handle);
      return json({ token, did: verified.did, handle: verified.handle });
    }

    if (url.pathname === '/api/dev/seed' && request.method === 'POST') {
      if (env.DEV_AUTH !== '1') return json({ error: 'dev seeding disabled' }, 403);
      const res = await world().fetch(new Request(new URL('/seed', url.origin), request));
      return new Response(res.body, { status: res.status, headers: { 'Content-Type': 'application/json', ...CORS } });
    }

    if (url.pathname === '/api/login/dev' && request.method === 'POST') {
      if (env.DEV_AUTH !== '1') return json({ error: 'dev login disabled' }, 403);
      const body = (await request.json().catch(() => ({}))) as { handle?: string };
      const name = (body.handle ?? '').trim().toLowerCase().replace(/[^a-z0-9-]/g, '');
      if (!name) return json({ error: 'handle required' }, 400);
      const token = await mintToken(sessionSecret(env), `did:dev:${name}`, `${name}.dev`);
      return json({ token, did: `did:dev:${name}`, handle: `${name}.dev` });
    }

    if (url.pathname.startsWith('/api/')) {
      return json({ error: 'not found' }, 404);
    }

    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
