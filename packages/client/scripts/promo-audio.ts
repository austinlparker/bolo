/**
 * Chiptune bed for the promo video: a 28s NES-flavored track written
 * straight to WAV (44.1kHz/16-bit stereo), no dependencies.
 *   npx tsx scripts/promo-audio.ts /tmp/atbolo-promo/music.wav
 * Structure mirrors the video beats: sparse reveal -> driving battle ->
 * climax -> stripped-down end card with fade.
 */
import { writeFileSync } from 'node:fs';

const SR = 44100;
const BPM = 120;
const BEAT = 60 / BPM; // 0.5s
const BAR = BEAT * 4; // 2s
const BARS = 14; // 28s
const LEN = Math.ceil(BARS * BAR * SR);

const L = new Float32Array(LEN);
const R = new Float32Array(LEN);

const midi = (n: number) => 440 * 2 ** ((n - 69) / 12);

// oscillators
const sq = (t: number, f: number, duty = 0.5) => ((t * f) % 1 < duty ? 1 : -1);
const tri = (t: number, f: number) => 1 - 4 * Math.abs(Math.round(t * f) - t * f);
let nseed = 1;
const noise = () => {
  // tiny LCG so the render is deterministic
  nseed = (nseed * 1103515245 + 12345) & 0x7fffffff;
  return (nseed / 0x3fffffff) - 1;
};

/** add a tone: exponential decay envelope, slight stereo bias */
function tone(
  start: number,
  dur: number,
  freq: number,
  vol: number,
  osc: (t: number, f: number) => number,
  pan = 0, // -1..1
  decay = 4,
): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(dur * SR);
  const gl = vol * (1 - Math.max(0, pan) * 0.5);
  const gr = vol * (1 + Math.min(0, pan) * 0.5) * (pan < 0 ? 1 - -pan * 0.5 + -pan * 0.5 : 1);
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    const env = Math.min(1, t / 0.005) * Math.exp(-decay * (t / dur));
    const v = osc(t, freq) * env;
    L[s0 + i] += v * gl;
    R[s0 + i] += v * (vol * (1 + Math.min(0, pan) * -0.5) - (gl - vol)); // mirror bias
  }
}

function kick(start: number, vol = 0.5): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(0.13 * SR);
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    const f = 110 * Math.exp(-18 * t) + 42;
    const v = Math.sin(2 * Math.PI * f * t) * Math.exp(-22 * t) * vol;
    L[s0 + i] += v;
    R[s0 + i] += v;
  }
}

function snare(start: number, vol = 0.26): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(0.16 * SR);
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    const v = (noise() * 0.8 + Math.sin(2 * Math.PI * 190 * t) * 0.3) * Math.exp(-26 * t) * vol;
    L[s0 + i] += v;
    R[s0 + i] += v;
  }
}

function hat(start: number, vol = 0.07): void {
  const s0 = Math.floor(start * SR);
  const n = Math.floor(0.035 * SR);
  for (let i = 0; i < n && s0 + i < LEN; i++) {
    const t = i / SR;
    let v = noise();
    v = v - (L[s0 + i - 1] ?? 0) * 0; // keep it bright
    const e = Math.exp(-80 * t) * vol;
    L[s0 + i] += v * e * 0.9;
    R[s0 + i] += v * e * 1.1;
  }
}

// --- arrangement -------------------------------------------------------
// A minor. Progression for the action bars: Am F C G.
const Am = 57; // A3
const F = 53;
const C = 48;
const G = 55;
const PROG = [Am, F, C, G];

for (let bar = 0; bar < BARS; bar++) {
  const t0 = bar * BAR;
  const reveal = bar < 2;
  const endcard = bar >= 12;
  const climax = bar >= 9 && bar < 12;
  const root = reveal || endcard ? Am : PROG[(bar - 2) % 4];

  if (endcard) {
    // stripped pad: slow root + fifth, heartbeat kick
    tone(t0, BAR, midi(root - 12), 0.16, tri, 0, 1.2);
    tone(t0, BAR, midi(root - 5), 0.07, (t, f) => sq(t, f, 0.25), 0.3, 1.2);
    tone(t0, BAR, midi(root), 0.05, (t, f) => sq(t, f, 0.25), -0.3, 1.2);
    kick(t0, 0.4);
    continue;
  }

  // bass: driving 8ths on the root, octave bounce
  for (let i = 0; i < 8; i++) {
    const n = i % 2 === 0 ? root - 12 : root - (reveal ? 12 : 0);
    tone(t0 + i * (BEAT / 2), BEAT / 2, midi(n), reveal ? 0.16 : 0.2, tri, 0, 5);
  }

  // hats: 8ths always; snare 2 & 4 once the action starts
  for (let i = 0; i < 8; i++) hat(t0 + i * (BEAT / 2), reveal ? 0.05 : 0.07);
  kick(t0);
  kick(t0 + 2 * BEAT);
  if (!reveal) {
    snare(t0 + BEAT);
    snare(t0 + 3 * BEAT);
    if (climax) kick(t0 + 2.5 * BEAT, 0.4);
  }

  // arp: 16th root/5th/octave/5th, the chip classic
  if (!reveal) {
    const steps = [0, 7, 12, 7, 0, 7, 12, 16];
    for (let i = 0; i < 16; i++) {
      const n = root + steps[i % 8];
      tone(t0 + i * (BEAT / 4), BEAT / 4, midi(n), 0.085, (t, f) => sq(t, f, 0.25), i % 2 ? 0.45 : -0.45, 7);
    }
  } else {
    // reveal: lonely octave pings
    tone(t0 + BEAT, BEAT, midi(root + 12), 0.07, (t, f) => sq(t, f, 0.5), 0.2, 3);
    tone(t0 + 3 * BEAT, BEAT, midi(root + 19), 0.06, (t, f) => sq(t, f, 0.5), -0.2, 3);
  }

  // climax: lead melody an octave up, long notes
  if (climax) {
    const lead = [root + 24, root + 19, root + 24, root + 27];
    for (let i = 0; i < 4; i++) {
      tone(t0 + i * BEAT, BEAT * 0.9, midi(lead[i]), 0.1, (t, f) => sq(t, f, 0.5), 0, 2.5);
    }
  }
}

// --- master: soft clip, fade tail, write ------------------------------
const FADE = 1.6 * SR;
for (let i = 0; i < LEN; i++) {
  let fade = 1;
  if (i > LEN - FADE) fade = (LEN - i) / FADE;
  L[i] = Math.tanh(L[i] * 1.4) * 0.85 * fade;
  R[i] = Math.tanh(R[i] * 1.4) * 0.85 * fade;
}

const out = process.argv[2] ?? '/tmp/atbolo-promo/music.wav';
const data = Buffer.alloc(44 + LEN * 4);
data.write('RIFF', 0);
data.writeUInt32LE(36 + LEN * 4, 4);
data.write('WAVEfmt ', 8);
data.writeUInt32LE(16, 16);
data.writeUInt16LE(1, 20); // PCM
data.writeUInt16LE(2, 22); // stereo
data.writeUInt32LE(SR, 24);
data.writeUInt32LE(SR * 4, 28);
data.writeUInt16LE(4, 32);
data.writeUInt16LE(16, 34);
data.write('data', 36);
data.writeUInt32LE(LEN * 4, 40);
for (let i = 0; i < LEN; i++) {
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(L[i] * 32767))), 44 + i * 4);
  data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(R[i] * 32767))), 46 + i * 4);
}
writeFileSync(out, data);
console.log(`wrote ${out} (${(LEN / SR).toFixed(1)}s)`);
