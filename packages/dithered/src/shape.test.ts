import { describe, expect, it } from 'vitest';
import { jsHitTester } from './core/path-hit-test';
import { BAYER_4, aspectOf, defaultRowsFor, sampleCells, type Shape } from './shape';
import { BLUE_NOISE_16, resolveMatrix } from './matrix';
import { rozenite } from './shapes';

const SQUARE: Shape = {
  path: 'M0 0 H10 V10 H0 Z',
  viewBox: { x: 0, y: 0, width: 10, height: 10 },
};

const ACCEPT_ALL = () => true;

describe('BAYER_4', () => {
  it('has 16 distinct entries covering 0..15', () => {
    const values = BAYER_4.flat();
    expect(values).toHaveLength(16);
    expect(new Set(values).size).toBe(16);
    expect([...values].sort((a, b) => a - b)).toEqual(Array.from({ length: 16 }, (_, i) => i));
  });

  it('is arranged as the classic 4x4 Bayer matrix', () => {
    expect(BAYER_4).toEqual([
      [0, 8, 2, 10],
      [12, 4, 14, 6],
      [3, 11, 1, 9],
      [15, 7, 13, 5],
    ]);
  });

  it('produces thresholds strictly between 0 and 1', () => {
    for (const row of BAYER_4) {
      for (const v of row) {
        const threshold = (v + 0.5) / 16;
        expect(threshold).toBeGreaterThan(0);
        expect(threshold).toBeLessThan(1);
      }
    }
  });
});

describe('aspectOf', () => {
  it('computes width / height', () => {
    expect(aspectOf({ path: '', viewBox: { x: 0, y: 0, width: 20, height: 10 } })).toBe(2);
  });
});

describe('sampleCells', () => {
  it('samples cols*rows cells when everything is inside the path', () => {
    const cols = 4;
    const rows = 5;
    const cells = sampleCells(SQUARE, cols, ACCEPT_ALL, rows);

    expect(cells).toHaveLength(cols * rows);
    for (const c of cells) {
      expect(c.u).toBeGreaterThanOrEqual(-0.5);
      expect(c.u).toBeLessThanOrEqual(0.5);
      expect(c.v).toBeGreaterThanOrEqual(-0.5);
      expect(c.v).toBeLessThanOrEqual(0.5);
      expect(c.i).toBeGreaterThanOrEqual(0);
      expect(c.i).toBeLessThan(cols);
      expect(c.j).toBeGreaterThanOrEqual(0);
      expect(c.j).toBeLessThan(rows);
      expect(c.threshold).toBeGreaterThan(0);
      expect(c.threshold).toBeLessThan(1);
    }

    // i/j indices present exactly once each, covering the full grid.
    const seen = new Set(cells.map((c) => `${c.i},${c.j}`));
    expect(seen.size).toBe(cols * rows);
  });

  it('defaults rows from the shape aspect ratio when omitted', () => {
    const wide: Shape = {
      path: 'M0 0 H20 V10 H0 Z',
      viewBox: { x: 0, y: 0, width: 20, height: 10 },
    };
    const cells = sampleCells(wide, 8, ACCEPT_ALL);
    // aspect = 2, so rows = round(8 / 2) = 4
    const maxJ = Math.max(...cells.map((c) => c.j));
    expect(maxJ).toBe(3);
  });

  it('keeps only cells the hit tester accepts (left half)', () => {
    const cells = sampleCells(SQUARE, 10, (px) => px < 5, 10); // left half of the 10-wide viewBox

    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.u).toBeLessThan(0);
    }
  });

  it('passes hit-test points in the shape viewBox coordinate space', () => {
    const offset: Shape = {
      path: 'M100 200 H110 V210 H100 Z',
      viewBox: { x: 100, y: 200, width: 10, height: 10 },
    };
    const seen: Array<[number, number]> = [];
    sampleCells(
      offset,
      2,
      (x, y) => {
        seen.push([x, y]);
        return true;
      },
      2,
    );

    expect(seen).toEqual([
      [102.5, 202.5],
      [107.5, 202.5],
      [102.5, 207.5],
      [107.5, 207.5],
    ]);
  });
});

describe('defaultRowsFor', () => {
  it('keeps cells roughly square', () => {
    const wide: Shape = { path: '', viewBox: { x: 0, y: 0, width: 20, height: 10 } };
    expect(defaultRowsFor(wide, 8)).toBe(4);
  });

  it('never returns fewer than one row', () => {
    const veryWide: Shape = { path: '', viewBox: { x: 0, y: 0, width: 1000, height: 1 } };
    expect(defaultRowsFor(veryWide, 4)).toBe(1);
  });
});

// ---------------------------------------------------------------------------
// sampleCells + matrix — the default-output guarantee
// ---------------------------------------------------------------------------

// A small corner of `rozenite`'s viewBox, so the snapshots below stay
// readable while still exercising the real shape and its aspect ratio.
const { x: rx, y: ry, width: rw, height: rh } = rozenite.viewBox;
const corner = (px: number, py: number) => px < rx + rw / 6 && py < ry + rh / 6;

describe('sampleCells default matrix (no regression)', () => {
  it('at cols = 16 (the default), thresholds match the committed snapshot and the today-formula', () => {
    const cells = sampleCells(rozenite, 16, corner);
    expect(cells.map((c) => c.threshold)).toMatchInlineSnapshot(`
      [
        0.03125,
        0.53125,
        0.15625,
        0.78125,
        0.28125,
        0.90625,
        0.21875,
        0.71875,
        0.09375,
        0.96875,
        0.46875,
        0.84375,
      ]
    `);
    for (const c of cells) {
      expect(c.threshold).toBe((BAYER_4[c.j % 4][c.i % 4] + 0.5) / 16);
    }
  });

  it('at cols = 33, a size the 4x4 tile does not evenly divide, thresholds still match the today-formula', () => {
    const cells = sampleCells(rozenite, 33, corner);
    expect(cells.map((c) => c.threshold)).toMatchInlineSnapshot(`
      [
        0.03125,
        0.53125,
        0.15625,
        0.65625,
        0.03125,
        0.78125,
        0.28125,
        0.90625,
        0.40625,
        0.78125,
        0.21875,
        0.71875,
        0.09375,
        0.59375,
        0.21875,
        0.96875,
        0.46875,
        0.84375,
        0.34375,
        0.96875,
        0.03125,
        0.53125,
        0.15625,
        0.65625,
        0.03125,
        0.78125,
        0.28125,
        0.90625,
        0.40625,
        0.78125,
        0.21875,
        0.71875,
        0.09375,
        0.59375,
        0.21875,
        0.96875,
        0.46875,
        0.84375,
        0.34375,
        0.96875,
      ]
    `);
    for (const c of cells) {
      expect(c.threshold).toBe((BAYER_4[c.j % 4][c.i % 4] + 0.5) / 16);
    }
  });
});

describe('sampleCells with a matrix argument', () => {
  it("'bayer8' and blueNoise both produce thresholds in (0, 1), differing from the bayer4 default", () => {
    const defaultCells = sampleCells(rozenite, 16, corner);
    const bayer8Cells = sampleCells(rozenite, 16, corner, undefined, 'bayer8');
    const blueNoiseCells = sampleCells(rozenite, 16, corner, undefined, BLUE_NOISE_16);

    for (const cells of [bayer8Cells, blueNoiseCells]) {
      expect(cells).toHaveLength(defaultCells.length);
      for (const c of cells) {
        expect(c.threshold).toBeGreaterThan(0);
        expect(c.threshold).toBeLessThan(1);
      }
    }

    expect(bayer8Cells.map((c) => c.threshold)).not.toEqual(defaultCells.map((c) => c.threshold));
    expect(blueNoiseCells.map((c) => c.threshold)).not.toEqual(
      defaultCells.map((c) => c.threshold),
    );
  });

  it('tiles a custom matrix across the grid', () => {
    const custom = [
      [0, 1],
      [2, 3],
    ];
    // Rank mode, entry count 4: threshold = (v + 0.5) / 4.
    const expectedThresholds = custom.map((row) => row.map((v) => (v + 0.5) / 4));
    const cells = sampleCells(SQUARE, 4, ACCEPT_ALL, 4, custom);
    for (const c of cells) {
      expect(c.threshold).toBe(expectedThresholds[c.j % 2][c.i % 2]);
    }
  });

  // Regression: only a raw `BLUE_NOISE_16` array or the `'bayer8'` name was
  // ever driven through `sampleCells`/the renderer/react/native tests, so
  // `builtinMatrix`'s `case 'blueNoise'` was reachable only from
  // `resolveMatrix('blueNoise')` in matrix.test.ts — an implementation bug
  // returning `BAYER_8` for that case would have stayed green everywhere
  // else, including `<Dithered matrix="blueNoise">` and the playground select.
  it("the 'blueNoise' name, driven through sampleCells, matches resolveMatrix(BLUE_NOISE_16) and not bayer8", () => {
    const namedCells = sampleCells(rozenite, 16, corner, undefined, 'blueNoise');
    const arrayCells = sampleCells(rozenite, 16, corner, undefined, BLUE_NOISE_16);
    const bayer8Cells = sampleCells(rozenite, 16, corner, undefined, 'bayer8');

    expect(namedCells.map((c) => c.threshold)).toEqual(arrayCells.map((c) => c.threshold));
    expect(namedCells.map((c) => c.threshold)).not.toEqual(bayer8Cells.map((c) => c.threshold));

    const resolved = resolveMatrix(BLUE_NOISE_16);
    for (const c of namedCells) {
      expect(c.threshold).toBe(resolved.thresholds[c.j % 16][c.i % 16]);
    }
  });

  // Regression: the only prior custom-matrix sampling test used a 2x2
  // array on a 4x4 grid, which cannot catch a `(i, j)` axis mixup that
  // only shows once `width !== height` — an implementation reading
  // `thresholds[j % width][i % height]` would pass that test but index
  // out of bounds (or wrap wrong) here.
  it('tiles a non-square custom matrix across the grid, respecting width vs height', () => {
    // 3 wide x 2 tall.
    const custom = [
      [0, 1, 2],
      [3, 4, 5],
    ];
    // Rank mode, entry count 6: threshold = (v + 0.5) / 6.
    const expectedThresholds = custom.map((row) => row.map((v) => (v + 0.5) / 6));
    const cells = sampleCells(SQUARE, 6, ACCEPT_ALL, 6, custom);
    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.threshold).toBe(expectedThresholds[c.j % 2][c.i % 3]);
    }
  });

  it('throws for a ragged custom matrix', () => {
    const ragged = [
      [0, 1, 2],
      [1, 2],
    ];
    expect(() => sampleCells(SQUARE, 4, ACCEPT_ALL, 4, ragged)).toThrow(/ragged/);
  });
});

describe('sampleCells default hitTest', () => {
  it('omitting hitTest is equivalent to passing jsHitTester(shape) explicitly', () => {
    expect(sampleCells(SQUARE, 16)).toEqual(sampleCells(SQUARE, 16, jsHitTester(SQUARE)));
  });

  it('still honours an explicitly passed hitTest (a tester rejecting everything samples nothing)', () => {
    expect(sampleCells(SQUARE, 16, () => false)).toEqual([]);
  });
});
