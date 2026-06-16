export interface Env {
  GAME: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** KV namespace for cached Bluesky social data (profiles, relationships) */
  SOCIAL_CACHE: KVNamespace;
  /** "1" enables /api/login/dev (no atproto verification) for local play */
  DEV_AUTH: string;
  /** HMAC key for session tokens; set via `wrangler secret put SESSION_SECRET` */
  SESSION_SECRET?: string;
  /** Admin key for debug endpoints (/api/regenerate); set via `wrangler secret put ADMIN_SECRET` */
  ADMIN_SECRET?: string;
  /** Honeycomb ingest key for balance telemetry; unset = telemetry disabled */
  HONEYCOMB_API_KEY?: string;
  /** Honeycomb dataset for balance telemetry (default "atbolo-sim") */
  HONEYCOMB_DATASET?: string;
}

export function sessionSecret(env: Env): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.DEV_AUTH === '1') return 'dev-secret-do-not-use-in-production';
  throw new Error('SESSION_SECRET is not configured');
}
