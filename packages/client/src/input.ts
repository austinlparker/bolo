/** Keyboard + mouse -> protocol messages. Bolo-style held controls. */
import { type InputMsg, MAP_SIZE, SHELL_RANGE } from '@bolo/shared';
import type { Hud } from './hud';
import { TOOLS } from './hud';
import type { Net } from './net';
import type { Renderer } from './render';
import type { Sound } from './sound';
import type { GameState } from './state';

export interface KeyboardTuning {
  /** radians per fine-aim tap; see InputMsg.nudge */
  fineNudge: number;
  /** radians per shift+tap (finer for pixel-precise aiming) */
  fineNudgeShift: number;
  /** how fast turnValue ramps 0→1 per second (full lock in ~1/rate seconds) */
  turnRampRate: number;
  /** cruise units changed per second while W/S (throttle up/down) is held */
  throttleRate: number;
}

// fineNudge was 0.05 (~2.9°) but one tap drifted aim nearly half a tile at
// max gun range — playtest: "fine adjustment is too sensitive on keyboard".
export const DEFAULT_KEYBOARD_TUNING: KeyboardTuning = {
  fineNudge: 0.03,
  fineNudgeShift: 0.015,
  turnRampRate: 6,
  throttleRate: 1.3,
};

/** Live values; the dev tuning panel mutates this object in place. */
export const KEYBOARD_TUNING: KeyboardTuning = { ...DEFAULT_KEYBOARD_TUNING };

const TURN_KEYS: Record<string, -1 | 1> = { KeyA: -1, ArrowLeft: -1, KeyD: 1, ArrowRight: 1 };

export class Input {
  private held = new Set<string>();
  private last: InputMsg = { t: 'input', accel: 0, turn: 0, fire: false };
  /** persistent throttle (cruise) in [-1, 1]; W/S nudge it, it holds; X stops. */
  private cruise = 0;
  /** current fractional turn [-1, 1]; ramps toward target while a key is held */
  private turnValue = 0;
  private lastNow = 0;
  private gameState: GameState;
  private doSend!: () => void;
  /**
   * Re-send current control state. Input is change-driven, so after a
   * reconnect (the server seats a brand-new zero-input tank) a held key
   * would be ignored until physically re-pressed. Wired to net.onOpen.
   */
  resync!: () => void;

  constructor(net: Net, renderer: Renderer, hud: Hud, state: GameState, sound: Sound) {
    this.gameState = state;
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

    // turn is a ramping value: a quick tap yields a tiny rotation plus a nudge,
    // a hold ramps up to full-rate turn over ~167ms. The server's turn-accel
    // model smooths it further. No binary threshold or timer needed.
    const send = (nudge?: number) => {
      // accel is the held cruise level (integrated in tick), not momentary W/S
      const accel = Math.round(this.cruise * 100) / 100;
      const turn = Math.round(this.turnValue * 100) / 100;
      const fire = this.held.has('Space');
      const msg: InputMsg = { t: 'input', accel, turn, fire };
      // feed the prediction model so the client can dead-reckon your own
      // tank without waiting for the server round-trip
      this.gameState.recordInput(accel, turn, fire, nudge);
      const changed = msg.accel !== this.last.accel || msg.turn !== this.last.turn || msg.fire !== this.last.fire;
      if (changed || nudge !== undefined) {
        this.last = msg;
        if (nudge !== undefined) msg.nudge = nudge;
        net.send(msg);
      }
    };

    this.doSend = send;

    // NaN sentinel guarantees the next send differs (NaN !== anything), forcing
    // a resend of whatever is currently held even if the values are unchanged.
    this.resync = () => {
      this.last = { t: 'input', accel: NaN, turn: 0, fire: false };
      send();
    };

    addEventListener('keydown', (ev) => {
      if (document.activeElement === hud.chatInput) {
        // Enter submits via the chat form's native submit; only Escape here
        if (ev.code === 'Escape') hud.closeChat();
        return;
      }
      if (ev.code === 'Enter') {
        hud.openChat();
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
      if (ev.code === 'KeyN' && !ev.repeat) {
        hud.toggleNotes();
        return;
      }
      if (ev.code === 'Escape' && (hud.helpOpen() || hud.notesOpen())) {
        hud.toggleHelp(false);
        hud.toggleNotes(false);
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
      if (ev.code === 'KeyM' && !ev.repeat) {
        hud.showToast(sound.toggleMute() ? 'sound muted' : 'sound on', 1100);
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
      if (ev.code === 'KeyB' && !ev.repeat) {
        // bounty escalation: find the nearest bounty target tank in view
        const me = state.me();
        if (me?.alive) {
          let nearest: { did: string; dist: number } | null = null;
          for (const it of state.tanks.values()) {
            if (!it.cur.alive || it.cur.npc || it.cur.id === me.id) continue;
            if (!it.cur.bounty || !it.cur.did) continue;
            const dist = Math.hypot(it.cur.x - me.x, it.cur.y - me.y);
            if (!nearest || dist < nearest.dist) nearest = { did: it.cur.did, dist };
          }
          if (nearest) {
            net.send({ t: 'bounty', targetDid: nearest.did });
            hud.showToast('💰 bounty escalated (+1 reward)', 1500);
          } else {
            hud.showToast('no bounty target nearby', 1500);
          }
        }
        return;
      }
      if (ev.code === 'KeyX' && !ev.repeat) {
        this.cruise = 0; // emergency stop: zero the held throttle
        this.doSend();
        return;
      }
      if (ev.code === 'Space') ev.preventDefault();
      const dir = TURN_KEYS[ev.code];
      if (dir && !ev.repeat) {
        this.held.add(ev.code);
        // shift+tap = half the nudge for pixel-precise aiming
        const nudgeSize = ev.shiftKey ? KEYBOARD_TUNING.fineNudgeShift : KEYBOARD_TUNING.fineNudge;
        send(dir * nudgeSize); // instant fine tap; the ramp in tick() handles holds
        return;
      }
      this.held.add(ev.code);
      send();
    });

    addEventListener('keyup', (ev) => {
      this.held.delete(ev.code);
      // instant stop when all turn keys are released (matches server: release = instant)
      const left = this.held.has('KeyA') || this.held.has('ArrowLeft');
      const right = this.held.has('KeyD') || this.held.has('ArrowRight');
      if (!left && !right && this.turnValue !== 0) this.turnValue = 0;
      send();
    });

    addEventListener('blur', () => {
      this.held.clear();
      this.turnValue = 0;
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

  /**
   * Integrate throttle and turn each frame. Throttle (W/S) ramps the
   * persistent cruise up/down and it holds when released. Turn (A/D)
   * ramps from 0 toward ±1 — a quick tap yields a small rotation plus
   * the keydown nudge, a hold builds to full-rate turn. Death resets both.
   * Call from the render loop.
   */
  tick(now: number): void {
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    const me = this.gameState.me();
    if (!me || !me.alive) {
      if (this.cruise !== 0 || this.turnValue !== 0) {
        this.cruise = 0;
        this.turnValue = 0;
        this.doSend();
      }
      return;
    }
    // --- throttle: ramp cruise toward held direction ---
    const up = this.held.has('KeyW') || this.held.has('ArrowUp');
    const down = this.held.has('KeyS') || this.held.has('ArrowDown');
    const thrDir = (up ? 1 : 0) - (down ? 1 : 0);
    if (thrDir !== 0) {
      this.cruise = Math.max(-1, Math.min(1, this.cruise + thrDir * KEYBOARD_TUNING.throttleRate * dt));
      this.doSend();
    }
    // --- turn: ramp turnValue toward target (proportional control) ---
    const left = this.held.has('KeyA') || this.held.has('ArrowLeft');
    const right = this.held.has('KeyD') || this.held.has('ArrowRight');
    const targetTurn = (right ? 1 : 0) - (left ? 1 : 0);
    if (targetTurn === 0) {
      // no turn input (or both keys = cancel): instant stop
      if (this.turnValue !== 0) {
        this.turnValue = 0;
        this.doSend();
      }
    } else {
      // reversal restarts the ramp (matches server: instant on direction change)
      if (Math.sign(targetTurn) !== Math.sign(this.turnValue) && this.turnValue !== 0) {
        this.turnValue = 0;
      }
      const diff = targetTurn - this.turnValue;
      const step = KEYBOARD_TUNING.turnRampRate * dt;
      const newVal = Math.abs(diff) <= step ? targetTurn : this.turnValue + Math.sign(diff) * step;
      if (newVal !== this.turnValue) {
        this.turnValue = newVal;
        this.doSend();
      }
    }
  }
}
