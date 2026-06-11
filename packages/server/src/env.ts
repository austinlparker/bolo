export interface Env {
  GAME: DurableObjectNamespace;
  ASSETS: Fetcher;
  /** "1" enables /api/login/dev (no atproto verification) for local play */
  DEV_AUTH: string;
  /** HMAC key for session tokens; set via `wrangler secret put SESSION_SECRET` */
  SESSION_SECRET?: string;
}

export function sessionSecret(env: Env): string {
  if (env.SESSION_SECRET) return env.SESSION_SECRET;
  if (env.DEV_AUTH === '1') return 'dev-secret-do-not-use-in-production';
  throw new Error('SESSION_SECRET is not configured');
}
