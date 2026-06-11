/** Public whole-map war view at /map. No login required. */
import {
  base64ToBytes,
  FACTION_NAMES,
  MAP_SIZE,
  type ServerMsg,
  type SpectateMsg,
  TOTAL_BASES,
  type WarRecord,
} from '@bolo/shared';
import { Net } from './net';
import { FACTION_COLORS } from './render';
import { GameState } from './state';
import { TILE_PX, TileCache } from './tiles';
import { warLine } from './hud';

export function startSpectator(root: HTMLElement): void {
  const canvas = document.createElement('canvas');
  canvas.className = 'game';
  root.appendChild(canvas);
  const ctx = canvas.getContext('2d')!;
  const fit = () => {
    canvas.width = innerWidth;
    canvas.height = innerHeight;
  };
  addEventListener('resize', fit);
  fit();

  const panel = document.createElement('div');
  panel.className = 'spec-panel';
  panel.innerHTML = '<h2>BOLO</h2>connecting to the front...';
  root.appendChild(panel);

  const state = new GameState();
  const tiles = new TileCache();
  let latest: SpectateMsg | null = null;
  let history: WarRecord[] = [];

  void fetch('/api/war')
    .then((r) => r.json())
    .then((d: { history?: WarRecord[] }) => {
      history = d.history ?? [];
    })
    .catch(() => {});

  const net = new Net(
    (msg: ServerMsg) => {
      if (msg.t === 'welcome') {
        state.applyWelcome(msg);
      } else if (msg.t === 'spectate') {
        latest = msg;
        state.war = msg.war;
        state.bases = msg.bases;
        state.pills = msg.pills;
        if (msg.terrain) {
          for (const [x, y, t] of msg.terrain) {
            state.terrain[y * MAP_SIZE + x] = t;
            state.dirtyTiles.push([x, y]);
          }
        }
      } else if (msg.t === 'war_over') {
        history.unshift(msg.record);
      }
    },
    () => ({ t: 'hello', role: 'spectator' }),
  );
  net.connect();

  function draw(): void {
    requestAnimationFrame(draw);
    const { width: w, height: h } = canvas;
    ctx.fillStyle = '#07080c';
    ctx.fillRect(0, 0, w, h);
    tiles.sync(state);

    const size = Math.min(w, h) - 24;
    const ox = (w - size) / 2;
    const oy = (h - size) / 2;
    ctx.imageSmoothingEnabled = true;
    ctx.drawImage(tiles.canvas, 0, 0, MAP_SIZE * TILE_PX, MAP_SIZE * TILE_PX, ox, oy, size, size);
    const k = size / MAP_SIZE;

    for (const b of state.bases) {
      ctx.fillStyle = FACTION_COLORS[b.owner];
      ctx.fillRect(ox + b.x * k - 4, oy + b.y * k - 4, 8, 8);
      ctx.strokeStyle = '#000';
      ctx.strokeRect(ox + b.x * k - 4, oy + b.y * k - 4, 8, 8);
    }
    for (const p of state.pills) {
      if (p.inTank) continue;
      ctx.fillStyle = p.hp <= 0 ? '#444' : FACTION_COLORS[p.owner];
      ctx.fillRect(ox + p.x * k - 2, oy + p.y * k - 2, 4, 4);
    }
    if (latest) {
      for (const t of latest.tanks) {
        if (!t.alive) continue;
        ctx.fillStyle = FACTION_COLORS[t.faction];
        ctx.beginPath();
        ctx.arc(ox + t.x * k, oy + t.y * k, t.npc ? 2.5 : 3.5, 0, Math.PI * 2);
        ctx.fill();
        if (!t.npc) {
          ctx.font = '10px monospace';
          ctx.textAlign = 'center';
          ctx.fillText(t.handle, ox + t.x * k, oy + t.y * k - 6);
        }
      }
    }

    if (state.war) {
      const c = state.war.baseCounts;
      const total = TOTAL_BASES;
      const dawnPct = (c.dawn / total) * 100;
      const duskPct = (c.dusk / total) * 100;
      const histHtml = history
        .slice(0, 8)
        .map(
          (r) =>
            `<div>war ${r.warNumber}: <span class="f-${r.winner}">${FACTION_NAMES[r.winner]}</span> won in ${r.durationMinutes}m</div>`,
        )
        .join('');
      panel.innerHTML = `
        <h2>BOLO</h2>
        <div>${warLine(state.war)}</div>
        <div class="bar">
          <div class="dawn" style="width:${dawnPct}%"></div>
          <div class="neutral" style="width:${100 - dawnPct - duskPct}%"></div>
          <div class="dusk" style="width:${duskPct}%"></div>
        </div>
        <div>${latest ? `${latest.online.players} tank(s) crewed · ${latest.online.spectators} watching` : ''}</div>
        ${histHtml ? `<div style="margin-top:8px;color:var(--dim)">${histHtml}</div>` : ''}
        <a class="button-link" href="/">→ ENLIST</a>
      `;
    }
  }
  requestAnimationFrame(draw);
}
