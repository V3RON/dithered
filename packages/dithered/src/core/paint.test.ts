import { describe, expect, it } from 'vitest';
import { SQUARE_SHAPE } from '../test-utils';
import { computeGeometry } from './paint';
import { resolveOptions } from './options';

describe('computeGeometry', () => {
  // `cols: 10` so a surface width of 40 gives cellSize 4 (below the
  // default 0.09 gap's 0.6px-floor crossover, ~6.67) and a width of 200
  // gives cellSize 20 (well above it) — both sides of the floor are
  // exercised below. `computeGeometry` takes no `scale`: every caller now
  // passes CSS pixels (dp on native), so the floor unambiguously means
  // 0.6 of that unit.
  const opts = resolveOptions({ shape: SQUARE_SHAPE, brightness: () => true, cols: 10 });

  it('floors the gap at 0.6 when cellSize * gap would be smaller', () => {
    const geometry = computeGeometry(opts, 40, 40);
    expect(geometry.cellSize).toBe(4);
    expect(geometry.gap).toBe(0.6);
  });

  it('uses cellSize * gap once it clears the 0.6 floor', () => {
    const geometry = computeGeometry(opts, 200, 200);
    expect(geometry.cellSize).toBe(20);
    expect(geometry.gap).toBeCloseTo(20 * opts.gap);
  });

  it('ox defaults to 0', () => {
    expect(computeGeometry(opts, 40, 40).ox).toBe(0);
  });
});
