/**
 * Persistent leaderboard at /leaderboard. Stats come from the game's
 * per-DID profiles (kills/caps/wars survive across wars); identity comes
 * live from atproto — avatars and display names are fetched from the
 * public Bluesky AppView by DID, and names link to bsky.app profiles.
 * Rank insignia from the Kenney Ranks pack, tiered by rating.
 */
import { FACTION_NAMES, type PlayerProfile, type WarInfo, type WarRecord } from '@bolo/shared';
import { warLine } from './hud';

interface BskyProfile {
  did: string;
  handle: string;
  displayName?: string;
  avatar?: string;
}

/** rating drives both sorting (server-side) and rank tiers */
function rating(p: PlayerProfile): number {
  return p.kills + p.caps * 3;
}

const RANKS: { min: number; name: string; img: string }[] = [
  { min: 0, name: 'recruit', img: 'rank009' },
  { min: 10, name: 'private', img: 'rank013' },
  { min: 25, name: 'corporal', img: 'rank014' },
  { min: 50, name: 'sergeant', img: 'rank015' },
  { min: 100, name: 'lieutenant', img: 'rank016' },
  { min: 200, name: 'captain', img: 'rank060' },
  { min: 400, name: 'major', img: 'rank056' },
  { min: 800, name: 'colonel', img: 'rank073' },
  { min: 1500, name: 'general', img: 'rank077' },
];

function rankFor(score: number): { name: string; img: string } {
  let r = RANKS[0];
  for (const tier of RANKS) if (score >= tier.min) r = tier;
  return r;
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
        <h1>BOLO</h1>
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
            <div class="lb-row">
              <span class="lb-pos">${i + 1}</span>
              <img class="lb-rank" src="/assets/ranks/${rank.img}.png" title="${rank.name}" alt="${rank.name}" />
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
