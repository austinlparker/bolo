/**
 * atproto login overlay. The app password is sent ONLY to the user's own
 * PDS (createSession); this server just verifies the resulting access JWT.
 */

export interface Credentials {
  token: string;
  did: string;
  handle: string;
}

export function savedCredentials(): Credentials | null {
  try {
    const raw = localStorage.getItem('bolo_session');
    return raw ? (JSON.parse(raw) as Credentials) : null;
  } catch {
    return null;
  }
}

export function clearCredentials(): void {
  localStorage.removeItem('bolo_session');
}

export function showLogin(root: HTMLElement): Promise<Credentials> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="login-box">
        <h1>BOLO</h1>
        <div class="sub">the forever war · dawn vs dusk</div>
        <label>bluesky / atproto handle</label>
        <input id="login-handle" placeholder="you.bsky.social" autocomplete="username" />
        <label>app password</label>
        <input id="login-pass" type="password" placeholder="xxxx-xxxx-xxxx-xxxx" autocomplete="current-password" />
        <div class="hint">create one at Settings → Privacy &amp; Security → App Passwords.
        it is sent only to your own PDS, never to this server.</div>
        <button id="login-go">ENLIST</button>
        <button id="login-dev" class="secondary">dev login (local only)</button>
        <div class="error" id="login-err"></div>
        <div class="links"><a href="/map">→ watch the war map without enlisting</a></div>
      </div>
    `;
    root.appendChild(overlay);

    const handleEl = overlay.querySelector<HTMLInputElement>('#login-handle')!;
    const passEl = overlay.querySelector<HTMLInputElement>('#login-pass')!;
    const errEl = overlay.querySelector<HTMLElement>('#login-err')!;

    const finish = (creds: Credentials) => {
      localStorage.setItem('bolo_session', JSON.stringify(creds));
      overlay.remove();
      resolve(creds);
    };

    overlay.querySelector<HTMLButtonElement>('#login-go')!.onclick = async () => {
      errEl.textContent = '';
      const handle = handleEl.value.trim().replace(/^@/, '');
      const password = passEl.value;
      if (!handle || !password) {
        errEl.textContent = 'handle and app password required';
        return;
      }
      try {
        const start = await postJson<{ did?: string; pds?: string; error?: string }>('/api/login/start', { handle });
        if (!start.did || !start.pds) throw new Error(start.error ?? 'could not resolve handle');

        const sess = await fetch(`${start.pds.replace(/\/$/, '')}/xrpc/com.atproto.server.createSession`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ identifier: handle, password }),
        });
        if (!sess.ok) throw new Error('PDS rejected credentials (use an app password, not your main one)');
        const session = (await sess.json()) as { did: string; accessJwt: string };

        const verify = await postJson<{ token?: string; handle?: string; error?: string }>('/api/login/verify', {
          did: session.did,
          accessJwt: session.accessJwt,
        });
        if (!verify.token) throw new Error(verify.error ?? 'verification failed');
        finish({ token: verify.token, did: session.did, handle: verify.handle ?? handle });
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    };

    overlay.querySelector<HTMLButtonElement>('#login-dev')!.onclick = async () => {
      errEl.textContent = '';
      const handle = handleEl.value.trim() || `guest-${Math.floor(Math.random() * 9999)}`;
      try {
        const res = await postJson<{ token?: string; did?: string; handle?: string; error?: string }>(
          '/api/login/dev',
          { handle },
        );
        if (!res.token) throw new Error(res.error ?? 'dev login disabled');
        finish({ token: res.token, did: res.did!, handle: res.handle! });
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    };
  });
}

async function postJson<T>(url: string, body: unknown): Promise<T> {
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  return (await res.json()) as T;
}
