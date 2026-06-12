/**
 * War bulletins: player-facing patch notes plus field commendations for
 * the people who earn them. One source of truth — rendered as the in-game
 * overlay (N / the 📜 button) and as the standalone /notes page.
 * Add new bulletins to the FRONT of the array and bump the id.
 */

export interface Bulletin {
  id: number;
  date: string;
  title: string;
  items: string[];
  /** field commendations: [handleOrName, citation] — handles starting with @ link to Bluesky */
  credits?: [string, string][];
}

export const BULLETINS: Bulletin[] = [
  {
    id: 1,
    date: '2026-06-12',
    title: 'THE PLAYTEST DISPATCHES',
    items: [
      'tanks have a reverse gear — S (or pulling back) brakes, then backs up at half speed. the S was never a lie, it was just unimplemented',
      'roads work like you thought they did: any tread on the pavement gets the speed boost, not just a perfectly centered hull',
      'boats now outrun roads. ten trees buys the fastest ride on the island — on open water, exposed',
      'garrison tanks take a beat to acquire you and genuinely miss now. they were aiming with server-side omniscience; your 77 deaths were not your fault',
      'wars end: after 45 minutes the faction holding more bases takes the island. no more eight-hour 7v7 stalemates',
      'the war panel counts bases live as they change hands',
      'mobile: chat has a send button that works, help / leaderboard / leave live under the minimap, and ⌖ builds on your own tile (mines go there). the gun stick is steadier and the fire window is tighter',
      'every island is its own island now — coastlines, forests, base layouts, and a connected road network that wanders',
      'stability: fixed the server hiccup that dropped everyone at once, the mobile black-screen, and stale tabs that played an old version forever',
    ],
    credits: [
      [
        '@teqnomad.bsky.social',
        'first volunteer playtester of the forever war — filed the reports behind nearly every line above, from the far side of the planet, mostly while talking to themselves. 1 kill, 77 deaths, zero surrender.',
      ],
    ],
  },
];

const SEEN_KEY = 'bolo_bulletin_seen';

export function latestBulletinId(): number {
  return BULLETINS[0]?.id ?? 0;
}

export function hasUnseenBulletins(): boolean {
  return Number(localStorage.getItem(SEEN_KEY) ?? 0) < latestBulletinId();
}

export function markBulletinsSeen(): void {
  localStorage.setItem(SEEN_KEY, String(latestBulletinId()));
}

export function bulletinsHtml(): string {
  return BULLETINS.map((b) => {
    const items = b.items.map((i) => `<li>${escapeHtml(i)}</li>`).join('');
    const credits = (b.credits ?? [])
      .map(([who, citation]) => {
        const name = who.startsWith('@')
          ? `<a href="https://bsky.app/profile/${encodeURIComponent(who.slice(1))}" target="_blank" rel="noopener">${escapeHtml(who)}</a>`
          : escapeHtml(who);
        return `<div class="note-credit">🎖 <b>${name}</b> — ${escapeHtml(citation)}</div>`;
      })
      .join('');
    return `
      <div class="note-entry">
        <h3>BULLETIN ${String(b.id).padStart(3, '0')} · ${escapeHtml(b.title)}</h3>
        <div class="note-date dim">${escapeHtml(b.date)}</div>
        <ul class="note-items">${items}</ul>
        ${credits ? `<div class="note-credits"><div class="note-credits-head">FIELD COMMENDATIONS</div>${credits}</div>` : ''}
      </div>`;
  }).join('');
}

/** Standalone /notes page, in the leaderboard's chrome. */
export function startNotes(root: HTMLElement): void {
  markBulletinsSeen();
  root.innerHTML = `
    <div class="lb-wrap">
      <div class="lb-inner">
        <h1>ATBOLO</h1>
        <div class="lb-sub">war bulletins — dispatches from the front</div>
        <div class="notes-page">${bulletinsHtml()}</div>
        <div class="lb-links">
          <a class="button-link kbtn" href="/">→ ENLIST</a>
          <a class="button-link kbtn" href="/map">→ WAR MAP</a>
          <a class="button-link kbtn" href="/leaderboard">→ VETERANS</a>
        </div>
      </div>
    </div>
  `;
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
