/** DOM-based HUD: status readouts, builder tool bar, kill feed, chat, minimap. */
import {
  type BuilderOrderKind,
  type ChatBroadcastMsg,
  type EmoteKind,
  EMOTES,
  FACTION_NAMES,
  MAP_SIZE,
  type WarInfo,
} from '@bolo/shared';
import { MiniMapCache } from './minimap';
import { FACTION_COLORS } from './render';
import { rankFor, rankImgUrl, ratingOf } from './ranks';
import { EMOTE_FILES } from './sprites';
import type { GameState } from './state';

export const TOOLS: { key: string; kind: BuilderOrderKind; label: string; tip: string }[] = [
  { key: '1', kind: 'harvest', label: '1 ⚒ chop', tip: 'fell a forest tile (+4 trees)' },
  { key: '2', kind: 'road', label: '2 ▦ road', tip: 'pave road / bridge a river (2 trees)' },
  { key: '3', kind: 'wall', label: '3 ■ wall', tip: 'raise a wall (2 trees, 1 to repair)' },
  { key: '4', kind: 'boat', label: '4 ⛵ boat', tip: 'build a boat on river (10 trees)' },
  { key: '5', kind: 'pillbox', label: '5 ◉ pill', tip: 'place carried pillbox (2 trees) or repair one (4 trees)' },
  { key: '6', kind: 'mine', label: '6 ✸ mine', tip: 'bury a mine (uses 1 tank mine)' },
];

const METERS: { key: 'armor' | 'shells' | 'mines' | 'trees'; label: string; color: string }[] = [
  { key: 'armor', label: 'ARMR', color: '#7fc46a' },
  { key: 'shells', label: 'SHEL', color: '#e8c75d' },
  { key: 'mines', label: 'MINE', color: '#e85d5d' },
  { key: 'trees', label: 'TREE', color: '#4a9e55' },
];

export class Hud {
  root: HTMLElement;
  private status: HTMLElement;
  private war: HTMLElement;
  private toolsEl: HTMLElement;
  private feed: HTMLElement;
  private chatLog: HTMLElement;
  chatInput: HTMLInputElement;
  private minimap: HTMLCanvasElement;
  private banner: HTMLElement;
  private miniTiles = new MiniMapCache();
  tool: BuilderOrderKind = 'harvest';
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;
  /** last frame the HUD actually repainted (see update's 5Hz cap) */
  private lastUpdateAt = 0;
  /** last innerHTML written per panel, to skip no-op DOM rebuilds */
  private htmlCache = new Map<HTMLElement, string>();

  constructor(root: HTMLElement) {
    this.root = root;
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div id="hud-status" class="hud kpanel"></div>
      <div id="hud-war" class="hud kpanel"></div>
      <div id="hud-tools" class="hud kpanel"></div>
      <div id="hud-feed" class="hud"></div>
      <div id="hud-chat" class="hud">
        <div id="chat-log"></div>
        <input id="chat-input" maxlength="240" placeholder="say something... (enter)" />
      </div>
      <div id="chat-toggle" class="hud kbtn kbtn-round">💬</div>
      <canvas id="hud-minimap" class="hud" width="180" height="180"></canvas>
      <div id="banner"></div>
      <div id="toast"></div>
      <div id="death-overlay">⊘ DESTROYED<small></small></div>
      <div id="builder-ui" class="hud">
        <div id="builder-tray"></div>
        <div id="builder-btn" class="kbtn kbtn-round">⚒</div>
      </div>
      <div id="emote-picker" class="hud kpanel"></div>
      <div id="emote-toggle" class="hud kbtn kbtn-round">🙂</div>
      <div id="help-overlay">
        <div class="help-box kpanel">
          <h2>ATBOLO FIELD MANUAL</h2>
          <div class="help-sub">press <kbd>?</kbd> or <kbd>esc</kbd> to close</div>
          <div class="help-cols">
            <div>
              <h3>DRIVING</h3>
              <div class="help-row"><span>accelerate / reverse</span><span class="keys"><kbd>W</kbd> <kbd>S</kbd></span></div>
              <div class="help-row"><span>turn — <em>tap</em> for fine aim, hold to sweep</span><span class="keys"><kbd>A</kbd> <kbd>D</kbd></span></div>
              <div class="help-row"><span>fire</span><span class="keys"><kbd>space</kbd></span></div>
              <div class="help-row"><span>gun range up / down — shells land on the reticle</span><span class="keys"><kbd>⇧↑</kbd> <kbd>⇧↓</kbd> or mouse back/fwd</span></div>
              <h3>COMMS</h3>
              <div class="help-row"><span>chat</span><span class="keys"><kbd>enter</kbd></span></div>
              <div class="help-row"><span>emote</span><span class="keys"><kbd>E</kbd></span></div>
              <div class="help-row"><span>mute / unmute sound</span><span class="keys"><kbd>M</kbd></span></div>
              <div class="help-row"><span>this manual</span><span class="keys"><kbd>?</kbd></span></div>
              <div class="help-row"><span>leave the war (spectate from /map)</span><span class="keys">⏏ button</span></div>
            </div>
            <div>
              <h3>BUILDER (the little green man)</h3>
              <div class="help-row"><span>select tool</span><span class="keys"><kbd>1</kbd>–<kbd>6</kbd></span></div>
              <div class="help-row"><span>send builder to clicked tile</span><span class="keys">click</span></div>
              <div class="help-row"><span>send builder to gun cursor</span><span class="keys"><kbd>G</kbd></span></div>
              <div class="help-row"><span>build on your own tile</span><span class="keys"><kbd>V</kbd></span></div>
              <div class="help-row"><span>recall builder (refunds)</span><span class="keys"><kbd>R</kbd></span></div>
              <h3>THE WAR</h3>
              <div class="help-row"><span>capture bases by parking on them</span><span></span></div>
              <div class="help-row"><span>refuel armor/shells/mines at friendly bases</span><span></span></div>
              <div class="help-row"><span>dead pillboxes can be salvaged &amp; re-placed</span><span></span></div>
            </div>
          </div>
          <div class="help-foot">tools cost trees — chop forests with the harvest tool · hold the line, commander</div>
        </div>
      </div>
    `,
    );
    this.status = document.getElementById('hud-status')!;
    this.war = document.getElementById('hud-war')!;
    this.toolsEl = document.getElementById('hud-tools')!;
    this.feed = document.getElementById('hud-feed')!;
    this.chatLog = document.getElementById('chat-log')!;
    this.chatInput = document.getElementById('chat-input') as HTMLInputElement;
    this.minimap = document.getElementById('hud-minimap') as HTMLCanvasElement;
    this.banner = document.getElementById('banner')!;

    for (const t of TOOLS) {
      const el = document.createElement('div');
      el.className = 'tool kbtn';
      el.dataset.kind = t.kind;
      el.textContent = t.label;
      el.title = t.tip;
      el.onclick = () => this.setTool(t.kind);
      this.toolsEl.appendChild(el);
    }
    const recall = document.createElement('div');
    recall.className = 'tool kbtn';
    recall.textContent = 'R ↩ recall';
    recall.title = 'recall the builder (refunds the order)';
    recall.onclick = () => this.onRecall?.();
    this.toolsEl.appendChild(recall);
    this.setTool('harvest');

    // help: ? key (wired in input.ts) or this button; click outside to close
    const help = document.createElement('div');
    help.className = 'tool kbtn';
    help.textContent = '? help';
    help.title = 'controls & field manual (?)';
    help.onclick = () => this.toggleHelp();
    this.toolsEl.appendChild(help);

    // leave the war: back to the public map as a spectator (tank despawns)
    const leave = document.createElement('div');
    leave.className = 'tool kbtn';
    leave.textContent = '⏏ leave';
    leave.title = 'leave the war and watch from the map room';
    leave.onclick = () => {
      location.href = '/map';
    };
    this.toolsEl.appendChild(leave);
    const overlay = document.getElementById('help-overlay')!;
    overlay.onclick = (ev) => {
      if (ev.target === overlay) this.toggleHelp(false);
    };

    // mobile: chat is hidden behind a toggle so it doesn't cover the field
    const chatWrap = document.getElementById('hud-chat')!;
    const toggle = document.getElementById('chat-toggle')!;
    toggle.onclick = () => chatWrap.classList.toggle('open');

    // mobile: minimap tap-toggles between small and large
    this.minimap.addEventListener('pointerdown', () => {
      if (document.body.classList.contains('touch-mode')) this.minimap.classList.toggle('big');
    });

    this.buildMobileBuilderUi();
    this.buildEmotePicker();
  }

  // ---------- emotes ----------

  onEmote: ((kind: EmoteKind) => void) | null = null;

  private buildEmotePicker(): void {
    const picker = document.getElementById('emote-picker')!;
    for (const kind of EMOTES) {
      const el = document.createElement('div');
      el.className = 'emote-option kbtn';
      el.innerHTML = `<img src="${EMOTE_FILES[kind]}" alt="${kind}" draggable="false" />`;
      el.onclick = () => {
        this.onEmote?.(kind);
        picker.classList.remove('open');
      };
      picker.appendChild(el);
    }
    document.getElementById('emote-toggle')!.onclick = () => this.toggleEmotePicker();
    // desktop trigger lives in the tool bar
    const tool = document.createElement('div');
    tool.className = 'tool kbtn';
    tool.textContent = 'E 🙂';
    tool.title = 'emote (E)';
    tool.onclick = () => this.toggleEmotePicker();
    this.toolsEl.appendChild(tool);
  }

  toggleEmotePicker(): void {
    document.getElementById('emote-picker')!.classList.toggle('open');
  }

  // ---------- mobile builder flow ----------
  // Tools live behind one ⚒ button: tap to open the tray, pick a tool to
  // "arm" it, then tap the battlefield once to dispatch. No persistent
  // toolbar eating the screen, no accidental dispatches while panning eyes.

  /** tool armed for a single tap-dispatch (mobile only); null = disarmed */
  private armedTool: BuilderOrderKind | null = null;

  private buildMobileBuilderUi(): void {
    const ui = document.getElementById('builder-ui')!;
    const btn = document.getElementById('builder-btn')!;
    const tray = document.getElementById('builder-tray')!;

    for (const t of TOOLS) {
      const el = document.createElement('div');
      el.className = 'tray-tool kbtn';
      el.innerHTML = `${t.label.slice(2)}`;
      el.onclick = () => {
        this.armedTool = t.kind;
        this.tool = t.kind;
        btn.textContent = t.label.slice(2, 4).trim();
        ui.classList.remove('open');
        ui.classList.add('armed');
        this.showToast(`tap the map to send your builder — ${t.label.slice(2)}`, 0);
      };
      tray.appendChild(el);
    }
    const recall = document.createElement('div');
    recall.className = 'tray-tool kbtn';
    recall.textContent = '↩ recall';
    recall.onclick = () => {
      this.onRecall?.();
      ui.classList.remove('open');
      this.showToast('builder recalled', 1400);
    };
    tray.appendChild(recall);

    btn.onclick = () => {
      if (this.armedTool) {
        // cancel an armed tool
        this.disarmTool();
        return;
      }
      ui.classList.toggle('open');
    };
  }

  /** consume the armed tool for one dispatch (mobile tap flow) */
  takeArmedTool(): BuilderOrderKind | null {
    const t = this.armedTool;
    if (t) this.disarmTool();
    return t;
  }

  private disarmTool(): void {
    this.armedTool = null;
    const ui = document.getElementById('builder-ui')!;
    const btn = document.getElementById('builder-btn')!;
    ui.classList.remove('armed', 'open');
    btn.textContent = '⚒';
    this.hideToast();
  }

  // ---------- help ----------

  toggleHelp(force?: boolean): void {
    document.getElementById('help-overlay')!.classList.toggle('show', force);
  }

  helpOpen(): boolean {
    return document.getElementById('help-overlay')!.classList.contains('show');
  }

  // ---------- toast ----------

  private toastTimer: ReturnType<typeof setTimeout> | null = null;

  showToast(text: string, ms = 1600, kind: 'info' | 'error' = 'info'): void {
    const el = document.getElementById('toast')!;
    el.textContent = text;
    el.classList.toggle('error', kind === 'error');
    el.classList.remove('show');
    void el.offsetWidth; // restart the shake animation on repeat errors
    el.classList.add('show');
    if (this.toastTimer) clearTimeout(this.toastTimer);
    this.toastTimer = ms > 0 ? setTimeout(() => this.hideToast(), ms) : null;
  }

  hideToast(): void {
    document.getElementById('toast')!.classList.remove('show');
  }

  onRecall: (() => void) | null = null;

  setTool(kind: BuilderOrderKind): void {
    this.tool = kind;
    for (const el of this.toolsEl.querySelectorAll<HTMLElement>('.tool')) {
      el.classList.toggle('active', el.dataset.kind === kind);
    }
  }

  showBanner(html: string, ms = 4000): void {
    this.banner.innerHTML = html;
    this.banner.classList.remove('show');
    void this.banner.offsetWidth; // restart the CSS animation
    this.banner.classList.add('show');
    if (this.bannerTimer) clearTimeout(this.bannerTimer);
    this.bannerTimer = setTimeout(() => this.banner.classList.remove('show'), ms);
  }

  addChat(msg: ChatBroadcastMsg): void {
    const div = document.createElement('div');
    const name = document.createElement('span');
    name.className = `f-${msg.faction}`;
    name.textContent = msg.faction === 'system' ? '· ' : `${msg.from}: `;
    div.appendChild(name);
    div.appendChild(document.createTextNode(msg.text));
    this.chatLog.appendChild(div);
    while (this.chatLog.children.length > 40) this.chatLog.firstChild?.remove();
    this.chatLog.scrollTop = this.chatLog.scrollHeight;
  }

  /** Skip innerHTML assignment when the content hasn't changed. */
  private setHtml(el: HTMLElement, html: string): void {
    if (this.htmlCache.get(el) === html) return;
    this.htmlCache.set(el, html);
    el.innerHTML = html;
  }

  update(state: GameState): void {
    // called every animation frame, but repaints at 5Hz: per-frame innerHTML
    // rebuilds + the minimap blit were a real cost on mobile GPUs, and
    // nothing here changes faster than the 10Hz server tick anyway
    const now = performance.now();
    if (now - this.lastUpdateAt < 200) return;
    this.lastUpdateAt = now;

    const me = state.me();
    const mobile = document.body.classList.contains('touch-mode');

    // live career rating: persistent profile + what you've earned this session
    const liveRating =
      ratingOf({
        kills: (state.profile?.kills ?? 0) + (me?.kills ?? 0),
        caps: (state.profile?.caps ?? 0) + (me?.caps ?? 0),
      });
    const rank = rankFor(liveRating);
    const rankChip = `<img class="rank-chip" src="${rankImgUrl(rank)}" title="${rank.name} · ${liveRating} rating" alt="${rank.name}" />`;

    // centered death overlay (both desktop and mobile)
    const death = document.getElementById('death-overlay')!;
    if (me && me.armor !== undefined && !me.alive) {
      death.classList.add('show');
      death.querySelector('small')!.textContent = `respawning in ${me.respawnIn ?? '…'}s`;
    } else {
      death.classList.remove('show');
    }

    if (me && me.armor !== undefined) {
      if (mobile) {
        // one slim translucent strip of icon+number pairs
        const builderOut = state.builders.some((x) => x.tankId === me.id);
        this.setHtml(this.status, `
          ${rankChip}
          <span class="stat" style="color:#7fc46a">🛡${me.armor}</span>
          <span class="stat" style="color:#e8c75d">✦${me.shells}</span>
          <span class="stat" style="color:#e85d5d">✸${me.mines}</span>
          <span class="stat" style="color:#4a9e55">🌲${me.trees}</span>
          ${builderOut ? '<span class="stat">⚒…</span>' : ''}
          ${me.carriedPill != null ? '<span class="stat">◉</span>' : ''}`);
      } else if (!me.alive) {
        this.setHtml(this.status, `
          <div class="callsign">${rankChip}<span class="f-${me.faction}">${escapeHtml(me.handle)}</span></div>
          <div class="dim">awaiting redeployment</div>`);
      } else {
        const meters = METERS.map(
          (m) => `
          <div class="meter-row"><span class="meter-label">${m.label}</span>
            <span class="meter"><span class="meter-fill" style="width:${((me[m.key] ?? 0) / 40) * 100}%;background:${m.color}"></span></span>
            <span class="meter-num">${me[m.key]}</span></div>`,
        ).join('');
        const builderPhase = state.builders.find((x) => x.tankId === me.id)?.phase;
        const builderLine = builderPhase
          ? `builder: ${builderPhase}`
          : 'builder: in tank';
        this.setHtml(this.status, `
          <div class="callsign">${rankChip}<span class="f-${me.faction}">${escapeHtml(me.handle)}</span>
            <span class="dim">· ${FACTION_NAMES[me.faction]} · ${rank.name}</span></div>
          ${meters}
          <div class="dim">${builderLine}${me.carriedPill != null ? ' · ◉ carrying pillbox' : ''}</div>`);
      }
    } else if (state.you) {
      this.setHtml(this.status, `<div class="callsign"><span class="f-${state.you.faction}">${escapeHtml(state.you.handle)}</span></div><div class="dim">deploying…</div>`);
    }

    if (state.war) this.setHtml(this.war, warLine(state.war));

    this.setHtml(this.feed, state.feed.map((l) => `<div>${escapeHtml(l)}</div>`).join(''));

    this.drawMinimap(state);
  }

  private drawMinimap(state: GameState): void {
    const ctx = this.minimap.getContext('2d')!;
    this.miniTiles.sync(state);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.miniTiles.canvas, 0, 0, MAP_SIZE, MAP_SIZE, 0, 0, 180, 180);
    const k = 180 / MAP_SIZE;
    for (const b of state.bases) {
      ctx.fillStyle = FACTION_COLORS[b.owner];
      ctx.fillRect(b.x * k - 2, b.y * k - 2, 4, 4);
      ctx.strokeStyle = 'rgba(0,0,0,0.6)';
      ctx.strokeRect(b.x * k - 2, b.y * k - 2, 4, 4);
    }
    for (const p of state.pills) {
      if (p.inTank || p.hp <= 0) continue;
      ctx.fillStyle = FACTION_COLORS[p.owner];
      ctx.fillRect(p.x * k - 1, p.y * k - 1, 2, 2);
    }
    for (const it of state.tanks.values()) {
      if (!it.cur.alive) continue;
      const mine = it.cur.id === state.you?.tankId;
      ctx.fillStyle = mine ? '#ffffff' : FACTION_COLORS[it.cur.faction];
      ctx.beginPath();
      ctx.arc(it.cur.x * k, it.cur.y * k, mine ? 2.5 : 2, 0, Math.PI * 2);
      ctx.fill();
    }
  }
}

export function warLine(war: WarInfo): string {
  const c = war.baseCounts;
  if (war.phase === 'intermission' && war.nextWarAt) {
    const s = Math.max(0, Math.ceil((war.nextWarAt - Date.now()) / 1000));
    return `WAR ${war.warNumber} OVER — next war in ${s}s`;
  }
  return (
    `WAR ${war.warNumber} · ` +
    `<span class="f-dawn">dawn ${c.dawn}</span> / ` +
    `<span class="f-neutral">free ${c.neutral}</span> / ` +
    `<span class="f-dusk">dusk ${c.dusk}</span> bases`
  );
}

function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}
