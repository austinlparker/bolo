/**
 * Twin-stick touch controls, faithful to Bolo's fixed-gun tank:
 *  - LEFT stick drives: stick direction is the desired hull heading,
 *    magnitude is throttle.
 *  - RIGHT stick fights: it swings the hull toward the stick direction and
 *    holds fire once the gun bears (shells leave on the hull axis, exactly
 *    like the original — there is no independent turret).
 * While the right stick is engaged it owns steering; the left stick still
 * supplies throttle, so you can keep rolling through a turning firefight.
 */
import type { Net } from './net';
import type { GameState } from './state';

const SEND_MIN_INTERVAL = 90; // ms between input messages while steering
const EPSILON = 0.045;
const AIM_DEADZONE = 0.25;
const FIRE_DEFLECTION = 0.5; // push the stick past this to want fire
// Radians of hull error within which we actually shoot. 0.55 released
// shells up to ~31° off-axis — touch hit rate was 4% vs keyboard's 10%.
const FIRE_CONE = 0.32;
// Stop chasing sub-degree heading errors: the proportional controller runs
// against a 10Hz snapshot a round-trip stale, so without a deadband it
// oscillates around the target heading forever ("wobbly").
const TURN_DEADBAND = 0.07;

class Stick {
  x = 0;
  y = 0;
  private el: HTMLElement;
  private knob: HTMLElement;

  constructor(zoneId: string, baseId: string, knobId: string) {
    const zone = document.getElementById(zoneId)!;
    this.el = document.getElementById(baseId)!;
    this.knob = document.getElementById(knobId)!;
    let pointerId: number | null = null;

    const update = (ev: PointerEvent) => {
      const rect = this.el.getBoundingClientRect();
      const max = rect.width / 2;
      let dx = (ev.clientX - (rect.left + max)) / max;
      let dy = (ev.clientY - (rect.top + max)) / max;
      const mag = Math.hypot(dx, dy);
      if (mag > 1) {
        dx /= mag;
        dy /= mag;
      }
      this.x = dx;
      this.y = dy;
      this.knob.style.transform = `translate(${dx * max * 0.55}px, ${dy * max * 0.55}px)`;
    };
    const reset = () => {
      pointerId = null;
      this.x = 0;
      this.y = 0;
      this.knob.style.transform = 'translate(0px, 0px)';
      this.knob.classList.remove('hot');
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

  mag(): number {
    return Math.hypot(this.x, this.y);
  }

  angle(): number {
    return Math.atan2(this.y, this.x); // screen y-down matches world space
  }

  setHot(hot: boolean): void {
    this.knob.classList.toggle('hot', hot);
  }
}

export class TouchControls {
  private drive: Stick;
  private gun: Stick;
  private net: Net;
  private lastSent = { accel: 0, turn: 0, fire: false };
  private lastSentAt = 0;

  constructor(root: HTMLElement, net: Net) {
    this.net = net;
    root.insertAdjacentHTML(
      'beforeend',
      `
      <div id="touch-ui">
        <div id="joy-zone" class="stick-zone">
          <div id="joy-base" class="stick-base"><div id="joy-knob" class="stick-knob"></div></div>
        </div>
        <div id="aim-zone" class="stick-zone">
          <div id="aim-base" class="stick-base"><div id="aim-knob" class="stick-knob aim"></div></div>
        </div>
      </div>
    `,
    );
    this.drive = new Stick('joy-zone', 'joy-base', 'joy-knob');
    this.gun = new Stick('aim-zone', 'aim-base', 'aim-knob');
  }

  /** Called every animation frame; converts stick state into input messages. */
  tick(state: GameState, now: number): void {
    const me = state.you ? state.tanks.get(state.you.tankId)?.cur : undefined;
    if (!me) return;

    let accel = 0;
    let turn = 0;
    let fire = false;

    const driveMag = this.drive.mag();
    const gunMag = this.gun.mag();

    if (gunMag > AIM_DEADZONE) {
      // combat steering: swing the hull onto the gun stick's bearing
      const delta = angleDelta(me.dir, this.gun.angle());
      turn = Math.abs(delta) < TURN_DEADBAND ? 0 : Math.max(-1, Math.min(1, delta * 2.2));
      const wantFire = gunMag > FIRE_DEFLECTION;
      fire = wantFire && Math.abs(delta) < FIRE_CONE;
      this.gun.setHot(fire);
      // the left stick still supplies throttle mid-fight
      accel = driveMag > 0.18 ? Math.min(1, driveMag) : 0;
    } else if (driveMag > 0.18) {
      const delta = angleDelta(me.dir, this.drive.angle());
      turn = Math.abs(delta) < TURN_DEADBAND ? 0 : Math.max(-1, Math.min(1, delta * 2.4));
      // ease off the throttle when the target heading is behind us
      accel = Math.min(1, driveMag) * (Math.abs(delta) > 2.1 ? 0.25 : 1);
    }

    const fireChanged = fire !== this.lastSent.fire;
    const moved =
      Math.abs(accel - this.lastSent.accel) > EPSILON || Math.abs(turn - this.lastSent.turn) > EPSILON;
    const stopped =
      driveMag <= 0.18 && gunMag <= AIM_DEADZONE && (this.lastSent.accel !== 0 || this.lastSent.turn !== 0);

    if (fireChanged || stopped || (moved && now - this.lastSentAt > SEND_MIN_INTERVAL)) {
      this.lastSent = { accel, turn, fire };
      this.lastSentAt = now;
      this.net.send({
        t: 'input',
        accel: Math.round(accel * 100) / 100,
        turn: Math.round(turn * 100) / 100,
        fire,
      });
    }
  }
}

function angleDelta(from: number, to: number): number {
  let d = to - from;
  while (d > Math.PI) d -= 2 * Math.PI;
  while (d < -Math.PI) d += 2 * Math.PI;
  return d;
}

/** Coarse-pointer detection: phones/tablets, or hybrids being used by touch. */
export function isTouchDevice(): boolean {
  return (
    (typeof matchMedia === 'function' && matchMedia('(pointer: coarse)').matches) ||
    'ontouchstart' in window
  );
}
