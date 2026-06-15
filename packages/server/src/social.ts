/**
 * Social data fetcher / cache layer.
 *
 * All Bluesky social data (profiles, follow graph relationships) is public
 * and fetched from the unauthenticated AppView at public.api.bsky.app.
 * Results are cached in the SOCIAL_CACHE KV namespace to avoid rate limits
 * and keep latency low on reconnects.
 *
 * Every fetch is fault-tolerant: if the AppView is unreachable, callers get
 * an empty map and the game continues with fallback identity (handle-only).
 */
import type { Env } from './env';

const BSKY_APPVIEW = 'https://public.api.bsky.app/xrpc';

/** A Bluesky actor profile (subset we use). */
export interface BskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  description?: string;
}

/** Follow-graph relationship between two actors. */
export interface Relationship {
  following: boolean;
  followedBy: boolean;
}

/** TTL for cached profiles (1 hour in seconds). */
const PROFILE_TTL = 3600;
/** TTL for cached relationships (30 minutes in seconds). */
const REL_TTL = 1800;

/**
 * Fetch and cache profiles for a batch of DIDs.
 * Dev-mode DIDs (did:dev:*) are skipped — they have no Bluesky profile.
 * Results are cached individually per-DID in KV so partial cache hits work.
 */
export async function fetchProfiles(
  dids: string[],
  env: Env,
): Promise<Map<string, BskyProfile>> {
  const out = new Map<string, BskyProfile>();
  // only real atproto DIDs have profiles
  const real = dids.filter((d) => d.startsWith('did:plc:') || d.startsWith('did:web:'));
  if (real.length === 0) return out;

  // check KV cache first
  const keys = real.map((d) => `profile:${d}`);
  const cached = await env.SOCIAL_CACHE.get(keys[0]); // single-key get for first
  // KV bulk get isn't available in Workers; do parallel individual gets
  const misses: string[] = [];
  await Promise.all(
    real.map(async (did) => {
      try {
        const raw = await env.SOCIAL_CACHE.get(`profile:${did}`);
        if (raw) {
          const parsed = JSON.parse(raw) as BskyProfile;
          out.set(did, parsed);
        } else {
          misses.push(did);
        }
      } catch {
        misses.push(did);
      }
    }),
  );
  if (misses.length === 0) return out;

  // fetch uncached profiles in batches of 25 (AppView limit)
  for (let i = 0; i < misses.length; i += 25) {
    const chunk = misses.slice(i, i + 25);
    const q = chunk.map((d) => `actors=${encodeURIComponent(d)}`).join('&');
    try {
      const res = await fetch(`${BSKY_APPVIEW}/app.bsky.actor.getProfiles?${q}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { profiles?: BskyProfile[] };
      for (const p of data.profiles ?? []) {
        out.set(p.did, p);
        // cache individually with TTL
        void env.SOCIAL_CACHE.put(`profile:${p.did}`, JSON.stringify(p), {
          expirationTtl: PROFILE_TTL,
        });
      }
    } catch {
      // AppView unreachable: fall back to stored handles
    }
  }
  return out;
}

/**
 * Fetch and cache the relationship between a viewer and a batch of other DIDs.
 * One API call replaces N individual lookups. Returns a map of otherDID →
 * {following, followedBy}.
 *
 * Cache key is based on a hash of the sorted other DIDs so the same set of
 * connected players reuses the cache.
 */
export async function fetchRelationships(
  myDid: string,
  otherDids: string[],
  env: Env,
): Promise<Map<string, Relationship>> {
  const out = new Map<string, Relationship>();
  // skip dev DIDs and self
  const real = otherDids.filter((d) => d.startsWith('did:plc:') || d.startsWith('did:web:'));
  if (real.length === 0 || !myDid.startsWith('did:plc:') && !myDid.startsWith('did:web:')) return out;

  const cacheKey = `rel:${myDid}:${hashDids(real)}`;
  try {
    const raw = await env.SOCIAL_CACHE.get(cacheKey);
    if (raw) {
      const parsed = JSON.parse(raw) as Record<string, Relationship>;
      for (const [did, rel] of Object.entries(parsed)) out.set(did, rel);
      return out;
    }
  } catch {
    // cache miss or corrupt
  }

  // fetch from AppView
  try {
    const params = new URLSearchParams();
    params.set('actor', myDid);
    for (const d of real) params.append('others', d);
    const res = await fetch(`${BSKY_APPVIEW}/app.bsky.graph.getRelationships?${params}`);
    if (!res.ok) return out;
    const data = (await res.json()) as {
      relationships?: Array<{
        handle: string;
        did: string;
        following?: boolean;
        followedBy?: boolean;
      }>;
    };
    const cacheObj: Record<string, Relationship> = {};
    for (const r of data.relationships ?? []) {
      const rel: Relationship = {
        following: !!r.following,
        followedBy: !!r.followedBy,
      };
      out.set(r.did, rel);
      cacheObj[r.did] = rel;
    }
    // cache the full result
    void env.SOCIAL_CACHE.put(cacheKey, JSON.stringify(cacheObj), {
      expirationTtl: REL_TTL,
    });
  } catch {
    // AppView unreachable
  }
  return out;
}

/**
 * Compute which of the other DIDs are mutuals (both following and followedBy).
 */
export async function computeMutuals(
  myDid: string,
  otherDids: string[],
  env: Env,
): Promise<Set<string>> {
  const rels = await fetchRelationships(myDid, otherDids, env);
  const mutuals = new Set<string>();
  for (const [did, rel] of rels) {
    if (rel.following && rel.followedBy) mutuals.add(did);
  }
  return mutuals;
}

/** Simple hash of a sorted DID list for cache key generation. */
function hashDids(dids: string[]): string {
  const sorted = [...dids].sort().join(',');
  let hash = 0;
  for (let i = 0; i < sorted.length; i++) {
    hash = ((hash << 5) - hash + sorted.charCodeAt(i)) | 0;
  }
  return Math.abs(hash).toString(36);
}
