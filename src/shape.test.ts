import { beforeAll, describe, expect, it } from 'vitest';
import { BAYER_4, aspectOf, sampleCells, type Shape } from './shape';

// jsdom does not implement Path2D. sampleCells only needs a constructible
// stand-in — the mocked isPointInPath below never inspects the path itself.
beforeAll(() => {
  if (typeof globalThis.Path2D === 'undefined') {
    (globalThis as { Path2D?: unknown }).Path2D = class {
      constructor(_d?: string) {}
    };
  }
});

const SQUARE: Shape = {
  path: 'M0 0 H10 V10 H0 Z',
  viewBox: { x: 0, y: 0, width: 10, height: 10 },
};

function mockContext(accept: (px: number, py: number) => boolean): CanvasRenderingContext2D {
  return {
    isPointInPath: (_path: unknown, px: number, py: number) => accept(px, py),
  } as unknown as CanvasRenderingContext2D;
}

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
    const ctx = mockContext(() => true);
    const cols = 4;
    const rows = 5;
    const cells = sampleCells(SQUARE, cols, rows, ctx);

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
    const ctx = mockContext(() => true);
    const wide: Shape = {
      path: 'M0 0 H20 V10 H0 Z',
      viewBox: { x: 0, y: 0, width: 20, height: 10 },
    };
    const cells = sampleCells(wide, 8, undefined, ctx);
    // aspect = 2, so rows = round(8 / 2) = 4
    const maxJ = Math.max(...cells.map((c) => c.j));
    expect(maxJ).toBe(3);
  });

  it('keeps only cells accepted by isPointInPath (left half)', () => {
    const ctx = mockContext((px) => px < 5); // left half of the 10-wide viewBox
    const cells = sampleCells(SQUARE, 10, 10, ctx);

    expect(cells.length).toBeGreaterThan(0);
    for (const c of cells) {
      expect(c.u).toBeLessThan(0);
    }
  });
});
