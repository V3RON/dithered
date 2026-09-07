import { describe, expect, it } from 'vitest';
import { BAYER_4, aspectOf, defaultRowsFor, sampleCells, type Shape } from './shape';

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
