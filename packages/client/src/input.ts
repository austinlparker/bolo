/** Keyboard + mouse -> protocol messages. Bolo-style held controls. */
import { type InputMsg, MAP_SIZE, SHELL_RANGE } from '@bolo/shared';
import type { Hud } from './hud';
import { TOOLS } from './hud';
import type { Net } from './net';
import type { Renderer } from './render';
import type { GameState } from './state';

/** One fine-aim tap turns this many radians (~2.9°); see InputMsg.nudge. */
const FINE_NUDGE = 0.05;
/** A turn key held longer than this becomes continuous full-rate turning. */
const HOLD_MS = 170;

const TURN_KEYS: Record<string, -1 | 1> = { KeyA: -1, ArrowLeft: -1, KeyD: 1, ArrowRight: 1 };

export class Input {
  private held = new Set<string>();
  private heldSince = new Map<string, number>();
  private last: InputMsg = { t: 'input', accel: 0, turn: 0, fire: false };

  constructor(net: Net, renderer: Renderer, hud: Hud, state: GameState) {
    // full-keyboard builder dispatch: G sends him to the gun cursor (where
    // your shells land), V builds on the tile under the tank
    const dispatchBuilder = (atCursor: boolean) => {
      const me = state.me();
      if (!me || !me.alive) return;
      const range = me.gunRange ?? SHELL_RANGE;
      const wx = atCursor ? me.x + Math.cos(me.dir) * range : me.x;
      const wy = atCursor ? me.y + Math.sin(me.dir) * range : me.y;
      const x = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(wx)));
      const y = Math.max(0, Math.min(MAP_SIZE - 1, Math.floor(wy)));
      net.send({ t: 'builder', order: hud.tool, x, y });
    };

    // a quick tap on a turn key is a precise nudge; only a real hold engages
    // continuous turning (otherwise one 10Hz server tick of full-rate turn
    // — 18° — is the smallest possible aim adjustment)
    const heldPast = (code: string) =>
      this.held.has(code) && performance.now() - (this.heldSince.get(code) ?? 0) >= HOLD_MS;

    const send = (nudge?: number) => {
      const accel = this.held.has('KeyW') || this.held.has('ArrowUp') ? 1 : this.held.has('KeyS') || this.held.has('ArrowDown') ? -1 : 0;
      const left = heldPast('KeyA') || heldPast('ArrowLeft');
      const right = heldPast('KeyD') || heldPast('ArrowRight');
      const turn = left && !right ? -1 : right && !left ? 1 : 0;
      const fire = this.held.has('Space');
      const msg: InputMsg = { t: 'input', accel, turn, fire };
      const changed = msg.accel !== this.last.accel || msg.turn !== this.last.turn || msg.fire !== this.last.fire;
      if (changed || nudge !== undefined) {
        this.last = msg;
        if (nudge !== undefined) msg.nudge = nudge;
        net.send(msg);
      }
    };

    addEventListener('keydown', (ev) => {
      if (document.activeElement === hud.chatInput) {
        if (ev.code === 'Enter') {
          const text = hud.chatInput.value.trim();
          if (text) net.send({ t: 'chat', text });
          hud.chatInput.value = '';
          hud.chatInput.style.display = 'none';
          hud.chatInput.blur();
        } else if (ev.code === 'Escape') {
          hud.chatInput.style.display = 'none';
          hud.chatInput.blur();
        }
        return;
      }
      if (ev.code === 'Enter') {
        hud.chatInput.style.display = 'block';
        hud.chatInput.focus();
        ev.preventDefault();
        return;
      }
      const tool = TOOLS.find((t) => ev.key === t.key);
      if (tool) {
        hud.setTool(tool.kind);
        return;
      }
      if (ev.code === 'KeyR') {
        net.send({ t: 'builder_recall' });
        return;
      }
      if (ev.code === 'KeyE') {
        hud.toggleEmotePicker();
        return;
      }
      if (ev.key === '?' || ev.code === 'F1') {
        hud.toggleHelp();
        ev.preventDefault();
        return;
      }
      if (ev.code === 'Escape' && hud.helpOpen()) {
        hud.toggleHelp(false);
        return;
      }
      // shift+up/down adjust gun range (trackpads have no back/forward
      // buttons); intercepted before held-state so accel doesn't engage.
      // repeats allowed: holding sweeps the range.
      if (ev.shiftKey && (ev.code === 'ArrowUp' || ev.code === 'KeyW' || ev.code === 'ArrowDown' || ev.code === 'KeyS')) {
        adjustRange(ev.code === 'ArrowUp' || ev.code === 'KeyW' ? 1 : -1);
        ev.preventDefault();
        return;
      }
      if (ev.code === 'KeyG' && !ev.repeat) {
        dispatchBuilder(true);
        return;
      }
      if (ev.code === 'KeyV' && !ev.repeat) {
        dispatchBuilder(false);
        return;
      }
      if (ev.code === 'Space') ev.preventDefault();
      const dir = TURN_KEYS[ev.code];
      if (dir && !ev.repeat) {
        this.held.add(ev.code);
        this.heldSince.set(ev.code, performance.now());
        send(dir * FINE_NUDGE); // instant fine tap...
        setTimeout(send, HOLD_MS + 10); // ...then full turn if still held
        return;
      }
      this.held.add(ev.code);
      send();
    });

    addEventListener('keyup', (ev) => {
      this.held.delete(ev.code);
      this.heldSince.delete(ev.code);
      send();
    });

    addEventListener('blur', () => {
      this.held.clear();
      this.heldSince.clear();
      send();
    });

    // mouse back/forward adjust GUN RANGE (classic Bolo range control: lob
    // shells short of walls, or reach back out to max) instead of navigating
    // browser history away from the war. The server clamps to [1, SHELL_RANGE].
    const RANGE_STEP = 0.5;
    const adjustRange = (dir: 1 | -1) => {
      const cur = state.me()?.gunRange ?? SHELL_RANGE;
      const next = Math.max(1, Math.min(SHELL_RANGE, Math.round((cur + dir * RANGE_STEP) * 2) / 2));
      net.send({ t: 'range', range: next });
      hud.showToast(`gun range ${next} / ${SHELL_RANGE}`, 1100);
    };
    addEventListener('mousedown', (ev) => {
      if (ev.button === 3 || ev.button === 4) ev.preventDefault();
    });
    addEventListener('mouseup', (ev) => {
      if (ev.button === 3) {
        ev.preventDefault();
        adjustRange(-1);
      } else if (ev.button === 4) {
        ev.preventDefault();
        adjustRange(1);
      }
    });

    // tap/click on the battlefield dispatches the builder with the selected
    // tool. Pointer events cover mouse and touch alike; a "tap" is a short
    // press without much movement (so stray drags don't send the poor man
    // marching anywhere).
    let downAt = 0;
    let downX = 0;
    let downY = 0;
    renderer.canvas.addEventListener('pointerdown', (ev) => {
      downAt = performance.now();
      downX = ev.clientX;
      downY = ev.clientY;
    });
    renderer.canvas.addEventListener('pointerup', (ev) => {
      const quick = performance.now() - downAt < 350;
      const still = Math.hypot(ev.clientX - downX, ev.clientY - downY) < 12;
      if (!quick || !still) return;
      // on touch devices a tool must be explicitly armed first (via the ⚒
      // button) so casual taps don't send the builder marching
      const mobile = document.body.classList.contains('touch-mode');
      const order = mobile ? hud.takeArmedTool() : hud.tool;
      if (!order) return;
      const [wx, wy] = renderer.screenToWorld(ev.clientX, ev.clientY);
      net.send({ t: 'builder', order, x: Math.floor(wx), y: Math.floor(wy) });
    });
  }
}
