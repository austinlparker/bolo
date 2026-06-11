/**
 * atproto OAuth (authorization code + PKCE + PAR + DPoP), hand-rolled for
 * Workers. We only need verified identity: after the token exchange we
 * confirm the DID belongs to the issuer that authenticated it, mint our own
 * session token, and discard the atproto tokens (the game never calls the
 * PDS on the user's behalf — so no refresh/DPoP-bound API client to keep).
 *
 * All interim flow state (PKCE verifier, per-flow DPoP key, expected
 * issuer/state) rides in an AES-GCM-encrypted, HttpOnly cookie — no
 * server-side session store.
 *
 * Flow:
 *   GET /oauth/client-metadata.json   public client metadata (client_id doc)
 *   GET /oauth/login?handle=...       resolve -> PAR -> 302 to authserver
 *   GET /oauth/callback?state&code    token exchange -> verify -> /#token=...
 */
import { handleFromDidDoc, mintToken, pdsFromDidDoc, resolveDidDoc, resolveHandle } from './auth';
import { type Env, sessionSecret } from './env';

// ---------- small codecs ----------

const te = new TextEncoder();

function b64url(bytes: Uint8Array | ArrayBuffer): string {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let bin = '';
  for (const b of arr) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

function randomB64(bytes: number): string {
  const buf = new Uint8Array(bytes);
  crypto.getRandomValues(buf);
  return b64url(buf);
}

// ---------- client metadata ----------

interface ClientIds {
  clientId: string;
  redirectUri: string;
}

/**
 * On a public host the client_id is the URL of our metadata document. On
 * localhost, atproto's special loopback client applies: client_id is
 * literally `http://localhost` with the redirect_uri/scope inlined as query
 * params, and the redirect host must be 127.0.0.1.
 */
export function clientIdsFor(origin: string): ClientIds {
  const url = new URL(origin);
  if (url.hostname === 'localhost' || url.hostname === '127.0.0.1') {
    const redirectUri = `http://127.0.0.1:${url.port || '80'}/oauth/callback`;
    const q = new URLSearchParams({ redirect_uri: redirectUri, scope: 'atproto' });
    return { clientId: `http://localhost?${q}`, redirectUri };
  }
  return { clientId: `${origin}/oauth/client-metadata.json`, redirectUri: `${origin}/oauth/callback` };
}

export function clientMetadata(origin: string): Record<string, unknown> {
  const { clientId, redirectUri } = clientIdsFor(origin);
  return {
    client_id: clientId,
    client_name: 'ATBOLO — the forever war',
    client_uri: origin,
    application_type: 'web',
    grant_types: ['authorization_code', 'refresh_token'],
    response_types: ['code'],
    redirect_uris: [redirectUri],
    scope: 'atproto',
    token_endpoint_auth_method: 'none',
    dpop_bound_access_tokens: true,
  };
}

// ---------- authorization server discovery ----------

interface AsMetadata {
  issuer: string;
  authorization_endpoint: string;
  token_endpoint: string;
  pushed_authorization_request_endpoint: string;
}

async function authServerForPds(pds: string): Promise<string | null> {
  const res = await fetch(`${pds.replace(/\/$/, '')}/.well-known/oauth-protected-resource`);
  if (!res.ok) return null;
  const data = (await res.json()) as { authorization_servers?: string[] };
  return data.authorization_servers?.[0] ?? null;
}

async function authServerMetadata(issuer: string): Promise<AsMetadata | null> {
  const res = await fetch(`${issuer.replace(/\/$/, '')}/.well-known/oauth-authorization-server`);
  if (!res.ok) return null;
  const meta = (await res.json()) as Partial<AsMetadata>;
  if (
    meta.issuer !== issuer || // spec-required self-consistency check
    !meta.authorization_endpoint ||
    !meta.token_endpoint ||
    !meta.pushed_authorization_request_endpoint
  ) {
    return null;
  }
  return meta as AsMetadata;
}

// ---------- DPoP ----------

interface DpopKey {
  privateKey: CryptoKey;
  publicJwk: { kty: string; crv: string; x: string; y: string };
}

async function generateDpopKey(): Promise<{ key: DpopKey; privateJwk: JsonWebKey }> {
  const pair = (await crypto.subtle.generateKey({ name: 'ECDSA', namedCurve: 'P-256' }, true, [
    'sign',
  ])) as CryptoKeyPair;
  const pub = (await crypto.subtle.exportKey('jwk', pair.publicKey)) as JsonWebKey;
  const priv = (await crypto.subtle.exportKey('jwk', pair.privateKey)) as JsonWebKey;
  return {
    key: { privateKey: pair.privateKey, publicJwk: { kty: pub.kty!, crv: pub.crv!, x: pub.x!, y: pub.y! } },
    privateJwk: priv,
  };
}

async function importDpopKey(privateJwk: JsonWebKey): Promise<DpopKey> {
  const privateKey = await crypto.subtle.importKey(
    'jwk',
    privateJwk,
    { name: 'ECDSA', namedCurve: 'P-256' },
    false,
    ['sign'],
  );
  return { privateKey, publicJwk: { kty: privateJwk.kty!, crv: privateJwk.crv!, x: privateJwk.x!, y: privateJwk.y! } };
}

async function dpopProof(key: DpopKey, htm: string, htu: string, nonce?: string): Promise<string> {
  const header = { typ: 'dpop+jwt', alg: 'ES256', jwk: key.publicJwk };
  const payload: Record<string, unknown> = {
    jti: randomB64(12),
    htm,
    htu: htu.split('?')[0].split('#')[0],
    iat: Math.floor(Date.now() / 1000),
  };
  if (nonce) payload.nonce = nonce;
  const input = `${b64url(te.encode(JSON.stringify(header)))}.${b64url(te.encode(JSON.stringify(payload)))}`;
  // WebCrypto ECDSA emits raw r||s (64 bytes) — exactly the JWS ES256 format
  const sig = await crypto.subtle.sign({ name: 'ECDSA', hash: 'SHA-256' }, key.privateKey, te.encode(input));
  return `${input}.${b64url(sig)}`;
}

/** POST a form with a DPoP proof, honoring the server's use_dpop_nonce dance. */
async function dpopFetch(url: string, form: URLSearchParams, key: DpopKey): Promise<Response> {
  let nonce: string | undefined;
  for (let attempt = 0; attempt < 2; attempt++) {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
        DPoP: await dpopProof(key, 'POST', url, nonce),
      },
      body: form.toString(),
    });
    if (res.ok) return res;
    const newNonce = res.headers.get('DPoP-Nonce');
    if (newNonce && attempt === 0) {
      const body = (await res
        .clone()
        .json()
        .catch(() => ({}))) as { error?: string };
      if (body.error === 'use_dpop_nonce') {
        nonce = newNonce;
        continue;
      }
    }
    return res;
  }
  throw new Error('unreachable');
}

// ---------- encrypted state cookie ----------

interface FlowState {
  state: string;
  verifier: string;
  issuer: string;
  tokenEndpoint: string;
  /** DID we *expect* (from the typed handle) — advisory; `sub` is authoritative */
  hintDid: string;
  dpopJwk: JsonWebKey;
  exp: number;
}

const COOKIE = 'bolo_oauth';

async function cookieCryptoKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(`${secret}|oauth-state-v1`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealState(secret: string, flow: FlowState): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await cookieCryptoKey(secret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(JSON.stringify(flow)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64url(out);
}

async function openState(secret: string, sealed: string): Promise<FlowState | null> {
  try {
    const buf = b64urlDecode(sealed);
    const key = await cookieCryptoKey(secret);
    const pt = await crypto.subtle.decrypt(
      { name: 'AES-GCM', iv: buf.slice(0, 12) as BufferSource },
      key,
      buf.slice(12) as BufferSource,
    );
    const flow = JSON.parse(new TextDecoder().decode(pt)) as FlowState;
    if (flow.exp < Date.now()) return null;
    return flow;
  } catch {
    return null;
  }
}

function readCookie(request: Request, name: string): string | null {
  const header = request.headers.get('Cookie') ?? '';
  for (const part of header.split(/;\s*/)) {
    const eq = part.indexOf('=');
    if (eq > 0 && part.slice(0, eq) === name) return part.slice(eq + 1);
  }
  return null;
}

// ---------- handlers ----------

function loginErrorRedirect(origin: string, message: string): Response {
  return Response.redirect(`${origin}/#login_error=${encodeURIComponent(message)}`, 302);
}

export async function handleOauthLogin(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const input = (url.searchParams.get('handle') ?? '').trim().replace(/^@/, '');
  if (!input) return loginErrorRedirect(origin, 'handle required');

  // resolve handle (or raw DID) -> DID -> PDS -> authorization server
  const did = input.startsWith('did:') ? input : await resolveHandle(input);
  if (!did) return loginErrorRedirect(origin, `could not resolve ${input}`);
  const doc = await resolveDidDoc(did);
  const pds = doc ? pdsFromDidDoc(doc) : null;
  if (!pds) return loginErrorRedirect(origin, 'could not locate PDS for that account');
  const issuer = await authServerForPds(pds);
  if (!issuer) return loginErrorRedirect(origin, 'PDS does not advertise an OAuth authorization server');
  const as = await authServerMetadata(issuer);
  if (!as) return loginErrorRedirect(origin, 'failed to load authorization server metadata');

  const { clientId, redirectUri } = clientIdsFor(origin);
  const state = randomB64(24);
  const verifier = randomB64(48);
  const challenge = b64url(await crypto.subtle.digest('SHA-256', te.encode(verifier)));
  const { key, privateJwk } = await generateDpopKey();

  // pushed authorization request
  const par = await dpopFetch(
    as.pushed_authorization_request_endpoint,
    new URLSearchParams({
      client_id: clientId,
      redirect_uri: redirectUri,
      response_type: 'code',
      scope: 'atproto',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
      login_hint: input.startsWith('did:') ? did : input,
    }),
    key,
  );
  if (!par.ok) {
    const detail = await par.text().catch(() => '');
    return loginErrorRedirect(origin, `authorization request rejected (${par.status}) ${detail.slice(0, 200)}`);
  }
  const { request_uri: requestUri } = (await par.json()) as { request_uri: string };

  const sealed = await sealState(sessionSecret(env), {
    state,
    verifier,
    issuer,
    tokenEndpoint: as.token_endpoint,
    hintDid: did,
    dpopJwk: privateJwk,
    exp: Date.now() + 10 * 60 * 1000,
  });

  const authorize = new URL(as.authorization_endpoint);
  authorize.searchParams.set('client_id', clientId);
  authorize.searchParams.set('request_uri', requestUri);

  const secure = origin.startsWith('https') ? '; Secure' : '';
  return new Response(null, {
    status: 302,
    headers: {
      Location: authorize.toString(),
      'Set-Cookie': `${COOKIE}=${sealed}; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=600${secure}`,
    },
  });
}

export async function handleOauthCallback(request: Request, env: Env): Promise<Response> {
  const url = new URL(request.url);
  const origin = url.origin;
  const clearCookie = `${COOKIE}=; HttpOnly; SameSite=Lax; Path=/oauth; Max-Age=0`;
  const fail = (msg: string) => {
    const res = loginErrorRedirect(origin, msg);
    const headers = new Headers(res.headers);
    headers.append('Set-Cookie', clearCookie);
    return new Response(null, { status: 302, headers });
  };

  const err = url.searchParams.get('error');
  if (err) return fail(url.searchParams.get('error_description') ?? err);

  const sealed = readCookie(request, COOKIE);
  const flow = sealed ? await openState(sessionSecret(env), sealed) : null;
  if (!flow) return fail('login session expired — try again');

  const state = url.searchParams.get('state');
  const code = url.searchParams.get('code');
  const iss = url.searchParams.get('iss');
  if (!code || state !== flow.state) return fail('state mismatch');
  if (iss && iss !== flow.issuer) return fail('issuer mismatch');

  // token exchange with the same per-flow DPoP key
  const { clientId, redirectUri } = clientIdsFor(origin);
  const key = await importDpopKey(flow.dpopJwk);
  const tokenRes = await dpopFetch(
    flow.tokenEndpoint,
    new URLSearchParams({
      grant_type: 'authorization_code',
      code,
      redirect_uri: redirectUri,
      client_id: clientId,
      code_verifier: flow.verifier,
    }),
    key,
  );
  if (!tokenRes.ok) {
    const detail = await tokenRes.text().catch(() => '');
    return fail(`token exchange failed (${tokenRes.status}) ${detail.slice(0, 200)}`);
  }
  const token = (await tokenRes.json()) as { sub?: string; scope?: string };
  const did = token.sub;
  if (!did || !did.startsWith('did:')) return fail('no subject in token response');
  if (token.scope && !token.scope.split(' ').includes('atproto')) return fail('atproto scope not granted');

  // CRITICAL: bind the authenticated DID to the issuer that vouched for it.
  // Anyone can run an authorization server; only the one the DID's own PDS
  // points at may authenticate that DID.
  const doc = await resolveDidDoc(did);
  const pds = doc ? pdsFromDidDoc(doc) : null;
  const didIssuer = pds ? await authServerForPds(pds) : null;
  if (!doc || didIssuer !== flow.issuer) return fail('identity verification failed (issuer/DID mismatch)');

  const handle = handleFromDidDoc(doc) ?? did;
  const session = await mintToken(sessionSecret(env), did, handle);

  const frag = new URLSearchParams({ token: session, did, handle });
  return new Response(null, {
    status: 302,
    headers: {
      Location: `${origin}/#${frag}`,
      'Set-Cookie': clearCookie,
    },
  });
}
