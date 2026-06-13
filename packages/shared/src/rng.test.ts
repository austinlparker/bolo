import { describe, it, expect } from 'vitest';
import { mulberry32, hash32, valueNoise2, fbm2 } from './rng';

describe('mulberry32', () => {
  it('same seed produces identical sequences', () => {
    const a = mulberry32(12345);
    const b = mulberry32(12345);
    for (let i = 0; i < 100; i++) {
      expect(a()).toBe(b());
    }
  });

  it('different seeds diverge', () => {
    const a = mulberry32(1);
    const b = mulberry32(2);
    let same = 0;
    for (let i = 0; i < 100; i++) {
      if (a() === b()) same++;
    }
    expect(same).toBeLessThan(100);
  });

  it('produces values in [0,1)', () => {
    const r = mulberry32(42);
    for (let i = 0; i < 1000; i++) {
      const v = r();
      expect(v).toBeGreaterThanOrEqual(0);
      expect(v).toBeLessThan(1);
    }
  });
});

describe('hash32', () => {
  it('is deterministic for fixed inputs', () => {
    expect(hash32(1, 2)).toBe(hash32(1, 2));
    expect(hash32(0)).toBe(hash32(0));
    expect(hash32(99, 100, 200)).toBe(hash32(99, 100, 200));
  });

  it('returns uint32 values (< 4294967296)', () => {
    for (const args of [[0], [1, 2], [0xb010], [255, 255, 255], [-1], [4294967295]]) {
      const h = hash32(...args);
      expect(h).toBeGreaterThanOrEqual(0);
      expect(h).toBeLessThan(4294967296);
      expect(Number.isInteger(h)).toBe(true);
    }
  });

  it('order matters: hash32(a,b) !== hash32(b,a)', () => {
    // mapgen depends on this for seed derivation
    expect(hash32(1, 2)).not.toBe(hash32(2, 1));
    expect(hash32(100, 200)).not.toBe(hash32(200, 100));
  });
});

describe('valueNoise2', () => {
  it('equals the lattice value at integer coords', () => {
    const seed = 5;
    // At integer coords the interpolation collapses to the lattice corner value
    const at00 = valueNoise2(seed, 0, 0);
    // lattice(seed,0,0) = hash32(seed,0,0)/2^32
    const expected = hash32(seed, 0, 0) / 4294967296;
    expect(at00).toBeCloseTo(expected, 10);
  });

  it('is continuous at boundaries', () => {
    const seed = 7;
    // just inside and just outside an integer cell should be close
    const before = valueNoise2(seed, 2.0, 3.0);
    const after = valueNoise2(seed, 2.001, 3.0);
    expect(Math.abs(after - before)).toBeLessThan(0.01);
  });

  it('output in [0,1]', () => {
    const seed = 3;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const v = valueNoise2(seed, x * 0.7, y * 0.7);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });
});

describe('fbm2', () => {
  it('output in [0,1] over a sample grid', () => {
    const seed = 11;
    for (let y = 0; y < 10; y++) {
      for (let x = 0; x < 10; x++) {
        const v = fbm2(seed, x * 0.3, y * 0.3);
        expect(v).toBeGreaterThanOrEqual(0);
        expect(v).toBeLessThanOrEqual(1);
      }
    }
  });

  it('adjacent samples differ by < 0.1 (smoothness)', () => {
    const seed = 42;
    for (let y = 0; y < 8; y++) {
      for (let x = 0; x < 8; x++) {
        const a = fbm2(seed, x * 0.5, y * 0.5);
        const b = fbm2(seed, (x + 0.1) * 0.5, y * 0.5);
        expect(Math.abs(b - a)).toBeLessThan(0.1);
      }
    }
  });

  it('is deterministic', () => {
    const seed = 99;
    const a = fbm2(seed, 1.5, 2.5, 4);
    const b = fbm2(seed, 1.5, 2.5, 4);
    expect(a).toBe(b);
  });
});
