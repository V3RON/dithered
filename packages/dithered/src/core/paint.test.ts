import { describe, expect, it } from 'vitest';
import { SQUARE_SHAPE } from '../test-utils';
import { computeGeometry } from './paint';
import { resolveOptions } from './options';

describe('computeGeometry', () => {
  // `cols: 10` so a surface width of 40 gives cellSize 4 (below the
  // default 0.09 gap's 0.6px-floor crossover, ~6.67) and a width of 200
  // gives cellSize 20 (well above it) — the invariant below must hold on
  // both sides of that crossover, per the ADR's scale invariant.
  const opts = resolveOptions({ shape: SQUARE_SHAPE, brightness: () => true, cols: 10 });

  it.each([1, 2, 3])(
    'computeGeometry(w*s, h*s, 0, s) equals computeGeometry(w, h) scaled by s, with the gap floor active (s=%s)',
    (s) => {
      const w = 40;
      const h = 40;
      const base = computeGeometry(opts, w, h);
      const scaled = computeGeometry(opts, w * s, h * s, 0, s);
      expect(scaled.cellSize).toBeCloseTo(base.cellSize * s);
      expect(scaled.gap).toBeCloseTo(base.gap * s);
      expect(scaled.radius).toBeCloseTo(base.radius * s);
    },
  );

  it.each([1, 2, 3])(
    'computeGeometry(w*s, h*s, 0, s) equals computeGeometry(w, h) scaled by s, with the gap floor inactive (s=%s)',
    (s) => {
      const w = 200;
      const h = 200;
      const base = computeGeometry(opts, w, h);
      const scaled = computeGeometry(opts, w * s, h * s, 0, s);
      expect(scaled.cellSize).toBeCloseTo(base.cellSize * s);
      expect(scaled.gap).toBeCloseTo(base.gap * s);
      expect(scaled.radius).toBeCloseTo(base.radius * s);
    },
  );

  it('scale defaults to 1, so an un-scaled call is unaffected', () => {
    expect(computeGeometry(opts, 40, 40)).toEqual(computeGeometry(opts, 40, 40, 0, 1));
  });
});
