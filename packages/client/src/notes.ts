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
    id: 3,
    date: '2026-06-16',
    title: 'THE HEADING DISPATCHES',
    items: [
      'turning is fixed. the old model had two ramps fighting each other — your client ramped one way, the server ramped another, and the mismatch made your tank drift after you let go. now your client owns the heading outright and tells the server where you\'re pointed. tap to nudge, hold to swing, release to stop dead. no overshoot, no drift, no fighting.',
      'your tank reacts the instant you touch a control. the client predicts your movement locally and reconciles with the server behind the scenes — no more waiting a tenth of a second for the round-trip before your hull starts moving.',
      'other tanks turn smoother too: a deeper interpolation buffer absorbs network jitter instead of stuttering when a packet lands late.',
      'bluesky avatars appear on tank name badges, the HUD, and the kill feed. mutual follows are flagged — you\'ll know who you actually know out there.',
      'bounties: when someone kills your mutual, a bounty goes on the killer. any mutual of the victim can claim it for bonus kill credit. escalate with B (or the 💰 button) to raise the stakes.',
      'your top nemesis is tracked across the war — the player who\'s killed you the most. revenge kills and paybacks light up the feed.',
      'garrison AI rebuilt from scratch. NPCs build boats and cross water, coordinate focus fire, defend sieged bases, dodge incoming shells, steer around mines, retreat when outgunned, and lay tactical roads, walls, and mines. they\'re still beatable — but they won\'t drown in a puddle or charge single-file into your gun anymore.',
      'bases have square wall perimeters now, built by the garrison. spawn-trapping from NPC walls is fixed.',
      'white crosshair for better contrast against terrain.',
      'stability: the server no longer drops everyone after ~30 minutes of cumulative CPU (switched to alarm-driven ticking). connecting no longer freezes the game while fetching social graph data. and reconnecting after a server restart actually puts you back in a tank instead of stranding you as a spectator.',
      'loading screen stays until the first game frame actually renders — no more blank canvas gap on connect.',
    ],
  },
  {
    id: 2,
    date: '2026-06-13',
    title: 'THE REFIT DISPATCHES',
    items: [
      'driving split in two: a throttle on the left that you set and forget — it holds your speed — and a turn stick on the right. throttle up, let go, keep rolling. STOP (or X on a keyboard) cuts it to zero.',
      'FIRE moved next to the throttle. with cruise holding your speed, the left thumb is free to shoot while the right thumb steers — come about and fire in the same breath.',
      'tanks turn slower now. the old rate spun like a turret on ice; this one has some mass behind it.',
      'bases have fortifications. shell an enemy base until its defenses break and it falls neutral, then drive onto the pad to claim it. owned bases dig in and restock over time, and a battered base supplies its tanks more slowly.',
      'when one faction holds most of the island a victory countdown starts — break their grip on a single base and the clock resets.',
      'the war tally lives on the minimap now: colored base counts with a ⚑ countdown when someone is running away with it.',
      'mobile: the ⋯ menu actually opens, the control buttons are all one size, and the whole layout works in portrait as well as landscape.',
    ],
  },
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
