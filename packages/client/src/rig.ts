/**
 * Control-feel rig (dev-only, /rig): four sandboxed copies of the REAL
 * server sim running side by side in the browser, each with a different
 * tank-handling variant, all driven by the same keyboard input at the same
 * 10Hz tick the production Durable Object uses (optionally with simulated
 * input latency). Drive all four at once and feel the difference directly.
 *
 *  - WASD / arrows + space, with the production tap-to-nudge keyboard model
 *  - pane buttons: ★ promotes a variant to baseline, ⟳ re-mutates a pane
 *    around the baseline; "copy baseline" exports the winner as JSON for
 *    constants.ts
 *  - each pane shows probe metrics (0→95% speed, 90° turn, stop distance)
 *    measured by scripted runs of the same sim
 *
 * The arena is a flattened quadrant of a real island: open road straights
 * to the west, a wall slalom north, swamp east, forest south — terrain
 * transitions are half of how handling feels.
 */
import {
  DEFAULT_TANK_TUNING,
  DT,
  idx,
  MineState,
  type TankTuning,
  TANK_TUNING_SPEC,
  Terrain,
  TICK_MS,
} from '@bolo/shared';
import { type TankInput, World } from '../../server/src/sim/world';
import type { Tank } from '@bolo/shared';
import { KEYBOARD_TUNING } from './input';

const ARENA_C = 128; // arena center tile
const ARENA_R = 22; // arena radius in tiles
const SCALE = 13; // px per tile
const TRAIL_LEN = 240;

interface Pane {
  name: string;
  tuning: TankTuning;
  world: World;
  tank: Tank;
  canvas: HTMLCanvasElement;
  header: HTMLElement;
  trail: { x: number; y: number }[];
  prev: { x: number; y: number; dir: number };
  cur: { x: number; y: number; dir: number };
}

const TERRAIN_COLORS: Partial<Record<Terrain, string>> = {
  [Terrain.Grass]: '#2e4a2e',
  [Terrain.Road]: '#6b6b66',
  [Terrain.Building]: '#8a8a96',
  [Terrain.ShotBuilding]: '#5b5b66',
  [Terrain.Forest]: '#1d3a22',
  [Terrain.Swamp]: '#3a3d28',
  [Terrain.River]: '#27465e',
  [Terrain.DeepSea]: '#16283c',
  [Terrain.Crater]: '#46392f',
  [Terrain.Rubble]: '#4a443c',
};

/** Hand-built proving ground stamped over the generated island. */
function buildArena(world: World): void {
  const lo = ARENA_C - ARENA_R;
  const hi = ARENA_C + ARENA_R;
  for (let y = lo; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      world.terrain[idx(x, y)] = Terrain.Grass;
      world.mines[idx(x, y)] = MineState.None;
    }
  }
  // road cross through the center — full-speed reference straights
  for (let x = lo; x <= hi; x++) world.terrain[idx(x, ARENA_C)] = Terrain.Road;
  for (let y = lo; y <= hi; y++) world.terrain[idx(ARENA_C, y)] = Terrain.Road;
  // north: wall slalom (alternating gates)
  for (let i = 0; i < 5; i++) {
    const gy = ARENA_C - 6 - i * 3;
    for (let x = lo + 2; x <= hi - 2; x++) {
      if (Math.abs(x - (ARENA_C + (i % 2 === 0 ? -4 : 4))) < 3) continue; // the gate
      if (x === ARENA_C) continue; // keep the road open
      world.terrain[idx(x, gy)] = Terrain.Building;
    }
  }
  // east: swamp slog; south: forest weave
  for (let y = lo; y <= hi; y++) {
    for (let x = ARENA_C + 8; x <= hi; x++) {
      if (y !== ARENA_C && x !== ARENA_C) world.terrain[idx(x, y)] = Terrain.Swamp;
    }
  }
  for (let y = ARENA_C + 8; y <= hi; y++) {
    for (let x = lo; x <= hi; x++) {
      if (y !== ARENA_C && x !== ARENA_C) world.terrain[idx(x, y)] = Terrain.Forest;
    }
  }
  // the rig has no war in it
  world.bases.length = 0;
  world.pills.length = 0;
}

function makePaneWorld(tuning: TankTuning): { world: World; tank: Tank } {
  const world = new World(1, 7);
  Object.assign(world.tuning, tuning);
  buildArena(world);
  const tank = world.addTank('did:rig', 'rig', 'dawn', false);
  tank.x = ARENA_C + 0.5;
  tank.y = ARENA_C + 0.5;
  tank.dir = 0;
  tank.speed = 0;
  return { world, tank };
}

// ---------- variants ----------

function mutate(base: TankTuning): TankTuning {
  const out = { ...base };
  for (const key of Object.keys(TANK_TUNING_SPEC) as (keyof TankTuning)[]) {
    if (key === 'fireCooldown' || key === 'shellSpeed') continue; // handling only
    const spec = TANK_TUNING_SPEC[key];
    const jittered = base[key] * (1 + (Math.random() * 2 - 1) * 0.3);
    out[key] = Math.min(spec.max, Math.max(spec.min, Math.round(jittered / spec.step) * spec.step));
  }
  return out;
}

const PRESETS: { name: string; tweak: Partial<TankTuning> }[] = [
  { name: 'baseline', tweak: {} },
  { name: 'snappy', tweak: { accel: 9, accelCurve: 0.35, turnRate: 3.6, turnAccel: 16 } },
  { name: 'heavy', tweak: { accel: 4.5, accelCurve: 0.75, turnRate: 2.8, turnAccel: 6, brake: 12 } },
  { name: 'arcade', tweak: { accel: 12, accelCurve: 0, turnRate: 4.2, turnAccel: 40 } },
];

// ---------- probe metrics ----------

interface Metrics {
  to95: number; // seconds, standstill -> 95% of road top speed
  turn90: number; // seconds, standstill -> 90° heading change
  stop: number; // tiles, full road speed -> halt
}

function probe(tuning: TankTuning): Metrics {
  const { world, tank } = makePaneWorld(tuning);
  // place on the west road straight, pointed east along it
  tank.x = ARENA_C - ARENA_R + 1.5;
  tank.y = ARENA_C + 0.5;
  tank.dir = 0;

  const run = (input: TankInput, done: () => boolean, cap = 200): number => {
    let ticks = 0;
    world.setInput(tank.id, input);
    while (!done() && ticks < cap) {
      world.doTick(0);
      ticks++;
    }
    return ticks;
  };

  const to95 = run({ accel: 1, turn: 0, fire: false }, () => tank.speed >= tuning.maxSpeed * 0.95) * DT;

  const stopFrom = tank.x;
  run({ accel: -1, turn: 0, fire: false }, () => tank.speed <= 0);
  const stop = tank.x - stopFrom;

  tank.speed = 0;
  const dir0 = tank.dir;
  const turn90 = run({ accel: 0, turn: 1, fire: false }, () => Math.abs(tank.dir - dir0) >= Math.PI / 2) * DT;

  return { to95, turn90, stop };
}

// ---------- the rig ----------

export function startRig(root: HTMLElement): void {
  document.title = 'ATBOLO control rig';
  root.innerHTML = `
    <style>
      #rig { display: flex; flex-direction: column; height: 100vh; background: #0d0f14; color: #c7cdd9; font: 12px monospace; }
      #rig-bar { display: flex; gap: 12px; align-items: center; padding: 6px 10px; border-bottom: 1px solid #232838; flex-wrap: wrap; }
      #rig-bar .hint { color: #707a8c; }
      #rig-grid { flex: 1; display: grid; grid-template-columns: 1fr 1fr; grid-template-rows: 1fr 1fr; gap: 6px; padding: 6px; min-height: 0; }
      .pane { display: flex; flex-direction: column; border: 1px solid #232838; border-radius: 6px; overflow: hidden; min-height: 0; }
      .pane header { display: flex; gap: 8px; align-items: baseline; padding: 3px 8px; background: #14161c; flex-wrap: wrap; }
      .pane header .nm { color: #e8b44c; font-weight: bold; }
      .pane header .metrics { color: #8fd18f; }
      .pane header .diff { color: #9aa3b2; }
      .pane canvas { flex: 1; min-height: 0; width: 100%; }
      .pane button, #rig-bar button, #rig-bar select { background: #232838; color: #c7cdd9; border: 1px solid #333a48; border-radius: 4px; font: 11px monospace; padding: 1px 7px; cursor: pointer; }
    </style>
    <div id="rig">
      <div id="rig-bar">
        <b>CONTROL RIG</b>
        <span class="hint">WASD/arrows drive all four tanks · tap a turn key to fine-nudge · space fires</span>
        <label>input latency <select id="rig-latency">
          <option value="0">0 ms</option><option value="50" selected>50 ms</option>
          <option value="100">100 ms</option><option value="150">150 ms</option>
        </select></label>
        <button id="rig-mutate-all">⟳ mutate all around baseline</button>
        <button id="rig-copy">copy baseline json</button>
        <span id="rig-copied" class="hint"></span>
      </div>
      <div id="rig-grid"></div>
    </div>`;

  const grid = root.querySelector('#rig-grid')!;
  let baseline: TankTuning = { ...DEFAULT_TANK_TUNING };
  const panes: Pane[] = [];

  const diffString = (t: TankTuning): string => {
    const parts: string[] = [];
    for (const key of Object.keys(TANK_TUNING_SPEC) as (keyof TankTuning)[]) {
      if (t[key] !== baseline[key]) parts.push(`${key} ${baseline[key]}→${t[key]}`);
    }
    return parts.length ? parts.join(' · ') : 'baseline';
  };

  const setPaneTuning = (pane: Pane, name: string, tuning: TankTuning): void => {
    pane.name = name;
    pane.tuning = tuning;
    const { world, tank } = makePaneWorld(tuning);
    pane.world = world;
    pane.tank = tank;
    pane.trail = [];
    pane.prev = pane.cur = { x: tank.x, y: tank.y, dir: tank.dir };
    const m = probe(tuning);
    pane.header.innerHTML =
      `<span class="nm">${name}</span>` +
      `<span class="metrics">0→95%: ${m.to95.toFixed(1)}s · 90°: ${m.turn90.toFixed(1)}s · stop: ${m.stop.toFixed(1)} tiles</span>` +
      `<span class="diff">${diffString(tuning)}</span>`;
    const star = document.createElement('button');
    star.textContent = '★ baseline';
    star.title = 'promote this variant to baseline';
    star.addEventListener('click', () => {
      baseline = { ...pane.tuning };
      setPaneTuning(panes[0], 'baseline', { ...baseline });
      for (let i = 1; i < panes.length; i++) setPaneTuning(panes[i], `mutant ${i}`, mutate(baseline));
    });
    const reroll = document.createElement('button');
    reroll.textContent = '⟳';
    reroll.title = 're-mutate this pane around the baseline';
    reroll.addEventListener('click', () => setPaneTuning(pane, pane.name, mutate(baseline)));
    pane.header.append(star, reroll);
  };

  for (const preset of PRESETS) {
    const el = document.createElement('div');
    el.className = 'pane';
    const header = document.createElement('header');
    const canvas = document.createElement('canvas');
    el.append(header, canvas);
    grid.appendChild(el);
    const pane = { header, canvas } as Pane;
    panes.push(pane);
    setPaneTuning(pane, preset.name, { ...DEFAULT_TANK_TUNING, ...preset.tweak });
  }

  root.querySelector('#rig-mutate-all')!.addEventListener('click', () => {
    for (let i = 1; i < panes.length; i++) setPaneTuning(panes[i], `mutant ${i}`, mutate(baseline));
  });
  root.querySelector('#rig-copy')!.addEventListener('click', () => {
    void navigator.clipboard.writeText(JSON.stringify(baseline, null, 2)).then(() => {
      (root.querySelector('#rig-copied') as HTMLElement).textContent = 'copied ✓';
      setTimeout(() => ((root.querySelector('#rig-copied') as HTMLElement).textContent = ''), 1500);
    });
  });

  // ---------- shared keyboard input, ramping-turn semantics ----------
  const held = new Set<string>();
  const TURN_KEYS: Record<string, -1 | 1> = { KeyA: -1, ArrowLeft: -1, KeyD: 1, ArrowRight: 1 };
  /** current fractional turn [-1, 1]; ramps toward target while a key is held */
  let turnValue = 0;
  /** inputs delayed by the latency knob, like a round trip to the DO */
  const queue: { at: number; input: TankInput; nudge?: number }[] = [];
  const latency = (): number => Number((root.querySelector('#rig-latency') as HTMLSelectElement).value);

  const send = (nudge?: number): void => {
    const accel = held.has('KeyW') || held.has('ArrowUp') ? 1 : held.has('KeyS') || held.has('ArrowDown') ? -1 : 0;
    const turn = Math.round(turnValue * 100) / 100;
    queue.push({ at: performance.now() + latency(), input: { accel, turn, fire: held.has('Space') }, nudge });
  };

  addEventListener('keydown', (ev) => {
    if (ev.code === 'Space') ev.preventDefault();
    const dir = TURN_KEYS[ev.code];
    if (dir && !ev.repeat) {
      held.add(ev.code);
      const nudgeSize = ev.shiftKey ? KEYBOARD_TUNING.fineNudgeShift : KEYBOARD_TUNING.fineNudge;
      send(dir * nudgeSize);
      return;
    }
    if (!ev.repeat) {
      held.add(ev.code);
      send();
    }
  });
  addEventListener('keyup', (ev) => {
    held.delete(ev.code);
    const left = held.has('KeyA') || held.has('ArrowLeft');
    const right = held.has('KeyD') || held.has('ArrowRight');
    if (!left && !right) turnValue = 0;
    send();
  });
  addEventListener('blur', () => {
    held.clear();
    turnValue = 0;
    send();
  });

  // ---------- 10Hz sim, 60fps interpolated render ----------
  let acc = 0;
  let last = performance.now();

  const tick = (): void => {
    const now = performance.now();
    while (queue.length && queue[0].at <= now) {
      const { input, nudge } = queue.shift()!;
      for (const pane of panes) {
        pane.world.setInput(pane.tank.id, input);
        if (nudge !== undefined) pane.world.addNudge(pane.tank.id, nudge);
      }
    }
    for (const pane of panes) {
      pane.prev = { x: pane.tank.x, y: pane.tank.y, dir: pane.tank.dir };
      pane.world.doTick(0); // warMinutes 0: no victory checks in the rig
      pane.cur = { x: pane.tank.x, y: pane.tank.y, dir: pane.tank.dir };
      pane.trail.push({ x: pane.tank.x, y: pane.tank.y });
      if (pane.trail.length > TRAIL_LEN) pane.trail.shift();
    }
  };

  const draw = (pane: Pane, alpha: number): void => {
    const canvas = pane.canvas;
    const w = canvas.clientWidth;
    const h = canvas.clientHeight;
    if (canvas.width !== w || canvas.height !== h) {
      canvas.width = w;
      canvas.height = h;
    }
    const ctx = canvas.getContext('2d')!;
    const cx = pane.prev.x + (pane.cur.x - pane.prev.x) * alpha;
    const cy = pane.prev.y + (pane.cur.y - pane.prev.y) * alpha;
    const dir = pane.cur.dir; // heading snaps read better than lerped wraps
    const toPx = (x: number, y: number): [number, number] => [w / 2 + (x - cx) * SCALE, h / 2 + (y - cy) * SCALE];

    const x0 = Math.floor(cx - w / 2 / SCALE) - 1;
    const y0 = Math.floor(cy - h / 2 / SCALE) - 1;
    const x1 = Math.ceil(cx + w / 2 / SCALE) + 1;
    const y1 = Math.ceil(cy + h / 2 / SCALE) + 1;
    for (let ty = y0; ty <= y1; ty++) {
      for (let tx = x0; tx <= x1; tx++) {
        const t = pane.world.tileAt(tx + 0.5, ty + 0.5);
        ctx.fillStyle = TERRAIN_COLORS[t] ?? '#222';
        const [px, py] = toPx(tx, ty);
        ctx.fillRect(px, py, SCALE + 1, SCALE + 1);
      }
    }

    // breadcrumbs: the shape of your driving is the feel
    ctx.strokeStyle = 'rgba(232,180,76,0.5)';
    ctx.beginPath();
    pane.trail.forEach((p, i) => {
      const [px, py] = toPx(p.x, p.y);
      if (i === 0) ctx.moveTo(px, py);
      else ctx.lineTo(px, py);
    });
    ctx.stroke();

    // shells
    ctx.fillStyle = '#ffd75e';
    for (const s of pane.world.shells) {
      const [px, py] = toPx(s.x, s.y);
      ctx.beginPath();
      ctx.arc(px, py, 2, 0, Math.PI * 2);
      ctx.fill();
    }

    // the tank: hull triangle + gun line + speed readout
    const [px, py] = toPx(cx, cy);
    ctx.save();
    ctx.translate(px, py);
    ctx.rotate(dir);
    ctx.fillStyle = '#e8b44c';
    ctx.beginPath();
    ctx.moveTo(SCALE * 0.55, 0);
    ctx.lineTo(-SCALE * 0.4, SCALE * 0.34);
    ctx.lineTo(-SCALE * 0.4, -SCALE * 0.34);
    ctx.closePath();
    ctx.fill();
    ctx.strokeStyle = '#fff';
    ctx.beginPath();
    ctx.moveTo(0, 0);
    ctx.lineTo(SCALE * 0.9, 0);
    ctx.stroke();
    ctx.restore();
    ctx.fillStyle = '#8fd18f';
    ctx.fillText(`${pane.tank.speed.toFixed(2)} t/s`, px + 12, py - 10);
  };

  const loop = (now: number): void => {
    requestAnimationFrame(loop);
    const frameDt = Math.min(0.1, (now - last) / 1000);
    // ramp turn value toward held target (proportional control)
    const left = held.has('KeyA') || held.has('ArrowLeft');
    const right = held.has('KeyD') || held.has('ArrowRight');
    const targetTurn = (right ? 1 : 0) - (left ? 1 : 0);
    if (targetTurn === 0) {
      if (turnValue !== 0) { turnValue = 0; send(); }
    } else {
      if (Math.sign(targetTurn) !== Math.sign(turnValue) && turnValue !== 0) turnValue = 0;
      const diff = targetTurn - turnValue;
      const step = KEYBOARD_TUNING.turnRampRate * frameDt;
      const newVal = Math.abs(diff) <= step ? targetTurn : turnValue + Math.sign(diff) * step;
      if (newVal !== turnValue) {
        turnValue = newVal;
        send();
      }
    }
    acc += now - last;
    last = now;
    while (acc >= TICK_MS) {
      tick();
      acc -= TICK_MS;
    }
    const alpha = acc / TICK_MS;
    for (const pane of panes) draw(pane, alpha);
  };
  requestAnimationFrame(loop);
}
