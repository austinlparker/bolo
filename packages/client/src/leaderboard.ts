/**
 * Persistent leaderboard at /leaderboard. Stats come from the game's
 * per-DID profiles (kills/caps/wars survive across wars); identity comes
 * live from atproto — avatars and display names are fetched from the
 * public Bluesky AppView by DID, and names link to bsky.app profiles.
 * Rank insignia from the Kenney Ranks pack, tiered by rating.
 */
import { FACTION_NAMES, type PlayerProfile, type WarInfo, type WarRecord } from '@bolo/shared';
import { warLine } from './hud';

import { nextRank, rankFor, rankImgUrl, ratingOf } from './ranks';

interface BskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
  description?: string;
}

/** rating drives both sorting (server-side) and rank tiers */
function rating(p: PlayerProfile): number {
  return ratingOf(p);
}

/** Fetch avatars/display names for real atproto DIDs (25 per call). */
async function fetchBskyProfiles(dids: string[]): Promise<Map<string, BskyProfile>> {
  const real = dids.filter((d) => d.startsWith('did:plc:') || d.startsWith('did:web:'));
  const out = new Map<string, BskyProfile>();
  for (let i = 0; i < real.length; i += 25) {
    const chunk = real.slice(i, i + 25);
    const q = chunk.map((d) => `actors=${encodeURIComponent(d)}`).join('&');
    try {
      const res = await fetch(`https://public.api.bsky.app/xrpc/app.bsky.actor.getProfiles?${q}`);
      if (!res.ok) continue;
      const data = (await res.json()) as { profiles?: BskyProfile[] };
      for (const p of data.profiles ?? []) out.set(p.did, p);
    } catch {
      // AppView unreachable: rows fall back to stored handles
    }
  }
  return out;
}

export function startLeaderboard(root: HTMLElement): void {
  root.innerHTML = `
    <div class="lb-wrap">
      <div class="lb-inner">
        <h1>ATBOLO</h1>
        <div class="lb-sub">veterans of the forever war</div>
        <div class="lb-war dim">loading…</div>
        <div class="lb-list"></div>
        <div class="lb-history"></div>
        <div class="lb-links">
          <a class="button-link kbtn" href="/">→ ENLIST</a>
          <a class="button-link kbtn" href="/map">→ WAR MAP</a>
        </div>
        <div class="lb-foot dim">identity via atproto — names link to Bluesky profiles</div>
      </div>
    </div>
  `;

  void (async () => {
    let data: {
      war?: WarInfo;
      leaderboard?: PlayerProfile[];
      history?: WarRecord[];
    } = {};
    try {
      data = await (await fetch('/api/war')).json();
    } catch {
      root.querySelector('.lb-war')!.textContent = 'could not reach the front';
      return;
    }
    const board = data.leaderboard ?? [];
    if (data.war) root.querySelector('.lb-war')!.innerHTML = warLine(data.war);

    const bsky = await fetchBskyProfiles(board.map((p) => p.did));

    const list = root.querySelector('.lb-list')!;
    if (board.length === 0) {
      list.innerHTML = '<div class="lb-empty dim">no veterans yet — be the first to make history</div>';
    } else {
      list.innerHTML = board
        .map((p, i) => {
          const score = rating(p);
          const rank = rankFor(score);
          const live = bsky.get(p.did);
          const name = live?.displayName?.trim() || live?.handle || p.handle;
          const handle = live?.handle ?? p.handle;
          const isReal = p.did.startsWith('did:plc:') || p.did.startsWith('did:web:');
          const avatar = live?.avatar
            ? `<img class="lb-avatar" src="${escapeAttr(live.avatar)}" alt="" loading="lazy" />`
            : `<span class="lb-avatar lb-avatar-fallback f-${p.faction}">${escapeHtml(name.charAt(0).toUpperCase())}</span>`;
          const nameHtml = isReal
            ? `<a href="https://bsky.app/profile/${encodeURIComponent(p.did)}" target="_blank" rel="noopener">${escapeHtml(name)}</a>`
            : escapeHtml(name);
          return `
            <div class="lb-row lb-click" data-i="${i}">
              <span class="lb-pos">${i + 1}</span>
              <img class="lb-rank" src="${rankImgUrl(rank)}" title="${rank.name}" alt="${rank.name}" />
              ${avatar}
              <span class="lb-name">
                <span class="lb-display">${nameHtml}</span>
                <span class="lb-handle dim">@${escapeHtml(handle)} · <span class="f-${p.faction}">${FACTION_NAMES[p.faction]}</span> · ${rank.name}</span>
              </span>
              <span class="lb-stat"><b>${score}</b><small>rating</small></span>
              <span class="lb-stat">${p.kills}/${p.deaths}<small>k/d</small></span>
              <span class="lb-stat">${p.caps}<small>caps</small></span>
              <span class="lb-stat">${p.warsWon ?? 0}/${p.warsFought}<small>wars won</small></span>
            </div>`;
        })
        .join('');
      for (const el of list.querySelectorAll<HTMLElement>('.lb-row')) {
        el.onclick = () => {
          const p = board[Number(el.dataset.i)];
          if (p) showProfileCard(root, p, bsky.get(p.did));
        };
      }
    }

    const hist = data.history ?? [];
    if (hist.length) {
      root.querySelector('.lb-history')!.innerHTML =
        '<h2>war history</h2>' +
        hist
          .map(
            (r) =>
              `<div class="lb-hist-row">war ${r.warNumber} — <span class="f-${r.winner}">${FACTION_NAMES[r.winner]}</span> conquered the island in ${r.durationMinutes}m</div>`,
          )
          .join('');
    }
  })();
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function escapeAttr(s: string): string {
  return escapeHtml(s).replace(/"/g, '&quot;');
}

/** Modal career card: atproto identity + bio up top, war record below. */
function showProfileCard(root: HTMLElement, p: PlayerProfile, live?: BskyProfile): void {
  document.querySelector('.pcard-backdrop')?.remove();
  const score = ratingOf(p);
  const rank = rankFor(score);
  const next = nextRank(score);
  const name = live?.displayName?.trim() || live?.handle || p.handle;
  const handle = live?.handle ?? p.handle;
  const isReal = p.did.startsWith('did:plc:') || p.did.startsWith('did:web:');
  const kd = p.deaths > 0 ? (p.kills / p.deaths).toFixed(2) : p.kills.toFixed(2);
  const progress = next
    ? Math.round(((score - rank.min) / (next.min - rank.min)) * 100)
    : 100;

  const backdrop = document.createElement('div');
  backdrop.className = 'pcard-backdrop';
  backdrop.innerHTML = `
    <div class="pcard kpanel">
      <div class="pcard-head">
        ${
          live?.avatar
            ? `<img class="pcard-avatar" src="${escapeAttr(live.avatar)}" alt="" />`
            : `<span class="pcard-avatar lb-avatar-fallback f-${p.faction}">${escapeHtml(name.charAt(0).toUpperCase())}</span>`
        }
        <div class="pcard-id">
          <div class="pcard-name">${escapeHtml(name)}</div>
          <div class="pcard-handle dim">${
            isReal
              ? `<a href="https://bsky.app/profile/${encodeURIComponent(p.did)}" target="_blank" rel="noopener">@${escapeHtml(handle)}</a>`
              : `@${escapeHtml(handle)}`
          } · <span class="f-${p.faction}">${FACTION_NAMES[p.faction]}</span>${p.isBot ? ' · ⚙ bot' : ''}</div>
        </div>
        <img class="pcard-rank" src="${rankImgUrl(rank)}" alt="${rank.name}" />
      </div>
      ${live?.description ? `<div class="pcard-bio dim">${escapeHtml(live.description)}</div>` : ''}
      <div class="pcard-rankline">
        <span>${rank.name}</span>
        <span class="meter pcard-meter"><span class="meter-fill" style="width:${progress}%;background:var(--dawn)"></span></span>
        <span class="dim">${next ? `${score}/${next.min} → ${next.name}` : 'top of the ladder'}</span>
      </div>
      <div class="pcard-stats">
        <span><b>${score}</b><small>rating</small></span>
        <span><b>${p.kills}</b><small>kills</small></span>
        <span><b>${kd}</b><small>k/d</small></span>
        <span><b>${p.caps}</b><small>captures</small></span>
        <span><b>${p.warsWon ?? 0}/${p.warsFought}</b><small>wars won</small></span>
      </div>
      <div class="pcard-foot dim">veteran since ${new Date(p.firstSeen).toLocaleDateString()} · last seen ${new Date(p.lastSeen).toLocaleDateString()}</div>
    </div>`;
  backdrop.onclick = (ev) => {
    if (ev.target === backdrop) backdrop.remove();
  };
  root.appendChild(backdrop);
}
