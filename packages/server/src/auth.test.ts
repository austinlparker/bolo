import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  mintToken,
  verifyToken,
  resolveHandle,
  resolveDidDoc,
  pdsFromDidDoc,
  verifyAtprotoSession,
} from './auth';

const SECRET = 'test-secret-key-12345';
const DID = 'did:plc:abcdef123456';
const HANDLE = 'test.bsky.social';

describe('auth: mintToken / verifyToken', () => {
  it('round-trip: mint with S, verify with S → payload matches', async () => {
    const token = await mintToken(SECRET, DID, HANDLE);
    const payload = await verifyToken(SECRET, token);
    expect(payload).not.toBeNull();
    expect(payload!.did).toBe(DID);
    expect(payload!.handle).toBe(HANDLE);
    expect(payload!.exp).toBeGreaterThan(Date.now() / 1000);
  });

  it('verify with different secret → null', async () => {
    const token = await mintToken(SECRET, DID, HANDLE);
    const payload = await verifyToken('wrong-secret', token);
    expect(payload).toBeNull();
  });

  it('expired token → null', async () => {
    // Mint a token then tamper with the exp to make it expired
    const token = await mintToken(SECRET, DID, HANDLE);
    // Decode body, change exp to past, re-encode without re-signing (will fail sig check)
    // Actually easier: manually construct an expired token
    const body = JSON.stringify({ did: DID, handle: HANDLE, exp: 1 }); // epoch sec 1 = 1970
    const bodyB64 = btoa(body).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const sig = await crypto.subtle.sign(
      'HMAC',
      await crypto.subtle.importKey('raw', new TextEncoder().encode(SECRET), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']),
      new TextEncoder().encode(body),
    );
    const sigB64 = btoa(String.fromCharCode(...new Uint8Array(sig)))
      .replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
    const expiredToken = `${bodyB64}.${sigB64}`;
    const payload = await verifyToken(SECRET, expiredToken);
    expect(payload).toBeNull();
  });

  it('tampered body → null (signature mismatch)', async () => {
    const token = await mintToken(SECRET, DID, HANDLE);
    const dot = token.indexOf('.');
    const bodyB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    // Flip a character in the body
    const tamperedBody = bodyB64.slice(0, -1) + (bodyB64.slice(-1) === 'A' ? 'B' : 'A');
    const tamperedToken = `${tamperedBody}.${sigB64}`;
    const payload = await verifyToken(SECRET, tamperedToken);
    expect(payload).toBeNull();
  });

  it('tampered signature → null', async () => {
    const token = await mintToken(SECRET, DID, HANDLE);
    const dot = token.indexOf('.');
    const bodyB64 = token.slice(0, dot);
    const sigB64 = token.slice(dot + 1);
    // Flip the FIRST character of the signature — unlike the last char (which
    // only carries 4 significant bits in a 43-char SHA-256 base64url encoding,
    // making A↔B flips a no-op ~6% of the time), the first char always has
    // full 6-bit precision so the tamper reliably changes the decoded bytes.
    const tamperedFirst = sigB64.charAt(0) === 'A' ? 'B' : 'A';
    const tamperedSig = tamperedFirst + sigB64.slice(1);
    const tamperedToken = `${bodyB64}.${tamperedSig}`;
    const payload = await verifyToken(SECRET, tamperedToken);
    expect(payload).toBeNull();
  });

  it('malformed tokens → null, no throw', async () => {
    // No dot
    await expect(verifyToken(SECRET, 'nodothere')).resolves.toBeNull();
    // Empty string
    await expect(verifyToken(SECRET, '')).resolves.toBeNull();
    // Bad base64
    await expect(verifyToken(SECRET, '!!!.!!!')).resolves.toBeNull();
    // Just a dot
    await expect(verifyToken(SECRET, '.')).resolves.toBeNull();
  });
});

describe('auth: resolveHandle', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null for invalid handles', async () => {
    expect(await resolveHandle('')).toBeNull();
    expect(await resolveHandle('@')).toBeNull();
    // No dot
    expect(await resolveHandle('nosuchname')).toBeNull();
  });

  it('prefers DNS over well-known', async () => {
    const dnsDid = 'did:plc:dnswins';
    const wkDid = 'did:plc:wkanswer';
    const fetchMock = vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('cloudflare-dns.com')) {
        return new Response(
          JSON.stringify({ Answer: [{ type: 16, data: `"did=${dnsDid}"` }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('.well-known/atproto-did')) {
        return new Response(wkDid, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    const result = await resolveHandle('test.bsky.social');
    expect(result).toBe(dnsDid);
  });

  it('falls back to well-known when DNS fails', async () => {
    const wkDid = 'did:web:example.com';
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('cloudflare-dns.com')) {
        return new Response(JSON.stringify({ Answer: [] }), { status: 200, headers: { 'content-type': 'application/json' } });
      }
      if (u.includes('.well-known/atproto-did')) {
        return new Response(wkDid, { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    const result = await resolveHandle('example.com');
    expect(result).toBe(wkDid);
  });

  it('filters non-atproto DIDs', async () => {
    // DNS returns a non-matching DID format
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('cloudflare-dns.com')) {
        return new Response(
          JSON.stringify({ Answer: [{ type: 16, data: '"did:other:badformat"' }] }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('.well-known/atproto-did')) {
        return new Response('did:other:badformat', { status: 200 });
      }
      return new Response('', { status: 404 });
    });
    const result = await resolveHandle('bad.example.com');
    expect(result).toBeNull();
  });
});

describe('auth: verifyAtprotoSession', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('returns null when session.did !== did', async () => {
    // Mock resolveDidDoc to return a PDS, then mock getSession with different DID
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('plc.directory') || u.includes('.well-known/did.json')) {
        return new Response(
          JSON.stringify({
            alsoKnownAs: ['at://test.bsky.social'],
            service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('com.atproto.server.getSession')) {
        return new Response(
          JSON.stringify({ did: 'did:plc:different', handle: 'other.bsky.social' }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 404 });
    });
    const result = await verifyAtprotoSession(DID, 'some-jwt');
    expect(result).toBeNull();
  });

  it('returns null when PDS returns non-ok', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('plc.directory') || u.includes('.well-known/did.json')) {
        return new Response(
          JSON.stringify({
            alsoKnownAs: ['at://test.bsky.social'],
            service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('com.atproto.server.getSession')) {
        return new Response('', { status: 401 });
      }
      return new Response('', { status: 404 });
    });
    const result = await verifyAtprotoSession(DID, 'bad-jwt');
    expect(result).toBeNull();
  });

  it('returns did+handle when session matches', async () => {
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (url) => {
      const u = String(url);
      if (u.includes('plc.directory') || u.includes('.well-known/did.json')) {
        return new Response(
          JSON.stringify({
            alsoKnownAs: ['at://test.bsky.social'],
            service: [{ id: '#atproto_pds', type: 'AtprotoPersonalDataServer', serviceEndpoint: 'https://pds.example.com' }],
          }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      if (u.includes('com.atproto.server.getSession')) {
        return new Response(
          JSON.stringify({ did: DID, handle: HANDLE }),
          { status: 200, headers: { 'content-type': 'application/json' } },
        );
      }
      return new Response('', { status: 404 });
    });
    const result = await verifyAtprotoSession(DID, 'good-jwt');
    expect(result).not.toBeNull();
    expect(result!.did).toBe(DID);
    expect(result!.handle).toBe(HANDLE);
  });
});
