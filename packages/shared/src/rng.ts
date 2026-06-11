/** Deterministic PRNG + value noise. Everything map-related derives from one 32-bit seed. */

export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function hash32(...nums: number[]): number {
  let h = 0x811c9dc5;
  for (const n of nums) {
    let x = n | 0;
    for (let i = 0; i < 4; i++) {
      h ^= x & 0xff;
      h = Math.imul(h, 0x01000193);
      x >>>= 8;
    }
  }
  return h >>> 0;
}

/** 2D lattice hash -> [0,1) */
function lattice(seed: number, xi: number, yi: number): number {
  return hash32(seed, xi, yi) / 4294967296;
}

function smooth(t: number): number {
  return t * t * (3 - 2 * t);
}

/** Single-octave value noise, smooth-interpolated. */
export function valueNoise2(seed: number, x: number, y: number): number {
  const xi = Math.floor(x);
  const yi = Math.floor(y);
  const xf = smooth(x - xi);
  const yf = smooth(y - yi);
  const a = lattice(seed, xi, yi);
  const b = lattice(seed, xi + 1, yi);
  const c = lattice(seed, xi, yi + 1);
  const d = lattice(seed, xi + 1, yi + 1);
  const top = a + (b - a) * xf;
  const bot = c + (d - c) * xf;
  return top + (bot - top) * yf;
}

/** Fractal brownian motion over value noise -> roughly [0,1]. */
export function fbm2(seed: number, x: number, y: number, octaves = 4, lacunarity = 2, gain = 0.5): number {
  let amp = 1;
  let freq = 1;
  let sum = 0;
  let norm = 0;
  for (let o = 0; o < octaves; o++) {
    sum += amp * valueNoise2(hash32(seed, o), x * freq, y * freq);
    norm += amp;
    amp *= gain;
    freq *= lacunarity;
  }
  return sum / norm;
}
