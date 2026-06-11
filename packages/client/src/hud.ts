/** DOM-based HUD: status readouts, builder tool bar, kill feed, chat, minimap. */
import {
  type BuilderOrderKind,
  type ChatBroadcastMsg,
  FACTION_NAMES,
  MAP_SIZE,
  type WarInfo,
} from '@bolo/shared';
import { FACTION_COLORS } from './render';
import type { GameState } from './state';
import { TILE_PX, TileCache } from './tiles';

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
  private miniTiles = new TileCache();
  tool: BuilderOrderKind = 'harvest';
  private bannerTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(root: HTMLElement) {
    this.root = root;
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div id="hud-status" class="hud"></div>
      <div id="hud-war" class="hud"></div>
      <div id="hud-tools" class="hud"></div>
      <div id="hud-feed" class="hud"></div>
      <div id="hud-chat" class="hud">
        <div id="chat-log"></div>
        <input id="chat-input" maxlength="240" placeholder="say something... (enter)" />
      </div>
      <canvas id="hud-minimap" class="hud" width="180" height="180"></canvas>
      <div id="banner"></div>
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
      el.className = 'tool';
      el.dataset.kind = t.kind;
      el.textContent = t.label;
      el.title = t.tip;
      el.onclick = () => this.setTool(t.kind);
      this.toolsEl.appendChild(el);
    }
    const recall = document.createElement('div');
    recall.className = 'tool';
    recall.textContent = 'R ↩ recall';
    recall.title = 'recall the builder (refunds the order)';
    recall.onclick = () => this.onRecall?.();
    this.toolsEl.appendChild(recall);
    this.setTool('harvest');
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

  update(state: GameState): void {
    const me = state.me();
    if (me && me.armor !== undefined) {
      if (!me.alive) {
        this.status.innerHTML = `
          <div class="callsign"><span class="f-${me.faction}">${escapeHtml(me.handle)}</span></div>
          <div class="dead">⊘ DESTROYED</div>
          <div class="dim">respawn in ${me.respawnIn ?? '…'}s</div>`;
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
        this.status.innerHTML = `
          <div class="callsign"><span class="f-${me.faction}">${escapeHtml(me.handle)}</span>
            <span class="dim">· ${FACTION_NAMES[me.faction]}</span></div>
          ${meters}
          <div class="dim">${builderLine}${me.carriedPill != null ? ' · ◉ carrying pillbox' : ''}</div>`;
      }
    } else if (state.you) {
      this.status.innerHTML = `<div class="callsign"><span class="f-${state.you.faction}">${escapeHtml(state.you.handle)}</span></div><div class="dim">deploying…</div>`;
    }

    if (state.war) this.war.innerHTML = warLine(state.war);

    this.feed.innerHTML = state.feed.map((l) => `<div>${escapeHtml(l)}</div>`).join('');

    this.drawMinimap(state);
  }

  private drawMinimap(state: GameState): void {
    const ctx = this.minimap.getContext('2d')!;
    this.miniTiles.sync(state);
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(this.miniTiles.canvas, 0, 0, MAP_SIZE * TILE_PX, MAP_SIZE * TILE_PX, 0, 0, 180, 180);
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
