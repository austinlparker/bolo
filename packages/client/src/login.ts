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

/** Dev login is only reachable when DEV_AUTH=1, which only happens on a local worker. */
function devAuthAvailable(): boolean {
  return location.hostname === 'localhost' || location.hostname === '127.0.0.1';
}

export function showLogin(root: HTMLElement, initialError?: string): Promise<Credentials> {
  return new Promise((resolve) => {
    const overlay = document.createElement('div');
    overlay.className = 'overlay';
    const devButton = devAuthAvailable()
      ? `<button id="login-dev" class="secondary kbtn">dev login (local only)</button>`
      : '';
    overlay.innerHTML = `
      <div class="login-box kpanel">
        <h1>ATBOLO</h1>
        <div class="sub">the forever war · <span class="vs-dawn">DAWN</span> vs <span class="vs-dusk">DUSK</span></div>
        <label>bluesky / atproto handle</label>
        <div class="typeahead">
          <input id="login-handle" placeholder="you.bsky.social" autocomplete="off" autocapitalize="off"
                 autocorrect="off" spellcheck="false" role="combobox" aria-autocomplete="list" aria-expanded="false" />
          <ul id="login-suggest" class="typeahead-list" role="listbox" hidden></ul>
        </div>
        <div class="hint">you'll be sent to your own PDS to sign in (OAuth) —
        this site never sees a password.</div>
        <button id="login-go" class="kbtn kbtn-primary">ENLIST WITH BLUESKY</button>
        ${devButton}
        <div class="error" id="login-err"></div>
        <div class="links"><a href="/map">→ war map</a> · <a href="/leaderboard">→ leaderboard</a> · <a href="/notes">→ bulletins</a></div>
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

    attachTypeahead(handleEl, overlay.querySelector<HTMLUListElement>('#login-suggest')!, go);

    overlay.querySelector<HTMLButtonElement>('#login-dev')?.addEventListener('click', async () => {
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
    });
  });
}

// ---------- handle typeahead ----------

interface Actor {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

const TYPEAHEAD_ENDPOINT = 'https://public.api.bsky.app/xrpc/app.bsky.actor.searchActorsTypeahead';

async function searchActors(query: string, signal: AbortSignal): Promise<Actor[]> {
  const url = `${TYPEAHEAD_ENDPOINT}?q=${encodeURIComponent(query)}&limit=8`;
  const res = await fetch(url, { signal });
  if (!res.ok) return [];
  const data = (await res.json()) as { actors?: Actor[] };
  return data.actors ?? [];
}

/**
 * Wire a debounced bluesky-handle autocomplete onto the login input. The
 * public appview serves searchActorsTypeahead unauthenticated, so this stays
 * a pure client-side lookup. `submit` runs when the user commits a choice.
 */
function attachTypeahead(input: HTMLInputElement, list: HTMLUListElement, submit: () => void): void {
  let actors: Actor[] = [];
  let active = -1;
  let debounce: ReturnType<typeof setTimeout> | undefined;
  let inflight: AbortController | undefined;

  const close = () => {
    list.hidden = true;
    list.replaceChildren();
    actors = [];
    active = -1;
    input.setAttribute('aria-expanded', 'false');
  };

  const choose = (actor: Actor) => {
    input.value = actor.handle;
    close();
    submit();
  };

  const render = () => {
    list.replaceChildren();
    actors.forEach((actor, i) => {
      const li = document.createElement('li');
      li.className = 'typeahead-item' + (i === active ? ' active' : '');
      li.setAttribute('role', 'option');
      li.setAttribute('aria-selected', String(i === active));
      const avatar = actor.avatar
        ? `<img class="typeahead-avatar" src="${actor.avatar}" alt="" />`
        : `<span class="typeahead-avatar typeahead-avatar-empty"></span>`;
      const name = actor.displayName?.trim();
      li.innerHTML =
        avatar +
        `<span class="typeahead-text">` +
        `<span class="typeahead-handle">@${actor.handle}</span>` +
        (name ? `<span class="typeahead-name">${escapeHtml(name)}</span>` : '') +
        `</span>`;
      // mousedown (not click) fires before the input's blur, so the choice lands
      li.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        choose(actor);
      });
      list.appendChild(li);
    });
    list.hidden = actors.length === 0;
    input.setAttribute('aria-expanded', String(actors.length > 0));
  };

  input.addEventListener('input', () => {
    const q = input.value.trim().replace(/^@/, '');
    if (debounce) clearTimeout(debounce);
    if (q.length < 2) {
      inflight?.abort();
      close();
      return;
    }
    debounce = setTimeout(() => {
      inflight?.abort();
      inflight = new AbortController();
      searchActors(q, inflight.signal)
        .then((results) => {
          actors = results;
          active = -1;
          render();
        })
        .catch(() => {
          /* aborted or network blip — leave the current list as-is */
        });
    }, 180);
  });

  input.addEventListener('keydown', (ev) => {
    const open = !list.hidden && actors.length > 0;
    switch (ev.key) {
      case 'ArrowDown':
        if (open) {
          ev.preventDefault();
          active = (active + 1) % actors.length;
          render();
        }
        break;
      case 'ArrowUp':
        if (open) {
          ev.preventDefault();
          active = (active - 1 + actors.length) % actors.length;
          render();
        }
        break;
      case 'Enter':
        ev.preventDefault();
        if (open && active >= 0) choose(actors[active]);
        else {
          close();
          submit();
        }
        break;
      case 'Escape':
        if (open) {
          ev.preventDefault();
          close();
        }
        break;
    }
  });

  input.addEventListener('blur', () => {
    // defer so a mousedown on a suggestion is handled before we tear down
    setTimeout(close, 120);
  });
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => {
    switch (c) {
      case '&':
        return '&amp;';
      case '<':
        return '&lt;';
      case '>':
        return '&gt;';
      case '"':
        return '&quot;';
      default:
        return '&#39;';
    }
  });
}
