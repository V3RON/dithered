import { describe, expect, it } from 'vitest';
import { CURRENT_COLOR, hasCurrentColor, resolvePalette, toPalette, toneLevel } from './palette';
import type { Palette } from './palette';
import { DEFAULTS } from './options';
import type { DitheredOptions } from './options';
import { BAYER_4 } from '../shape';
import { SQUARE_SHAPE } from '../test-utils';

// Every threshold `sampleCells` can actually produce: `(v + 0.5) / 16` for
// each `v` in the 4x4 Bayer matrix (0..15, each appearing exactly once).
const THRESHOLDS = Array.from(new Set(BAYER_4.flat())).map((v) => (v + 0.5) / 16);

describe("toneLevel: n === 1 equivalence with today's `b > threshold`", () => {
  // This is the load-bearing property from ADR 0005 §2: at `tones === 1`,
  // `toneLevel` must agree with the predicate it replaces for every `b`
  // that can reach it, or single-color output would silently change.
  it('agrees with `b > threshold` across a sweep of b, for every Bayer threshold', () => {
    for (const t of THRESHOLDS) {
      const sweep = [
        0,
        1,
        NaN,
        -1,
        -0.5,
        0.5,
        t, // exactly on the threshold: today draws iff b > t, i.e. false here
        t - 1e-9,
        t + 1e-9,
        Math.max(0, t - 0.01),
        Math.min(1, t + 0.01),
        0.001,
        0.999,
      ];
      for (const b of sweep) {
        const expected = b > t; // NaN > t is false, matching today's behavior
        expect(toneLevel(b, t, 1)).toBe(expected ? 1 : 0);
      }
    }
  });

  it('never returns a level outside {0, 1} at tones = 1', () => {
    for (const t of THRESHOLDS) {
      for (const b of [-10, 0, 0.25, 0.5, 0.75, 1, 10, NaN]) {
        expect([0, 1]).toContain(toneLevel(b, t, 1));
      }
    }
  });
});

describe('toneLevel: n = 2 and n = 3', () => {
  it('n = 2: table-driven boundaries, saturation and frac === threshold', () => {
    const t = 0.5;
    const cases: Array<[number, number]> = [
      [0, 0], // skip
      [-1, 0],
      [NaN, 0],
      [1, 2], // saturate at the top tone
      [10, 2],
      // b = 0.4 -> level = 0.8, base = 0, frac = 0.8 > 0.5 -> base + 1 = 1
      [0.4, 1],
      // b = 0.2 -> level = 0.4, base = 0, frac = 0.4 <= 0.5 -> base = 0 (skip)
      [0.2, 0],
      // b = 0.9 -> level = 1.8, base = 1, frac = 0.8 > 0.5 -> base + 1 = 2
      [0.9, 2],
      // b = 0.6 -> level = 1.2, base = 1, frac = 0.2 <= 0.5 -> base = 1
      [0.6, 1],
      // frac === threshold lands on the darker (lower) tone: b = 0.25 ->
      // level = 0.5, base = 0, frac = 0.5 === t -> base = 0
      [0.25, 0],
      // b = 0.75 -> level = 1.5, base = 1, frac = 0.5 === t -> base = 1
      [0.75, 1],
    ];
    for (const [b, expected] of cases) {
      expect(toneLevel(b, t, 2)).toBe(expected);
    }
  });

  it('n = 3: table-driven boundaries, saturation and frac === threshold', () => {
    const t = 0.5;
    const cases: Array<[number, number]> = [
      [0, 0],
      [1, 3],
      [10, 3],
      // b = 1/6 -> level = 0.5, base = 0, frac = 0.5 === t -> base = 0
      [1 / 6, 0],
      // b = 1/3 -> level = 1, base = 1, frac = 0 <= t -> base = 1
      [1 / 3, 1],
      // b = 0.5 -> level = 1.5, base = 1, frac = 0.5 === t -> base = 1
      [0.5, 1],
      // b = 0.6 -> level = 1.8, base = 1, frac = 0.8 > t -> base + 1 = 2
      [0.6, 2],
      // b = 2/3 -> level = 2, base = 2, frac = 0 <= t -> base = 2
      [2 / 3, 2],
      // b = 0.9 -> level = 2.7, base = 2, frac = 0.7 > t -> base + 1 = 3
      [0.9, 3],
    ];
    for (const [b, expected] of cases) {
      expect(toneLevel(b, t, 3)).toBeCloseTo(expected, 10);
    }
  });

  it('never exceeds `tones` and is never negative', () => {
    for (const tones of [2, 3, 5]) {
      for (const t of THRESHOLDS) {
        for (const b of [-1, 0, 0.1, 0.5, 0.9, 1, 2, NaN]) {
          const level = toneLevel(b, t, tones);
          expect(level).toBeGreaterThanOrEqual(0);
          expect(level).toBeLessThanOrEqual(tones);
        }
      }
    }
  });
});

describe('toPalette', () => {
  it('wraps a single string into a one-element palette', () => {
    expect(toPalette('#8232ff')).toEqual(['#8232ff']);
  });

  it('copies an array as given, darkest first', () => {
    const input = ['#111', '#888', '#fff'];
    const palette = toPalette(input);
    expect(palette).toEqual(input);
    expect(palette).not.toBe(input); // a copy, not the same reference
  });

  it('falls back to DEFAULTS.fg for an empty array', () => {
    expect(toPalette([])).toEqual([DEFAULTS.fg]);
  });
});

describe('hasCurrentColor', () => {
  it('is true when any entry is the currentColor token', () => {
    expect(hasCurrentColor(['#111', CURRENT_COLOR])).toBe(true);
    expect(hasCurrentColor([CURRENT_COLOR])).toBe(true);
  });

  it('matches the token case-insensitively, as CSS keywords do', () => {
    expect(hasCurrentColor(['CURRENTCOLOR'])).toBe(true);
    expect(hasCurrentColor(['CurrentColor'])).toBe(true);
  });

  it('is false when no entry is the token', () => {
    expect(hasCurrentColor(['#111', '#fff'])).toBe(false);
    expect(hasCurrentColor([])).toBe(false);
  });
});

describe('resolvePalette', () => {
  it('replaces every currentColor entry with the resolved color', () => {
    expect(resolvePalette([CURRENT_COLOR, '#fff', CURRENT_COLOR], 'rgb(1, 2, 3)')).toEqual([
      'rgb(1, 2, 3)',
      '#fff',
      'rgb(1, 2, 3)',
    ]);
  });

  it('leaves non-token entries untouched', () => {
    expect(resolvePalette(['#111', '#fff'], 'rgb(1, 2, 3)')).toEqual(['#111', '#fff']);
  });

  it('falls back to DEFAULTS.fg for an empty resolved color', () => {
    expect(resolvePalette([CURRENT_COLOR], '')).toEqual([DEFAULTS.fg]);
  });
});

// Round-2 review finding 3: `Palette` (the type the library hands back to
// callers, e.g. from `toPalette`) is `readonly string[]`, but until this
// fix `DitheredOptions.fg` was `string | string[]` — a *mutable* array
// type readonly string[] cannot be assigned to. So a caller who received a
// `Palette` (or wrote `fg={[...] as const}`) could not pass it back in as
// `fg`, e.g. `TS2322: The type 'readonly string[]' is 'readonly' and
// cannot be assigned to the mutable type 'string[]'`. This doesn't assert
// anything at runtime; its job is purely that the file fails to typecheck
// (`pnpm typecheck`) if `DitheredOptions.fg` regresses to `string |
// string[]`.
describe('DitheredOptions.fg accepts a Palette (type-level)', () => {
  it('a readonly Palette value type-checks as fg', () => {
    const palette: Palette = toPalette(['#a00', '#0a0']);
    const options: DitheredOptions = {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      fg: palette,
    };
    expect(options.fg).toBe(palette);
  });
});
