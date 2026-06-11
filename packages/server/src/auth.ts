/**
 * atproto-backed identity.
 *
 * Login flow (works identically for humans and external bots):
 *   1. POST /api/login/start { handle }            -> { did, pds }
 *   2. The CLIENT calls {pds}/xrpc/com.atproto.server.createSession itself
 *      with an app password, so credentials never touch this server.
 *   3. POST /api/login/verify { did, accessJwt }   -> we resolve the DID's PDS,
 *      call getSession with the bearer token, and confirm the DID matches.
 *      On success we mint our own HMAC-signed session token.
 *
 * (OAuth via @atproto/oauth-client is the planned upgrade; the session-token
 * layer here is what it would plug into.)
 */

export interface SessionPayload {
  did: string;
  handle: string;
  exp: number; // epoch seconds
}

const TOKEN_TTL_SECONDS = 60 * 60 * 24 * 30;

function b64url(bytes: Uint8Array): string {
  let bin = '';
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64urlDecode(s: string): Uint8Array {
  const b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  const bin = atob(b64 + '='.repeat((4 - (b64.length % 4)) % 4));
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(secret: string): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign', 'verify'],
  );
}

export async function mintToken(secret: string, did: string, handle: string): Promise<string> {
  const payload: SessionPayload = {
    did,
    handle,
    exp: Math.floor(Date.now() / 1000) + TOKEN_TTL_SECONDS,
  };
  const body = new TextEncoder().encode(JSON.stringify(payload));
  const sig = await crypto.subtle.sign('HMAC', await hmacKey(secret), body);
  return `${b64url(body)}.${b64url(new Uint8Array(sig))}`;
}

export async function verifyToken(secret: string, token: string): Promise<SessionPayload | null> {
  const dot = token.indexOf('.');
  if (dot < 0) return null;
  try {
    const body = b64urlDecode(token.slice(0, dot));
    const sig = b64urlDecode(token.slice(dot + 1));
    const ok = await crypto.subtle.verify('HMAC', await hmacKey(secret), sig as BufferSource, body as BufferSource);
    if (!ok) return null;
    const payload = JSON.parse(new TextDecoder().decode(body)) as SessionPayload;
    if (payload.exp < Date.now() / 1000) return null;
    if (typeof payload.did !== 'string' || typeof payload.handle !== 'string') return null;
    return payload;
  } catch {
    return null;
  }
}

// ---------- atproto resolution ----------

/** atproto only resolves DIDs of these two methods (see resolveDidDoc). */
const ATPROTO_DID = /^did:(plc|web):/;

/**
 * Resolve a handle to a DID using the two canonical atproto methods, so login
 * works for any PDS — not just accounts the bsky appview happens to index:
 *   1. DNS TXT  _atproto.<handle>  ->  "did=<did>"  (authoritative; preferred)
 *   2. HTTPS    https://<handle>/.well-known/atproto-did  ->  <did> (text/plain)
 * Per the spec we try both and prefer the DNS answer on conflict. The bsky
 * appview is kept only as a last-ditch fallback for odd network conditions.
 */
export async function resolveHandle(handle: string): Promise<string | null> {
  const h = handle.trim().replace(/^@/, '').toLowerCase();
  if (!h || /[^a-z0-9.-]/.test(h) || !h.includes('.')) return null;
  const [dns, wellKnown] = await Promise.all([resolveHandleDns(h), resolveHandleWellKnown(h)]);
  return dns ?? wellKnown ?? (await resolveHandleAppview(h));
}

/** DNS-over-HTTPS TXT lookup for _atproto.<handle> (Workers can't do raw DNS). */
async function resolveHandleDns(handle: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://cloudflare-dns.com/dns-query?name=${encodeURIComponent(`_atproto.${handle}`)}&type=TXT`,
      { headers: { accept: 'application/dns-json' } },
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { Answer?: { type: number; data: string }[] };
    for (const ans of data.Answer ?? []) {
      if (ans.type !== 16) continue; // 16 = TXT
      // DoH wraps TXT strings in quotes (and may split long records into chunks).
      const txt = ans.data.replace(/"/g, '').trim();
      if (txt.startsWith('did=')) {
        const did = txt.slice(4).trim();
        if (ATPROTO_DID.test(did)) return did;
      }
    }
    return null;
  } catch {
    return null;
  }
}

async function resolveHandleWellKnown(handle: string): Promise<string | null> {
  try {
    const res = await fetch(`https://${handle}/.well-known/atproto-did`, { headers: { accept: 'text/plain' } });
    if (!res.ok) return null;
    const did = (await res.text()).trim();
    return ATPROTO_DID.test(did) ? did : null;
  } catch {
    return null;
  }
}

async function resolveHandleAppview(handle: string): Promise<string | null> {
  try {
    const res = await fetch(
      `https://public.api.bsky.app/xrpc/com.atproto.identity.resolveHandle?handle=${encodeURIComponent(handle)}`,
    );
    if (!res.ok) return null;
    const data = (await res.json()) as { did?: string };
    return data.did && ATPROTO_DID.test(data.did) ? data.did : null;
  } catch {
    return null;
  }
}

interface DidDoc {
  alsoKnownAs?: string[];
  service?: { id: string; type: string; serviceEndpoint: string }[];
}

export async function resolveDidDoc(did: string): Promise<DidDoc | null> {
  let url: string;
  if (did.startsWith('did:plc:')) {
    url = `https://plc.directory/${encodeURIComponent(did)}`;
  } else if (did.startsWith('did:web:')) {
    const host = did.slice('did:web:'.length).split(':').map(decodeURIComponent).join('/');
    url = `https://${host}/.well-known/did.json`;
  } else {
    return null;
  }
  const res = await fetch(url);
  if (!res.ok) return null;
  return (await res.json()) as DidDoc;
}

export function pdsFromDidDoc(doc: DidDoc): string | null {
  const svc = doc.service?.find(
    (s) => s.id === '#atproto_pds' || s.id.endsWith('#atproto_pds') || s.type === 'AtprotoPersonalDataServer',
  );
  return svc?.serviceEndpoint ?? null;
}

export function handleFromDidDoc(doc: DidDoc): string | null {
  const aka = doc.alsoKnownAs?.find((a) => a.startsWith('at://'));
  return aka ? aka.slice('at://'.length) : null;
}

/** Confirm that accessJwt is a live session on the DID's own PDS. */
export async function verifyAtprotoSession(
  did: string,
  accessJwt: string,
): Promise<{ did: string; handle: string } | null> {
  const doc = await resolveDidDoc(did);
  if (!doc) return null;
  const pds = pdsFromDidDoc(doc);
  if (!pds) return null;
  const res = await fetch(`${pds.replace(/\/$/, '')}/xrpc/com.atproto.server.getSession`, {
    headers: { Authorization: `Bearer ${accessJwt}` },
  });
  if (!res.ok) return null;
  const session = (await res.json()) as { did?: string; handle?: string };
  if (session.did !== did) return null;
  return { did, handle: session.handle ?? handleFromDidDoc(doc) ?? did };
}
