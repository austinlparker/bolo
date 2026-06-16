import { describe, it, expect } from 'vitest';
import type { Env } from './env';

/**
 * Tests for the Worker fetch handler (packages/server/src/index.ts).
 *
 * These exercise the auth and validation gates that run *before* any
 * Durable Object or KV work, so a minimal mock Env suffices.
 */
const handler = (await import('./index')).default;

/** Build a mock Env that explodes if any binding is actually used. */
function mockEnv(overrides: Partial<Env> = {}): Env {
  return {
    GAME: new Proxy({}, {
      get() { throw new Error('GAME binding should not be accessed in this test'); },
    }) as unknown as Env['GAME'],
    ASSETS: {
      fetch() { throw new Error('ASSETS should not be accessed in this test'); },
    } as unknown as Env['ASSETS'],
    SOCIAL_CACHE: {
      get() { throw new Error('SOCIAL_CACHE should not be accessed in this test'); },
    } as unknown as Env['SOCIAL_CACHE'],
    ADMIN_SECRET: undefined,
    ...overrides,
  } as unknown as Env;
}

describe('GET /api/regenerate auth', () => {
  it('returns 403 when ADMIN_SECRET is unset, even with "Bearer undefined"', async () => {
    // Regression: when ADMIN_SECRET is undefined, `Bearer ${undefined}` becomes
    // the literal string "Bearer undefined", which used to match the check
    // `auth !== `Bearer ${env.ADMIN_SECRET}``. The endpoint must fail closed.
    const env = mockEnv({ ADMIN_SECRET: undefined });
    const req = new Request('https://bolo.test/api/regenerate', {
      headers: { Authorization: 'Bearer undefined' },
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(403);
    const body = await res.json();
    expect(body).toHaveProperty('error');
  });

  it('returns 403 when ADMIN_SECRET is set but the header does not match', async () => {
    const env = mockEnv({ ADMIN_SECRET: 'real-secret' });
    const req = new Request('https://bolo.test/api/regenerate', {
      headers: { Authorization: 'Bearer wrong-secret' },
    });
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it('returns 403 with no Authorization header', async () => {
    const env = mockEnv({ ADMIN_SECRET: 'real-secret' });
    const req = new Request('https://bolo.test/api/regenerate');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(403);
  });

  it('rejects the query-string ?token= path even with the correct secret', async () => {
    // The query-token fallback was removed as part of the security hardening.
    const env = mockEnv({ ADMIN_SECRET: 'real-secret' });
    const req = new Request('https://bolo.test/api/regenerate?token=real-secret');
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(403);
  });
});

describe('GET /api/profiles cap', () => {
  it('returns 400 when more than 50 DIDs are requested', async () => {
    const dids = Array.from({ length: 51 }, (_, i) => `did:plc:${i.toString().padStart(4, '0')}`);
    const url = `https://bolo.test/api/profiles?${dids.map((d) => `dids=${d}`).join('&')}`;
    const env = mockEnv();
    const req = new Request(url);
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string };
    expect(body.error).toMatch(/max 50/i);
  });

  it('accepts exactly 50 unique DIDs (does not hit the cap)', async () => {
    // 50 DIDs should pass the cap check. fetchProfiles will be called but
    // all are did:plc:* — we need a KV mock that returns cache misses and
    // the AppView fetch will fail harmlessly (fault-tolerant).
    const dids = Array.from({ length: 50 }, (_, i) => `did:plc:${i.toString().padStart(4, '0')}`);
    const url = `https://bolo.test/api/profiles?${dids.map((d) => `dids=${d}`).join('&')}`;
    const env = mockEnv({
      SOCIAL_CACHE: {
        get: async () => null, // always cache miss
        put: async () => {},
      } as unknown as Env['SOCIAL_CACHE'],
    });
    const req = new Request(url);
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(200);
    const body = await res.json();
    expect(body).toHaveProperty('profiles');
  });

  it('deduplicates repeated DIDs before counting against the cap', async () => {
    // 60 entries but only 5 unique DIDs — should pass (5 ≤ 50)
    const unique = ['did:plc:a', 'did:plc:b', 'did:plc:c', 'did:plc:d', 'did:plc:e'];
    const dids: string[] = [];
    for (let i = 0; i < 60; i++) dids.push(unique[i % unique.length]);
    const url = `https://bolo.test/api/profiles?${dids.map((d) => `dids=${d}`).join('&')}`;
    const env = mockEnv({
      SOCIAL_CACHE: {
        get: async () => null,
        put: async () => {},
      } as unknown as Env['SOCIAL_CACHE'],
    });
    const req = new Request(url);
    const res = await handler.fetch(req, env);
    expect(res.status).toBe(200);
  });
});
