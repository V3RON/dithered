import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  blend,
  clamp,
  compose,
  invert,
  mask,
  offset,
  reverse,
  timeScale,
  type CellPredicate,
} from './compose';
import { fill, sweep } from './presets';
import type { Brightness } from './core';
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

describe('compose export shape', () => {
  it('exposes exactly the seven helpers by name', () => {
    expect(Object.keys(compose).sort()).toEqual(
      ['blend', 'clamp', 'invert', 'mask', 'offset', 'reverse', 'timeScale'].sort(),
    );
  });

  it('each named export is the same function reference as its compose member', () => {
    expect(compose.blend).toBe(blend);
    expect(compose.mask).toBe(mask);
    expect(compose.timeScale).toBe(timeScale);
    expect(compose.reverse).toBe(reverse);
    expect(compose.offset).toBe(offset);
    expect(compose.invert).toBe(invert);
    expect(compose.clamp).toBe(clamp);
  });
});

// Every helper, wrapping the periodic `sweep()`, must preserve periodicity:
// f(cell, 0) === f(cell, 1). offset/reverse/integer-timeScale are checked
// with *exact* equality — the whole point of their time-wrapping decisions
// is that they're exact, not merely close.
describe('periodicity: every helper preserves it on a periodic source', () => {
  const alwaysTrue: CellPredicate = () => true;
  const helpers: Record<string, () => Brightness> = {
    blend: () => blend(sweep(), sweep({ angle: 1 }), 0.5),
    'blend (function mix)': () => blend(sweep(), sweep({ angle: 1 }), (cell) => cell.u + 0.5),
    mask: () => mask(sweep(), alwaysTrue),
    'timeScale(2)': () => timeScale(sweep(), 2),
    reverse: () => reverse(sweep()),
    'offset(0.3)': () => offset(sweep(), 0.3),
    invert: () => invert(sweep()),
    clamp: () => clamp(sweep(), 0, 1),
  };

  // timeScale(2) and offset(0.3) are exact here for a structural reason that
  // holds regardless of the source: both boundary calls reduce to the exact
  // same wrapped `t` (wrap01(0) === wrap01(2) === 0; wrap01(wrap01(0) + 0.3)
  // === wrap01(wrap01(1) + 0.3) === 0.3), so both sides are literally the
  // same call into `source`. `reverse` has no such structural guarantee —
  // its boundary compares `source(cell, 1)` against `source(cell, 0)`
  // directly, which is only as exact as the *source's own* periodicity, and
  // `sweep()` itself is periodic only up to floating-point rounding (see
  // presets.test.ts, which checks it with `toBeCloseTo`, not `toBe`).
  // reverse's genuine, structural exactness is covered separately below
  // ("reverse(s) at t=0.25 equals s at t=0.75" and the non-periodic `fill()`
  // case), where both sides reduce to one identical call into the source.
  const EXACT = new Set(['timeScale(2)', 'offset(0.3)']);

  describe.each(Object.entries(helpers))('%s', (name, factory) => {
    it('f(cell, 0) === f(cell, 1)', () => {
      const brightness = factory();
      for (const cell of SAMPLE_CELLS) {
        const a = brightness(cell, 0);
        const b = brightness(cell, 1);
        if (EXACT.has(name)) {
          expect(b).toBe(a);
        } else {
          expect(b as number).toBeCloseTo(a as number, 6);
        }
      }
    });
  });
});

describe('timeScale', () => {
  it('integer factor preserves periodicity exactly', () => {
    const s = timeScale(sweep(), 3);
    for (const cell of SAMPLE_CELLS) {
      expect(s(cell, 0)).toBe(s(cell, 1));
    }
  });

  it('non-integer factor demonstrably breaks periodicity', () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const s = timeScale(sweep(), 2.5);
    const cell = makeCell(0.3, -0.2);
    expect(s(cell, 0)).not.toBe(s(cell, 1));
    warnSpy.mockRestore();
  });

  it('timeScale(s, 2) at t=0.25 equals s at t=0.5', () => {
    const source = sweep();
    const s = timeScale(source, 2);
    for (const cell of SAMPLE_CELLS) {
      expect(s(cell, 0.25)).toBeCloseTo(source(cell, 0.5) as number, 10);
    }
  });

  it('a boolean source stays boolean', () => {
    const s = timeScale(fill(), 2);
    expect(typeof s(makeCell(0, 0.4), 0.9)).toBe('boolean');
  });
});

describe('timeScale non-integer warning', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
  });

  afterEach(() => {
    warnSpy.mockRestore();
  });

  // Factor values below are unique across test cases (and to this describe
  // block) so the module-level dedupe Set — which persists for the life of
  // the module — can't make one test's warning look like another's no-op.
  it('a non-integer factor warns once', () => {
    timeScale(sweep(), 11.5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('constructing again with the same factor does not warn again', () => {
    timeScale(sweep(), 12.5);
    timeScale(sweep(), 12.5);
    timeScale(sweep(), 12.5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('a different non-integer factor warns again', () => {
    timeScale(sweep(), 13.5);
    timeScale(sweep(), 14.5);
    expect(warnSpy).toHaveBeenCalledTimes(2);
  });

  it('an integer factor never warns', () => {
    timeScale(sweep(), 15);
    timeScale(sweep(), 16);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});

describe('blend', () => {
  const a: Brightness = () => 0.2;
  const b: Brightness = () => 0.8;

  it('mix=0 returns exactly a, mix=1 returns exactly b', () => {
    const cell = makeCell(0, 0);
    expect(blend(a, b, 0)(cell, 0)).toBe(0.2);
    expect(blend(a, b, 1)(cell, 0)).toBe(0.8);
  });

  it('mix=0.5 is the midpoint', () => {
    const cell = makeCell(0, 0);
    expect(blend(a, b, 0.5)(cell, 0)).toBeCloseTo(0.5, 10);
  });

  it('boolean sources coerce to 1/0', () => {
    const t: Brightness = () => true;
    const f: Brightness = () => false;
    const cell = makeCell(0, 0);
    expect(blend(t, f, 0.5)(cell, 0)).toBeCloseTo(0.5, 10);
    expect(blend(t, f, 0)(cell, 0)).toBe(1);
    expect(blend(t, f, 1)(cell, 0)).toBe(0);
  });

  it('a function mix receives the same (cell, t) the composed function was called with', () => {
    const mixFn = vi.fn(() => 0.5);
    const cell = makeCell(0.3, -0.2);
    blend(a, b, mixFn)(cell, 0.42);
    expect(mixFn).toHaveBeenCalledWith(cell, 0.42);
  });

  it('a mix outside [0, 1] extrapolates rather than clamping', () => {
    const cell = makeCell(0, 0);
    // mix = 2: (1 - 2) * 0.2 + 2 * 0.8 = -0.2 + 1.6 = 1.4
    expect(blend(a, b, 2)(cell, 0)).toBeCloseTo(1.4, 10);
    // mix = -1: (1 - (-1)) * 0.2 + (-1) * 0.8 = 0.4 - 0.8 = -0.4
    expect(blend(a, b, -1)(cell, 0)).toBeCloseTo(-0.4, 10);
  });

  it('each source is called exactly once per invocation', () => {
    const aSpy = vi.fn(() => 0.2);
    const bSpy = vi.fn(() => 0.8);
    blend(aSpy, bSpy, 0.5)(makeCell(0, 0), 0);
    expect(aSpy).toHaveBeenCalledTimes(1);
    expect(bSpy).toHaveBeenCalledTimes(1);

    aSpy.mockClear();
    bSpy.mockClear();
    blend(aSpy, bSpy, () => 0.3)(makeCell(0, 0), 0);
    expect(aSpy).toHaveBeenCalledTimes(1);
    expect(bSpy).toHaveBeenCalledTimes(1);
  });
});

describe('mask', () => {
  it('an accepted cell returns the source value unchanged (number)', () => {
    const source: Brightness = () => 0.63;
    const m = mask(source, () => true);
    expect(m(makeCell(0, 0), 0.5)).toBe(0.63);
  });

  it('an accepted cell preserves a boolean true unchanged', () => {
    const source: Brightness = () => true;
    const m = mask(source, () => true);
    expect(m(makeCell(0, 0), 0.5)).toBe(true);
  });

  it('a rejected cell returns exactly false, not 0', () => {
    const source: Brightness = () => 0.63;
    const m = mask(source, () => false);
    const result = m(makeCell(0, 0), 0.5);
    expect(result).toBe(false);
    expect(result).not.toBe(0);
  });

  it('the predicate receives the cell and is not passed t', () => {
    const predicate = vi.fn(() => true);
    const cell = makeCell(0.1, 0.2);
    mask(() => 1, predicate)(cell, 0.77);
    expect(predicate).toHaveBeenCalledWith(cell);
    expect(predicate.mock.calls[0]).toHaveLength(1);
  });
});

describe('invert', () => {
  it('0.25 -> 0.75', () => {
    const source: Brightness = () => 0.25;
    expect(invert(source)(makeCell(0, 0), 0)).toBeCloseTo(0.75, 10);
  });

  it('true -> false, false -> true', () => {
    const t: Brightness = () => true;
    const f: Brightness = () => false;
    expect(invert(t)(makeCell(0, 0), 0)).toBe(false);
    expect(invert(f)(makeCell(0, 0), 0)).toBe(true);
  });

  it('out-of-range input is not clamped', () => {
    const source: Brightness = () => 1.5;
    expect(invert(source)(makeCell(0, 0), 0)).toBeCloseTo(-0.5, 10);
  });
});

describe('clamp', () => {
  it('bounds values below min and above max', () => {
    const low: Brightness = () => -0.5;
    const high: Brightness = () => 1.5;
    expect(clamp(low)(makeCell(0, 0), 0)).toBe(0);
    expect(clamp(high)(makeCell(0, 0), 0)).toBe(1);
  });

  it('an in-range value passes through', () => {
    const source: Brightness = () => 0.42;
    expect(clamp(source)(makeCell(0, 0), 0)).toBe(0.42);
  });

  it('boolean true/false coerce to 1/0 and are then clamped', () => {
    const t: Brightness = () => true;
    expect(clamp(t, 0, 0.5)(makeCell(0, 0), 0)).toBe(0.5);
    const f: Brightness = () => false;
    expect(clamp(f, 0.2, 1)(makeCell(0, 0), 0)).toBe(0.2);
  });

  it('defaults are 0 and 1', () => {
    const source: Brightness = () => 5;
    expect(clamp(source)(makeCell(0, 0), 0)).toBe(1);
  });
});

describe('offset', () => {
  it('offset(s, 0.25) at t=0 equals s at t=0.25', () => {
    const source = sweep();
    const s = offset(source, 0.25);
    for (const cell of SAMPLE_CELLS) {
      expect(s(cell, 0)).toBe(source(cell, 0.25));
    }
  });

  it('dt greater than 1 wraps correctly', () => {
    const source = sweep();
    const s = offset(source, 1.25);
    for (const cell of SAMPLE_CELLS) {
      expect(s(cell, 0)).toBe(source(cell, 0.25));
    }
  });

  it('negative dt wraps correctly', () => {
    const source = sweep();
    const s = offset(source, -0.25);
    for (const cell of SAMPLE_CELLS) {
      expect(s(cell, 0)).toBeCloseTo(source(cell, 0.75) as number, 10);
    }
  });

  it('a boolean source stays boolean', () => {
    const s = offset(fill(), 0.25);
    expect(typeof s(makeCell(0, 0.4), 0.5)).toBe('boolean');
  });
});

describe('reverse', () => {
  it('reverse(s) at t=0.25 equals s at t=0.75', () => {
    const source = sweep();
    const r = reverse(source);
    for (const cell of SAMPLE_CELLS) {
      expect(r(cell, 0.25)).toBe(source(cell, 0.75));
    }
  });

  it('reversing the non-periodic fill() starts full and ends empty', () => {
    const r = reverse(fill());
    const cells = [makeCell(0, -0.49), makeCell(0, 0), makeCell(0, 0.49)];
    for (const cell of cells) {
      expect(r(cell, 0)).toBe(true);
      expect(r(cell, 1)).toBe(false);
    }
  });
});

describe('composability', () => {
  it('a stacked case returns finite numbers over a sweep of t and stays periodic', () => {
    const predicate: CellPredicate = (cell) => cell.u <= 0;
    const stacked = mask(timeScale(sweep(), 2), predicate);
    for (const cell of SAMPLE_CELLS) {
      for (const t of [0, 0.13, 0.5, 0.87, 0.999]) {
        const b = stacked(cell, t);
        if (predicate(cell)) {
          expect(typeof b).toBe('number');
          expect(Number.isFinite(b as number)).toBe(true);
        } else {
          expect(b).toBe(false);
        }
      }
      expect(stacked(cell, 0)).toBe(stacked(cell, 1));
    }
  });
});
