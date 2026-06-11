/**
 * atproto OAuth login. Clicking "sign in" navigates to /oauth/login, which
 * runs the full PAR/PKCE/DPoP dance server-side and bounces back to
 * /#token=...  (picked up in main.ts). No passwords, ever.
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

export function saveCredentials(creds: Credentials): void {
  localStorage.setItem('bolo_session', JSON.stringify(creds));
}

export function clearCredentials(): void {
  localStorage.removeItem('bolo_session');
}

/** Pull credentials out of the OAuth callback fragment, if present. */
export function credentialsFromFragment(): { creds?: Credentials; error?: string } {
  if (!location.hash.startsWith('#')) return {};
  const params = new URLSearchParams(location.hash.slice(1));
  const error = params.get('login_error');
  if (error) {
    history.replaceState(null, '', location.pathname);
    return { error };
  }
  const token = params.get('token');
  const did = params.get('did');
  const handle = params.get('handle');
  if (token && did && handle) {
    history.replaceState(null, '', location.pathname);
    const creds = { token, did, handle };
    saveCredentials(creds);
    return { creds };
  }
  return {};
}

export function showLogin(root: HTMLElement, initialError?: string): Promise<Credentials> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    overlay.innerHTML = `
      <div class="login-box">
        <h1>BOLO</h1>
        <div class="sub">the forever war · <span class="vs-dawn">DAWN</span> vs <span class="vs-dusk">DUSK</span></div>
        <label>bluesky / atproto handle</label>
        <input id="login-handle" placeholder="you.bsky.social" autocomplete="username" />
        <div class="hint">you'll be sent to your own PDS to sign in (OAuth) —
        this site never sees a password.</div>
        <button id="login-go">ENLIST WITH BLUESKY</button>
        <button id="login-dev" class="secondary">dev login (local only)</button>
        <div class="error" id="login-err"></div>
        <div class="links"><a href="/map">→ watch the war map without enlisting</a></div>
      </div>
    `;
    root.appendChild(overlay);

    const handleEl = overlay.querySelector<HTMLInputElement>('#login-handle')!;
    const errEl = overlay.querySelector<HTMLElement>('#login-err')!;
    if (initialError) errEl.textContent = initialError;

    const finish = (creds: Credentials) => {
      saveCredentials(creds);
      overlay.remove();
      resolve(creds);
    };

    const go = () => {
      const handle = handleEl.value.trim().replace(/^@/, '');
      if (!handle) {
        errEl.textContent = 'handle required';
        return;
      }
      location.href = `/oauth/login?handle=${encodeURIComponent(handle)}`;
    };
    overlay.querySelector<HTMLButtonElement>('#login-go')!.onclick = go;
    handleEl.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') go();
    });

    overlay.querySelector<HTMLButtonElement>('#login-dev')!.onclick = async () => {
      errEl.textContent = '';
      const handle = handleEl.value.trim() || `guest-${Math.floor(Math.random() * 9999)}`;
      try {
        const res = await fetch('/api/login/dev', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ handle }),
        });
        const data = (await res.json()) as { token?: string; did?: string; handle?: string; error?: string };
        if (!data.token) throw new Error(data.error ?? 'dev login disabled');
        finish({ token: data.token, did: data.did!, handle: data.handle! });
      } catch (err) {
        errEl.textContent = err instanceof Error ? err.message : String(err);
      }
    };
  });
}
