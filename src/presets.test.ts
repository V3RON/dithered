import { describe, expect, it } from 'vitest';
import { fill, gem, presets, pulse, rain, sweep, wave } from './presets';
import type { Cell } from './shape';

function makeCell(u: number, v: number, i = 0, j = 0): Cell {
  return { i, j, u, v, threshold: 0.5 };
}

const SAMPLE_CELLS: Cell[] = [
  makeCell(0, 0, 0, 0),
  makeCell(0.3, -0.2, 2, 5),
  makeCell(-0.4, 0.1, 7, 1),
  makeCell(0.1, 0.45, 3, 9),
  makeCell(-0.45, -0.45, 0, 0),
];

// Presets that must loop seamlessly: brightness(cell, 0) === brightness(cell, 1).
const PERIODIC_PRESETS: Record<string, () => (cell: Cell, t: number) => number | boolean> = {
  gem: () => gem(),
  sweep: () => sweep(),
  pulse: () => pulse(),
  rain: () => rain(),
  wave: () => wave(),
};

describe('presets export', () => {
  it('exposes all six presets by name', () => {
    expect(Object.keys(presets).sort()).toEqual(
      ['fill', 'gem', 'pulse', 'rain', 'sweep', 'wave'].sort(),
    );
  });
});

describe.each(Object.entries(PERIODIC_PRESETS))('%s', (_name, factory) => {
  it('returns finite numbers for a sample of cells and t values', () => {
    const brightness = factory();
    for (const cell of SAMPLE_CELLS) {
      for (const t of [0, 0.13, 0.5, 0.87, 0.999]) {
        const b = brightness(cell, t);
        expect(typeof b).toBe('number');
        expect(Number.isFinite(b as number)).toBe(true);
      }
    }
  });

  it('loops seamlessly: brightness(cell, 0) ~= brightness(cell, 1)', () => {
    const brightness = factory();
    for (const cell of SAMPLE_CELLS) {
      const a = brightness(cell, 0) as number;
      const b = brightness(cell, 1) as number;
      expect(b).toBeCloseTo(a, 6);
    }
  });
});

describe('gem', () => {
  it('matches known reference values for fixed cells and t (regression guard)', () => {
    const brightness = gem();
    expect(brightness(makeCell(0, 0), 0)).toBeCloseTo(0.35830441, 5);
    expect(brightness(makeCell(0, 0), 0.37)).toBeCloseTo(0.70412808, 5);
    expect(brightness(makeCell(0.3, -0.2), 0)).toBeCloseTo(0.89599252, 5);
    expect(brightness(makeCell(0.3, -0.2), 0.37)).toBeCloseTo(0.03934772, 5);
    expect(brightness(makeCell(-0.4, 0.1), 0.37)).toBeCloseTo(1.16418587, 5);
  });

  it('respects a custom noise amount', () => {
    const quiet = gem({ noise: 0 });
    const loud = gem({ noise: 1.4 });
    const cell = makeCell(-0.4, 0.1);
    // With noise=0 the grain term vanishes entirely, so results differ
    // from a much noisier configuration (almost certainly, for this cell/t).
    expect(quiet(cell, 0.37)).not.toBeCloseTo(loud(cell, 0.37) as number, 3);
  });
});

describe('fill', () => {
  it('lights nothing at t=0 and everything at t=1', () => {
    const brightness = fill();
    const cells = [
      makeCell(0, -0.49),
      makeCell(0, 0),
      makeCell(0, 0.49),
      makeCell(-0.49, 0.2),
      makeCell(0.49, -0.3),
    ];
    for (const cell of cells) {
      expect(brightness(cell, 0)).toBe(false);
      expect(brightness(cell, 1)).toBe(true);
    }
  });

  it('is monotonic in t for a given cell (never flips back off)', () => {
    const brightness = fill();
    const cell = makeCell(0.1, 0.2);
    let sawTrue = false;
    for (let t = 0; t <= 1.001; t += 0.05) {
      const b = brightness(cell, t) as boolean;
      if (sawTrue) {
        expect(b).toBe(true);
      }
      if (b) sawTrue = true;
    }
    expect(sawTrue).toBe(true);
  });

  it.each(['up', 'down', 'left', 'right'] as const)(
    'direction=%s fills progressively from its starting edge',
    (direction) => {
      const brightness = fill({ direction });
      // Halfway through, roughly half the cells along the fill axis should
      // be lit and half should not (a coarse sanity check, not exact).
      const cells = Array.from({ length: 11 }, (_, k) => makeCell((k - 5) / 10, (k - 5) / 10));
      const litAtHalf = cells.filter((c) => brightness(c, 0.5)).length;
      expect(litAtHalf).toBeGreaterThan(0);
      expect(litAtHalf).toBeLessThan(cells.length);
    },
  );
});
