/**
 * Touch controls: a fixed virtual joystick (left thumb) that steers the tank
 * toward the stick's world direction — magnitude is throttle — plus a
 * hold-to-fire button (right thumb). Uses the protocol's analog input range.
 *
 * Steering model: rather than tank-relative turn keys, the stick points
 * where you want to go; we compute the turn from the tank's current heading
 * each frame and throttle down while the target is behind us.
 */
import type { Net } from './net';
import type { GameState } from './state';

const SEND_MIN_INTERVAL = 90; // ms between input messages while steering
const EPSILON = 0.045;

export class TouchControls {
  private joyX = 0; // -1..1, screen space
  private joyY = 0;
  private firing = false;
  private net: Net;
  private lastSent = { accel: 0, turn: 0, fire: false };
  private lastSentAt = 0;
  private el: HTMLElement;

  constructor(root: HTMLElement, net: Net) {
    this.net = net;
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div id="touch-ui">
        <div id="joy-zone">
          <div id="joy-base"><div id="joy-knob"></div></div>
        </div>
        <div id="fire-btn">⊕<span>FIRE</span></div>
      </div>
    `,
    );
    this.el = document.getElementById('touch-ui')!;
    this.bindJoystick();
    this.bindFire();
  }

  private bindJoystick(): void {
    const zone = document.getElementById('joy-zone')!;
    const base = document.getElementById('joy-base')!;
    const knob = document.getElementById('joy-knob')!;
    let pointerId: number | null = null;

    const update = (ev: PointerEvent) => {
      const rect = base.getBoundingClientRect();
      const cx = rect.left + rect.width / 2;
      const cy = rect.top + rect.height / 2;
      const max = rect.width / 2;
      let dx = (ev.clientX - cx) / max;
      let dy = (ev.clientY - cy) / max;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) {
        dx /= mag;
        dy /= mag;
      }
      this.joyX = dx;
      this.joyY = dy;
      knob.style.transform = `translate(${dx * max * 0.55}px, ${dy * max * 0.55}px)`;
    };
    const reset = () => {
      pointerId = null;
      this.joyX = 0;
      this.joyY = 0;
      knob.style.transform = 'translate(0px, 0px)';
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

  private bindFire(): void {
    const btn = document.getElementById('fire-btn')!;
    btn.addEventListener('pointerdown', (ev) => {
      this.firing = true;
      btn.classList.add('held');
      btn.setPointerCapture(ev.pointerId);
      ev.preventDefault();
    });
    const off = () => {
      this.firing = false;
      btn.classList.remove('held');
    };
    btn.addEventListener('pointerup', off);
    btn.addEventListener('pointercancel', off);
  }

  /** Called every animation frame; converts stick state into input messages. */
  tick(state: GameState, now: number): void {
    const me = state.you ? state.tanks.get(state.you.tankId)?.cur : undefined;
    if (!me) return;

    let accel = 0;
    let turn = 0;
    const mag = Math.hypot(this.joyX, this.joyY);
    if (mag > 0.18) {
      const want = Math.atan2(this.joyY, this.joyX); // screen y-down matches world
      let delta = want - me.dir;
      while (delta > Math.PI) delta -= 2 * Math.PI;
      while (delta < -Math.PI) delta += 2 * Math.PI;
      turn = Math.max(-1, Math.min(1, delta * 2.4));
      // ease off the throttle when the target heading is behind us
      accel = Math.min(1, mag) * (Math.abs(delta) > 2.1 ? 0.25 : 1);
    }

    const fireChanged = this.firing !== this.lastSent.fire;
    const moved =
      Math.abs(accel - this.lastSent.accel) > EPSILON || Math.abs(turn - this.lastSent.turn) > EPSILON;
    const stopped = mag <= 0.18 && (this.lastSent.accel !== 0 || this.lastSent.turn !== 0);

    if (fireChanged || stopped || (moved && now - this.lastSentAt > SEND_MIN_INTERVAL)) {
      this.lastSent = { accel, turn, fire: this.firing };
      this.lastSentAt = now;
      this.net.send({
        t: 'input',
        accel: Math.round(accel * 100) / 100,
        turn: Math.round(turn * 100) / 100,
        fire: this.firing,
      });
    }
  }
}

/** Coarse-pointer detection: phones/tablets, or hybrids being used by touch. */
export function isTouchDevice(): boolean {
  return (
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window
  );
}
