/** Keyboard + mouse -> protocol messages. Bolo-style held controls. */
import { angleDelta, type InputMsg, MAP_SIZE, SHELL_RANGE, TANK_TURN_ACCEL, TANK_TURN_RATE } from '@bolo/shared';
import type { Hud } from './hud';
import { TOOLS } from './hud';
import type { Net } from './net';
import type { Renderer } from './render';
import type { Sound } from './sound';
import type { GameState } from './state';

export interface KeyboardTuning {
  /** radians per fine-aim tap (applied directly to heading) */
  fineNudge: number;
  /** radians per shift+tap (finer for pixel-precise aiming) */
  fineNudgeShift: number;
  /** how fast the turn ramp builds 0→1 per second (used by the /rig dev tool) */
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
  private last: InputMsg = { t: 'input', accel: 0, dir: 0, fire: false };
  /** persistent throttle (cruise) in [-1, 1]; W/S nudge it, it holds; X stops. */
  private cruise = 0;
  /** client-authoritative heading in radians [-π, π] */
  private myDir = 0;
  /** current turn rate (rad/s); ramps toward target while a key is held */
  private turnSpeed = 0;
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

    // heading is client-authoritative: the Input class integrates dir locally
    // (ramping turnSpeed using the same constants as the server's NPC model)
    // and sends the absolute heading. No nudge queue — taps modify myDir
    // directly.
    const send = () => {
      const accel = Math.round(this.cruise * 100) / 100;
      const fire = this.held.has('Space');
      this.gameState.recordInput(accel, this.myDir, fire);
      const dir = Math.round(this.myDir * 100) / 100;
      const changed = accel !== this.last.accel || dir !== this.last.dir || fire !== this.last.fire;
      if (changed) {
        this.last = { t: 'input', accel, dir, fire };
        net.send(this.last);
      }
    };

    this.doSend = send;

    // NaN sentinel guarantees the next send differs (NaN !== anything), forcing
    // a resend of whatever is currently held even if the values are unchanged.
    this.resync = () => {
      this.last = { t: 'input', accel: NaN, dir: 0, fire: false };
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
        this.myDir += dir * nudgeSize; // instant fine tap applied directly to heading
        if (this.myDir > Math.PI) this.myDir -= 2 * Math.PI;
        else if (this.myDir < -Math.PI) this.myDir += 2 * Math.PI;
        send();
        return;
      }
      this.held.add(ev.code);
      send();
    });

    addEventListener('keyup', (ev) => {
      this.held.delete(ev.code);
      // instant stop when all turn keys are released (matches old server: release = instant)
      const left = this.held.has('KeyA') || this.held.has('ArrowLeft');
      const right = this.held.has('KeyD') || this.held.has('ArrowRight');
      if (!left && !right && this.turnSpeed !== 0) this.turnSpeed = 0;
      send();
    });

    addEventListener('blur', () => {
      this.held.clear();
      this.turnSpeed = 0;
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
   * ramps turnSpeed toward ±TANK_TURN_RATE and integrates into myDir —
   * a quick tap yields a small rotation (from the keydown nudge), a
   * hold builds to full-rate turn. Death resets cruise and turnSpeed
   * but NOT myDir (it holds position). Call from the render loop.
   */
  tick(now: number): void {
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;
    const me = this.gameState.me();
    if (!me || !me.alive) {
      if (this.cruise !== 0 || this.turnSpeed !== 0) {
        this.cruise = 0;
        this.turnSpeed = 0;
        this.doSend();
      }
      return;
    }
    // sync myDir from server on large divergence (respawn/teleport)
    if (Math.abs(angleDelta(this.myDir, me.dir)) > 0.15) {
      this.myDir = me.dir;
    }
    // --- throttle: ramp cruise toward held direction ---
    const up = this.held.has('KeyW') || this.held.has('ArrowUp');
    const down = this.held.has('KeyS') || this.held.has('ArrowDown');
    const thrDir = (up ? 1 : 0) - (down ? 1 : 0);
    if (thrDir !== 0) {
      this.cruise = Math.max(-1, Math.min(1, this.cruise + thrDir * KEYBOARD_TUNING.throttleRate * dt));
    }
    // --- turn: ramp turnSpeed and integrate into myDir (same mass model as NPC) ---
    const left = this.held.has('KeyA') || this.held.has('ArrowLeft');
    const right = this.held.has('KeyD') || this.held.has('ArrowRight');
    const targetTurn = (right ? 1 : 0) - (left ? 1 : 0);
    if (targetTurn === 0) {
      if (this.turnSpeed !== 0) this.turnSpeed = 0;
    } else {
      const targetRate = targetTurn * TANK_TURN_RATE;
      // reversal restarts the ramp (instant on direction change)
      if (Math.sign(targetRate) !== Math.sign(this.turnSpeed) && this.turnSpeed !== 0) {
        this.turnSpeed = 0;
      }
      if (Math.abs(targetRate) <= Math.abs(this.turnSpeed)) {
        this.turnSpeed = targetRate;
      } else {
        this.turnSpeed = targetRate > 0
          ? Math.min(targetRate, this.turnSpeed + TANK_TURN_ACCEL * dt)
          : Math.max(targetRate, this.turnSpeed - TANK_TURN_ACCEL * dt);
      }
    }
    // integrate turn into heading
    if (this.turnSpeed !== 0) {
      this.myDir += this.turnSpeed * dt;
      if (this.myDir > Math.PI) this.myDir -= 2 * Math.PI;
      else if (this.myDir < -Math.PI) this.myDir += 2 * Math.PI;
    }
    // send whenever throttle or turn is active (send() only network-sends on changed values)
    if (thrDir !== 0 || this.turnSpeed !== 0) {
      this.doSend();
    }
  }
}
