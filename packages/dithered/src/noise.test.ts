import { describe, expect, it } from 'vitest';
import { fbm, hash, valueNoise } from './noise';

describe('hash', () => {
  it('is deterministic for the same inputs', () => {
    expect(hash(3, 7)).toBe(hash(3, 7));
  });

  it('returns values in [0, 1)', () => {
    for (let i = 0; i < 20; i++) {
      for (let j = 0; j < 20; j++) {
        const h = hash(i, j);
        expect(h).toBeGreaterThanOrEqual(0);
        expect(h).toBeLessThan(1);
      }
    }
  });

  it('matches known reference values', () => {
    expect(hash(0, 0)).toBeCloseTo(0, 5);
    expect(hash(1, 1)).toBeCloseTo(0.10468243, 5);
  });
});

describe('valueNoise', () => {
  it('is deterministic', () => {
    expect(valueNoise(1.25, 4.75)).toBe(valueNoise(1.25, 4.75));
  });

  it('stays in [0, 1]', () => {
    for (let x = 0; x < 5; x += 0.37) {
      for (let y = 0; y < 5; y += 0.53) {
        const n = valueNoise(x, y);
        expect(n).toBeGreaterThanOrEqual(0);
        expect(n).toBeLessThanOrEqual(1);
      }
    }
  });

  it('is exactly the lattice hash at integer coordinates', () => {
    expect(valueNoise(2, 3)).toBeCloseTo(hash(2, 3), 10);
  });
});

describe('fbm', () => {
  it('is deterministic', () => {
    expect(fbm(0.3, 0.7)).toBe(fbm(0.3, 0.7));
  });

  it('matches snapshot values for fixed inputs', () => {
    expect(fbm(0, 0)).toBeCloseTo(0.22929689, 5);
    expect(fbm(1.5, 2.5)).toBeCloseTo(0.66366363, 5);
    expect(fbm(3.14159, -1.5)).toBeCloseTo(0.48343626, 5);
  });
});
