import { describe, expect, it } from 'vitest';
import {
  BAYER_2,
  BAYER_4,
  BAYER_8,
  BLUE_NOISE_16,
  bayerMatrix,
  resolveMatrix,
  thresholdFor,
} from './matrix';

// The classic 4x4 table `shape.ts` used to hold as a literal, pinned here
// so `bayerMatrix(4)` is checked against a hand-written source of truth
// rather than only against itself.
const CLASSIC_BAYER_4 = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

// The classic 8x8 table, likewise hand-written rather than generated, so a
// mistake in `bayerMatrix`'s recurrence is caught rather than silently
// shipped as "some ordered matrix".
const CLASSIC_BAYER_8 = [
  [0, 32, 8, 40, 2, 34, 10, 42],
  [48, 16, 56, 24, 50, 18, 58, 26],
  [12, 44, 4, 36, 14, 46, 6, 38],
  [60, 28, 52, 20, 62, 30, 54, 22],
  [3, 35, 11, 43, 1, 33, 9, 41],
  [51, 19, 59, 27, 49, 17, 57, 25],
  [15, 47, 7, 39, 13, 45, 5, 37],
  [63, 31, 55, 23, 61, 29, 53, 21],
];

function isPermutation(values: readonly number[], n: number): boolean {
  const sorted = [...values].sort((a, b) => a - b);
  return sorted.every((v, k) => v === k) && sorted.length === n;
}

describe('bayerMatrix', () => {
  it('bayerMatrix(2) equals the BAYER_2 literal', () => {
    expect(bayerMatrix(2)).toEqual([
      [0, 2],
      [3, 1],
    ]);
    expect(bayerMatrix(2)).toBe(BAYER_2); // order 2 returns BAYER_2 itself
  });

  it('bayerMatrix(4) matches the classic 4x4 table', () => {
    expect(bayerMatrix(4)).toEqual(CLASSIC_BAYER_4);
    expect(BAYER_4).toEqual(CLASSIC_BAYER_4);
  });

  it('bayerMatrix(8) matches the classic 8x8 table', () => {
    expect(bayerMatrix(8)).toEqual(CLASSIC_BAYER_8);
    expect(BAYER_8).toEqual(CLASSIC_BAYER_8);
  });

  it('is a permutation of 0..n^2-1 for n = 2, 4, 8, 16', () => {
    for (const n of [2, 4, 8, 16]) {
      const flat = bayerMatrix(n).flat();
      expect(isPermutation(flat, n * n)).toBe(true);
    }
  });

  it('throws for non-powers-of-two, values below 2, and non-integers', () => {
    for (const bad of [0, 1, 3, 6, -4, 2.5]) {
      expect(() => bayerMatrix(bad)).toThrow(/power of two/);
    }
  });
});

describe('resolveMatrix — named matrices', () => {
  it("resolveMatrix('bayer4') reproduces today's (v + 0.5) / 16 formula", () => {
    const { thresholds, width, height } = resolveMatrix('bayer4');
    expect(width).toBe(4);
    expect(height).toBe(4);
    for (let j = 0; j < 4; j++) {
      for (let i = 0; i < 4; i++) {
        expect(thresholds[j][i]).toBe((BAYER_4[j][i] + 0.5) / 16);
      }
    }
  });

  it('every named matrix resolves to thresholds strictly inside (0, 1), with the right size', () => {
    const expectations: Array<[string, number, number]> = [
      ['bayer2', 2, 2],
      ['bayer4', 4, 4],
      ['bayer8', 8, 8],
      ['blueNoise', 16, 16],
    ];
    for (const [name, width, height] of expectations) {
      const resolved = resolveMatrix(name as 'bayer2' | 'bayer4' | 'bayer8' | 'blueNoise');
      expect(resolved.width).toBe(width);
      expect(resolved.height).toBe(height);
      for (const row of resolved.thresholds) {
        for (const t of row) {
          expect(t).toBeGreaterThan(0);
          expect(t).toBeLessThan(1);
        }
      }
    }
  });

  it('memoizes: repeated calls with the same name return the identical object', () => {
    expect(resolveMatrix('bayer8')).toBe(resolveMatrix('bayer8'));
  });

  it('memoizes: repeated calls with the same custom array reference return the identical object', () => {
    const custom = [
      [0, 1],
      [2, 3],
    ];
    expect(resolveMatrix(custom)).toBe(resolveMatrix(custom));
  });
});

describe('resolveMatrix — rank vs float normalization', () => {
  it('rank mode: an all-integer matrix normalizes by entry count', () => {
    const { thresholds } = resolveMatrix([
      [0, 1],
      [2, 3],
    ]);
    expect(thresholds).toEqual([
      [0.125, 0.375],
      [0.625, 0.875],
    ]);
  });

  it('rank mode allows ties and gaps without throwing', () => {
    expect(() =>
      resolveMatrix([
        [0, 0],
        [3, 3],
      ]),
    ).not.toThrow();
  });

  it('float mode: non-integer entries pass through unchanged, with no +0.5 shift', () => {
    const { thresholds } = resolveMatrix([
      [0.1, 0.9],
      [0.5, 0.25],
    ]);
    expect(thresholds).toEqual([
      [0.1, 0.9],
      [0.5, 0.25],
    ]);
  });

  // The ADR is explicit that the rank divisor is the entry *count*
  // (width * height) — not width*width, not height*height, and not
  // max-entry-plus-one. Every other fixture in this file is square (so
  // width*width and height*height coincide with the right answer) and
  // uses a dense 0..n-1 permutation (so max+1 also coincides). These two
  // fixtures are non-square *and* carry a tied top rank, so all three
  // wrong divisors diverge from the correct one (8) and from each other.
  it('rank mode: a non-square 4-wide x 2-tall matrix normalizes by entry count (8), not width*width, height*height, or max+1', () => {
    const { thresholds, width, height } = resolveMatrix([
      [0, 1, 2, 3],
      [4, 5, 6, 6],
    ]);
    expect(width).toBe(4);
    expect(height).toBe(2);
    expect(thresholds).toEqual([
      [0.0625, 0.1875, 0.3125, 0.4375],
      [0.5625, 0.6875, 0.8125, 0.8125],
    ]);
  });

  it('rank mode: a non-square 2-wide x 4-tall matrix normalizes by entry count (8), not width*width, height*height, or max+1', () => {
    const { thresholds, width, height } = resolveMatrix([
      [0, 1],
      [2, 3],
      [4, 5],
      [6, 6],
    ]);
    expect(width).toBe(2);
    expect(height).toBe(4);
    expect(thresholds).toEqual([
      [0.0625, 0.1875],
      [0.3125, 0.4375],
      [0.5625, 0.6875],
      [0.8125, 0.8125],
    ]);
  });

  it('an all-0/1 integer matrix is read as ranks, not as ready-made thresholds', () => {
    const { thresholds } = resolveMatrix([
      [0, 1],
      [1, 0],
    ]);
    expect(thresholds).toEqual([
      [0.125, 0.375],
      [0.375, 0.125],
    ]);
  });
});

describe('resolveMatrix — validation', () => {
  const cases: Array<[string, unknown, RegExp]> = [
    ['ragged rows', [[0, 1, 2, 3], [1], [2, 3, 4]], /ragged: row 1 has 1 entries, but row 0 has 4/],
    ['no rows', [], /at least one row/],
    ['empty first row', [[]], /at least one column/],
    ['NaN entry', [[0, Number.NaN]], /not a finite number/],
    ['Infinity entry', [[0, Number.POSITIVE_INFINITY]], /not a finite number/],
    [
      'rank above n - 1 (square)',
      [
        [0, 1],
        [2, 20],
      ],
      /outside the rank range 0\.\.3/,
    ],
    // Pins the range bound to width*height (8) on a non-square matrix,
    // not width*width (16) or height*height (4) — either of those would
    // report a different (wrong) range for this same input.
    [
      'rank above n - 1 (non-square, 4x2)',
      [
        [0, 1, 2, 3],
        [4, 5, 6, 8],
      ],
      /outside the rank range 0\.\.7/,
    ],
    ['negative rank', [[-1, 0]], /outside the rank range/],
    ['float above 1', [[0.1, 1.5]], /outside the range 0\.\.1/],
    ['negative float', [[0.1, -0.2]], /outside the range 0\.\.1/],
    ['non-array', 'not-an-array', /2D array of numbers/],
    ['array of non-arrays', [1, 2, 3], /2D array of numbers/],
  ];

  it.each(cases)('%s throws with a matching message', (_label, matrix, pattern) => {
    // eslint-disable-next-line @typescript-eslint/no-explicit-any -- deliberately malformed input
    expect(() => resolveMatrix(matrix as any)).toThrow(pattern);
  });

  it('unknown name throws naming the built-ins', () => {
    expect(() => resolveMatrix('nope' as 'bayer4')).toThrow(
      /unknown matrix 'nope'.*bayer2.*bayer4.*bayer8.*blueNoise/s,
    );
  });
});

describe('thresholdFor', () => {
  it('tiles a non-square 2-wide x 3-tall matrix over a 5x7 grid', () => {
    const matrix = [
      [0.1, 0.2],
      [0.3, 0.4],
      [0.5, 0.6],
    ];
    for (let j = 0; j < 7; j++) {
      for (let i = 0; i < 5; i++) {
        expect(thresholdFor(matrix, i, j)).toBe(matrix[j % 3][i % 2]);
      }
    }
  });

  it('accepts a name, a raw array, and an already-resolved matrix, and agrees across all three', () => {
    const raw = [
      [0, 1],
      [2, 3],
    ];
    const resolved = resolveMatrix(raw);
    for (const i of [0, 1, 2, 5]) {
      for (const j of [0, 1, 3]) {
        expect(thresholdFor(raw, i, j)).toBe(thresholdFor(resolved, i, j));
      }
    }
    expect(thresholdFor('bayer4', 1, 2)).toBe(thresholdFor(resolveMatrix('bayer4'), 1, 2));
  });

  it('wraps negative i/j into a real cell instead of returning undefined', () => {
    const matrix = [
      [0.1, 0.2],
      [0.3, 0.4],
    ];
    expect(thresholdFor(matrix, -1, -1)).toBe(matrix[1][1]);
    expect(thresholdFor(matrix, -2, 0)).toBe(matrix[0][0]);
  });
});

describe('resolveMatrix / thresholdFor — hand-built ResolvedMatrix', () => {
  // `ResolvedMatrix` is exported, so a caller can legally build one without
  // ever calling `resolveMatrix`. It must be accepted (and validated) on
  // its own terms rather than misdiagnosed as a malformed 2D array.
  it('a hand-built valid ResolvedMatrix round-trips through resolveMatrix and thresholdFor, agreeing with the branded one', () => {
    const handBuilt = {
      width: 2,
      height: 2,
      thresholds: [
        [0.1, 0.2],
        [0.3, 0.4],
      ],
    };
    const branded = resolveMatrix([
      [0.1, 0.2],
      [0.3, 0.4],
    ]);

    const resolved = resolveMatrix(handBuilt);
    expect(resolved.width).toBe(2);
    expect(resolved.height).toBe(2);
    expect(resolved.thresholds).toEqual(branded.thresholds);

    for (const i of [0, 1, 4]) {
      for (const j of [0, 1, 3]) {
        expect(thresholdFor(handBuilt, i, j)).toBe(thresholdFor(branded, i, j));
      }
    }
  });

  it('resolveMatrix memoizes a hand-built ResolvedMatrix by identity', () => {
    const handBuilt = { width: 1, height: 1, thresholds: [[0.5]] };
    expect(resolveMatrix(handBuilt)).toBe(resolveMatrix(handBuilt));
  });

  it('a hand-built object with a mismatched width/thresholds row length throws naming the mismatch', () => {
    const mismatched = {
      width: 2,
      height: 1,
      thresholds: [[0.1, 0.2, 0.3]],
    };
    expect(() => resolveMatrix(mismatched)).toThrow(
      /resolved matrix declares width 2 but thresholds\[0\] has 3 entries/,
    );
  });

  it('a hand-built object with a mismatched height/thresholds row count throws naming the mismatch', () => {
    const mismatched = {
      width: 2,
      height: 2,
      thresholds: [[0.1, 0.2]],
    };
    expect(() => resolveMatrix(mismatched)).toThrow(
      /resolved matrix declares height 2 but thresholds has 1 rows/,
    );
  });

  // The raw-array path (`validateAndResolve`) has always enforced `0..1`
  // on float-mode thresholds; the hand-built `ResolvedMatrix` path used to
  // skip that check entirely, silently accepting out-of-range thresholds
  // that `ResolvedMatrix`'s own jsdoc promises can't happen.
  it('rejects a threshold above 1, naming the offending coordinate', () => {
    const outOfRange = { width: 1, height: 1, thresholds: [[5]] };
    expect(() => resolveMatrix(outOfRange)).toThrow(
      /resolved matrix thresholds\[0\]\[0\] is 5, outside the range 0\.\.1/,
    );
  });

  it('rejects a threshold below 0, naming the offending coordinate', () => {
    const outOfRange = { width: 1, height: 1, thresholds: [[-3]] };
    expect(() => resolveMatrix(outOfRange)).toThrow(
      /resolved matrix thresholds\[0\]\[0\] is -3, outside the range 0\.\.1/,
    );
  });

  // The realistic mis-use the ADR calls out: handing `BAYER_4`'s raw ranks
  // straight through as a `ResolvedMatrix`'s thresholds is a plausible
  // typo, and it typechecks. It must throw rather than paint (almost)
  // nothing with no error anywhere.
  it('rejects BAYER_4 passed as thresholds directly, instead of resolving it', () => {
    const misuse = { width: 4, height: 4, thresholds: BAYER_4 };
    expect(() => resolveMatrix(misuse)).toThrow(/outside the range 0\.\.1/);
  });
});

describe('BLUE_NOISE_16', () => {
  it('is 16x16', () => {
    expect(BLUE_NOISE_16).toHaveLength(16);
    for (const row of BLUE_NOISE_16) {
      expect(row).toHaveLength(16);
    }
  });

  it('entries are exactly the permutation 0..255', () => {
    expect(isPermutation(BLUE_NOISE_16.flat(), 256)).toBe(true);
  });

  it('the 16 lowest-ranked points are spread at least 2 cells apart (toroidally)', () => {
    const n = 16;
    const points: Array<[number, number]> = [];
    for (let j = 0; j < n; j++) {
      for (let i = 0; i < n; i++) {
        if (BLUE_NOISE_16[j][i] < 16) points.push([i, j]);
      }
    }
    expect(points).toHaveLength(16);

    function toroidalDistance(a: [number, number], b: [number, number]): number {
      const dx = Math.min(Math.abs(a[0] - b[0]), n - Math.abs(a[0] - b[0]));
      const dy = Math.min(Math.abs(a[1] - b[1]), n - Math.abs(a[1] - b[1]));
      return Math.hypot(dx, dy);
    }

    let minDistance = Infinity;
    for (let a = 0; a < points.length; a++) {
      for (let b = a + 1; b < points.length; b++) {
        minDistance = Math.min(minDistance, toroidalDistance(points[a], points[b]));
      }
    }
    expect(minDistance).toBeGreaterThanOrEqual(2);
  });
});
