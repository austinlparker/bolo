import { describe, it, expect, vi, afterEach } from 'vitest';
import { handleOauthCallback, handleOauthLogin } from './oauth';
import type { Env } from './env';

// --- Helpers for constructing a sealed state cookie ---
// We replicate the sealState logic (AES-GCM) to produce valid cookies for
// the callback tests, since sealState/openState are module-private.

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

async function cookieCryptoKey(secret: string): Promise<CryptoKey> {
  const digest = await crypto.subtle.digest('SHA-256', te.encode(`${secret}|oauth-state-v1`));
  return crypto.subtle.importKey('raw', digest, 'AES-GCM', false, ['encrypt', 'decrypt']);
}

async function sealState(secret: string, flow: Record<string, unknown>): Promise<string> {
  const iv = new Uint8Array(12);
  crypto.getRandomValues(iv);
  const key = await cookieCryptoKey(secret);
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv: iv as BufferSource }, key, te.encode(JSON.stringify(flow)));
  const out = new Uint8Array(12 + ct.byteLength);
  out.set(iv, 0);
  out.set(new Uint8Array(ct), 12);
  return b64url(out);
}

function makeEnv(secret = 'test-secret'): Env {
  return { SESSION_SECRET: secret } as unknown as Env;
}

const FLOW = {
  state: 'test-state-123',
  verifier: 'test-verifier-456',
  issuer: 'https://auth.example.com',
  tokenEndpoint: 'https://auth.example.com/token',
  hintDid: 'did:plc:test123',
  dpopJwk: { kty: 'EC', crv: 'P-256', x: 'fake-x', y: 'fake-y', d: 'fake-d', ext: true, key_ops: ['sign'] },
  exp: Date.now() + 10 * 60 * 1000, // 10 min in future
};

describe('oauth: handleOauthCallback guards', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('state mismatch → fail redirect with login_error', async () => {
    const secret = 'test-secret';
    const env = makeEnv(secret);
    const sealed = await sealState(secret, FLOW);
    // Send wrong state
    const url = 'https://app.example.com/oauth/callback?state=wrong-state&code=abc&iss=' + FLOW.issuer;
    const request = new Request(url, {
      headers: { Cookie: `bolo_oauth=${sealed}` },
    });
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('login_error=');
  });

  it('missing code → fail redirect with login_error', async () => {
    const secret = 'test-secret';
    const env = makeEnv(secret);
    const sealed = await sealState(secret, FLOW);
    const url = `https://app.example.com/oauth/callback?state=${FLOW.state}&iss=${FLOW.issuer}`;
    const request = new Request(url, {
      headers: { Cookie: `bolo_oauth=${sealed}` },
    });
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('login_error=');
  });

  it('issuer mismatch → fail redirect with login_error', async () => {
    const secret = 'test-secret';
    const env = makeEnv(secret);
    const sealed = await sealState(secret, FLOW);
    const url = `https://app.example.com/oauth/callback?state=${FLOW.state}&code=abc&iss=https://wrong-issuer.com`;
    const request = new Request(url, {
      headers: { Cookie: `bolo_oauth=${sealed}` },
    });
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('login_error=');
  });

  it('expired/invalid cookie → fail redirect with login_error', async () => {
    const env = makeEnv('test-secret');
    // Send garbage cookie
    const url = `https://app.example.com/oauth/callback?state=${FLOW.state}&code=abc`;
    const request = new Request(url, {
      headers: { Cookie: 'bolo_oauth=garbagevalue' },
    });
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('login_error=');
  });

  it('expired flow (exp in past) → fail redirect', async () => {
    const secret = 'test-secret';
    const env = makeEnv(secret);
    const expiredFlow = { ...FLOW, exp: Date.now() - 1000 }; // 1 sec ago
    const sealed = await sealState(secret, expiredFlow);
    const url = `https://app.example.com/oauth/callback?state=${FLOW.state}&code=abc`;
    const request = new Request(url, {
      headers: { Cookie: `bolo_oauth=${sealed}` },
    });
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('login_error=');
  });

  it('wrong secret → cookie fails to decrypt → login_error', async () => {
    // Seal with one secret, but env uses a different one
    const sealed = await sealState('secret-A', FLOW);
    const env = makeEnv('secret-B');
    const url = `https://app.example.com/oauth/callback?state=${FLOW.state}&code=abc`;
    const request = new Request(url, {
      headers: { Cookie: `bolo_oauth=${sealed}` },
    });
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    expect(res.headers.get('Location') ?? '').toContain('login_error=');
  });

  it('error parameter in callback → fail redirect', async () => {
    const env = makeEnv('test-secret');
    const url = 'https://app.example.com/oauth/callback?error=access_denied&error_description=user+cancelled';
    const request = new Request(url);
    const res = await handleOauthCallback(request, env);
    expect(res.status).toBe(302);
    const location = res.headers.get('Location') ?? '';
    expect(location).toContain('login_error=');
    expect(location).toContain('user');
  });
});
