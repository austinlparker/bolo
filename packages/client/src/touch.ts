/**
 * Mobile controls, split into separate surfaces so throttle and turn never
 * fight each other:
 *  - LEFT: a spring THROTTLE. Push up to accelerate, down to slow/reverse;
 *    the knob springs back to center on release but the SET SPEED holds (it's
 *    a cruise setting, not a momentary drive). A fill shows the current
 *    throttle. We send `accel` as a target-speed fraction the sim cruises to.
 *  - RIGHT: a TURN stick (◀▶ steer / pivot, spring-center) plus a separate
 *    FIRE button.
 * Build / chat / emote live in a center strip; the menu is ⋯ by the minimap.
 */
import { angleDelta, TANK_TURN_ACCEL, TANK_TURN_RATE } from '@bolo/shared';
import type { Net } from './net';
import type { GameState } from './state';

const SEND_MIN_INTERVAL = 90; // ms between input messages while adjusting
const EPSILON = 0.04;

export interface TouchTuning {
  /** throttle-stick deflection below which it reads zero */
  deadzone: number;
  /** cruise units changed per second at full throttle deflection */
  throttleRate: number;
  /** turn-stick deflection below which it reads zero (the straight channel) */
  turnDeadzone: number;
  /** scales turn after the deadzone + ease curve (1 = full lock at the edge) */
  turnGain: number;
}

export const DEFAULT_TOUCH_TUNING: TouchTuning = {
  deadzone: 0.15,
  throttleRate: 1.3,
  turnDeadzone: 0.2,
  turnGain: 1,
};

/** Live values; the dev tuning panel mutates this object in place. */
export const TOUCH_TUNING: TouchTuning = { ...DEFAULT_TOUCH_TUNING };

/** Deadzone + rescale so motion ramps from 0 just past the threshold. */
function axis(v: number, dz: number): number {
  const a = Math.abs(v);
  if (a < dz) return 0;
  return Math.sign(v) * ((a - dz) / (1 - dz));
}

function clamp1(v: number): number {
  return Math.max(-1, Math.min(1, v));
}

/** A draggable knob in a base; reports per-axis deflection in [-1, 1]. */
class Stick {
  x = 0;
  y = 0;
  private base: HTMLElement;
  private knob: HTMLElement;

  constructor(zoneId: string, baseId: string, knobId: string, axis: 'both' | 'vertical' | 'horizontal' = 'both') {
    const zone = document.getElementById(zoneId)!;
    this.base = document.getElementById(baseId)!;
    this.knob = document.getElementById(knobId)!;
    let pointerId: number | null = null;

    const update = (ev: PointerEvent) => {
      const rect = this.base.getBoundingClientRect();
      const maxX = rect.width / 2;
      const maxY = rect.height / 2;
      // per-axis (not vector) so a tall throttle reads its full vertical travel
      this.x = Math.max(-1, Math.min(1, (ev.clientX - (rect.left + maxX)) / maxX));
      this.y = Math.max(-1, Math.min(1, (ev.clientY - (rect.top + maxY)) / maxY));
      // a single-axis control ignores (and doesn't visually drift on) the other
      if (axis === 'vertical') this.x = 0;
      if (axis === 'horizontal') this.y = 0;
      this.knob.style.transform = `translate(${this.x * maxX * 0.5}px, ${this.y * maxY * 0.5}px)`;
    };
    const reset = () => {
      pointerId = null;
      this.x = 0;
      this.y = 0;
      this.knob.style.transform = 'translate(0px, 0px)';
    };

    zone.addEventListener('pointerdown', (ev) => {
      pointerId = ev.pointerId;
      zone.setPointerCapture(ev.pointerId);
      update(ev);
      ev.preventDefault();
    });
    zone.addEventListener('pointermove', (ev) => {
      if (ev.pointerId === pointerId) update(ev);
    });
    zone.addEventListener('pointerup', (ev) => {
      if (ev.pointerId === pointerId) reset();
    });
    zone.addEventListener('pointercancel', (ev) => {
      if (ev.pointerId === pointerId) reset();
    });
  }
}

export class TouchControls {
  private throttle: Stick;
  private turn: Stick;
  private fill: HTMLElement;
  private fireBtn: HTMLElement;
  private fireHeld = false;
  private net: Net;
  /** persistent cruise setting in [-1, 1]; the throttle nudges it, it holds */
  private cruise = 0;
  /** client-authoritative heading in radians [-π, π] */
  private myDir = 0;
  /** current turn rate (rad/s); ramps toward stick target */
  private turnSpeed = 0;
  private lastNow = 0;
  private throttleWasActive = false;
  private turnWasActive = false;
  private lastSent = { accel: 0, dir: 0, fire: false };
  private lastSentAt = 0;

  constructor(root: HTMLElement, net: Net) {
    this.net = net;
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div id="touch-ui">
        <div id="throttle-zone" class="stick-zone">
          <div id="throttle-base" class="stick-base">
            <div id="throttle-fill"></div>
            <div id="throttle-mark"></div>
            <div id="throttle-knob" class="stick-knob"></div>
          </div>
        </div>
        <div id="turn-zone" class="stick-zone">
          <div id="turn-base" class="stick-base"><div id="turn-knob" class="stick-knob"></div></div>
        </div>
        <div id="stop-btn">STOP</div>
        <div id="fire-btn"><span>FIRE</span></div>
      </div>
    `,
    );
    this.throttle = new Stick('throttle-zone', 'throttle-base', 'throttle-knob', 'vertical');
    this.turn = new Stick('turn-zone', 'turn-base', 'turn-knob', 'horizontal');
    this.fill = document.getElementById('throttle-fill')!;
    this.fireBtn = document.getElementById('fire-btn')!;

    const setFire = (held: boolean) => {
      this.fireHeld = held;
      this.fireBtn.classList.toggle('hot', held);
    };
    this.fireBtn.addEventListener('pointerdown', (ev) => {
      this.fireBtn.setPointerCapture(ev.pointerId);
      setFire(true);
      ev.preventDefault();
    });
    for (const end of ['pointerup', 'pointercancel', 'pointerleave'] as const) {
      this.fireBtn.addEventListener(end, () => setFire(false));
    }

    const stopBtn = document.getElementById('stop-btn')!;
    stopBtn.addEventListener('pointerdown', (ev) => {
      this.cruise = 0;
      this.renderFill();
      this.lastSentAt = 0; // bypass the send throttle so the stop lands now
      ev.preventDefault();
    });
  }

  /** Called every animation frame; integrates the throttle, reads turn+fire. */
  tick(state: GameState, now: number): void {
    const dt = this.lastNow ? Math.min(0.1, (now - this.lastNow) / 1000) : 0;
    this.lastNow = now;

    const me = state.you ? state.tanks.get(state.you.tankId)?.cur : undefined;
    const t = TOUCH_TUNING;

    // throttle: push up (negative y) accelerates; the cruise value holds when
    // the stick is released, so you set a speed and let go.
    const thr = axis(-this.throttle.y, t.deadzone);
    if (thr !== 0) this.cruise = clamp1(this.cruise + thr * t.throttleRate * dt);
    // a fresh spawn (or death) resets the held speed so you don't rocket off
    if (!me || !me.alive) {
      this.cruise = 0;
      this.turnSpeed = 0;
    }
    this.renderFill();

    if (!me) return;

    // sync myDir from server only on genuine respawn/teleport (large heading
    // jump). Normal turning divergence from latency must not trigger a snap.
    if (Math.abs(angleDelta(this.myDir, me.dir)) > Math.PI / 2) this.myDir = me.dir;

    const accel = Math.round(this.cruise * 100) / 100;
    // turn: ease-in past a wider deadzone so a near-centered stick holds straight
    const tx = axis(this.turn.x, t.turnDeadzone);
    const targetRate = clamp1(Math.sign(tx) * tx * tx * t.turnGain) * TANK_TURN_RATE;
    // ramp turnSpeed toward target (same mass model as keyboard)
    if (targetRate === 0) {
      this.turnSpeed = 0;
    } else {
      if (Math.sign(targetRate) !== Math.sign(this.turnSpeed) && this.turnSpeed !== 0) this.turnSpeed = 0;
      if (Math.abs(targetRate) <= Math.abs(this.turnSpeed)) {
        this.turnSpeed = targetRate;
      } else {
        this.turnSpeed = targetRate > 0
          ? Math.min(targetRate, this.turnSpeed + TANK_TURN_ACCEL * dt)
          : Math.max(targetRate, this.turnSpeed - TANK_TURN_ACCEL * dt);
      }
    }
    // integrate turn into heading
    this.myDir += this.turnSpeed * dt;
    if (this.myDir > Math.PI) this.myDir -= 2 * Math.PI;
    else if (this.myDir < -Math.PI) this.myDir += 2 * Math.PI;

    const fire = this.fireHeld;
    const dir = Math.round(this.myDir * 100) / 100;

    // Feed the prediction model EVERY FRAME so the rendered heading tracks the
    // smooth per-frame turn integration. The network send below is throttled
    // to SEND_MIN_INTERVAL — if recordInput only fired there, the displayed
    // heading would freeze between sends and turning would look stepped/choppy.
    // (This is exactly why keyboard turning is smooth: Input.tick calls
    // recordInput each frame, gated only on activity.)
    state.recordInput(accel, this.myDir, fire);

    const throttleActive = thr !== 0;
    const turnActive = this.turnSpeed !== 0;
    const fireChanged = fire !== this.lastSent.fire;
    const moved =
      Math.abs(accel - this.lastSent.accel) > EPSILON || Math.abs(dir - this.lastSent.dir) > EPSILON;
    // when a control settles back to neutral, push the final value once so the
    // server's sticky input lands exactly on the held cruise / heading
    const settled =
      (this.throttleWasActive && !throttleActive) || (this.turnWasActive && !turnActive);
    this.throttleWasActive = throttleActive;
    this.turnWasActive = turnActive;

    if (fireChanged || settled || (moved && now - this.lastSentAt > SEND_MIN_INTERVAL)) {
      this.lastSent = { accel, dir, fire };
      this.lastSentAt = now;
      this.net.send({ t: 'input', accel, dir, fire });
    }
  }

  /** Force the next tick to resend (held cruise/heading/fire) after a reconnect. */
  resync(): void {
    this.lastSent = { accel: NaN, dir: 0, fire: false };
    this.lastSentAt = 0;
  }

  /** Paint the cruise gauge: fill grows up from center for forward, down for reverse. */
  private renderFill(): void {
    const c = this.cruise;
    const half = 50; // percent of the track each direction
    if (c >= 0) {
      this.fill.style.top = `${50 - c * half}%`;
      this.fill.style.height = `${c * half}%`;
      this.fill.style.background = 'linear-gradient(#7fd07f, #3f9a3f)';
    } else {
      this.fill.style.top = '50%';
      this.fill.style.height = `${-c * half}%`;
      this.fill.style.background = 'linear-gradient(#d08a4f, #9a5f2f)';
    }
  }
}

/** Coarse-pointer detection: phones/tablets, or hybrids being used by touch.
 * `?touch` forces it on, for testing the mobile UI from a desktop browser. */
export function isTouchDevice(): boolean {
  return (
    (typeof location !== 'undefined' && new URLSearchParams(location.search).has('touch')) ||
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window
  );
}
