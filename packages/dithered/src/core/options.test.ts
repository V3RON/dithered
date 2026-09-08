import { describe, expect, it } from 'vitest';
import { SQUARE_SHAPE } from '../test-utils';
import { effectiveDpr, fitSize, resolveSizePx, surfaceSize } from './options';

describe('fitSize', () => {
  it('contains a square aspect inside a wider box, picking the limiting height', () => {
    expect(fitSize(400, 100, 1)).toBe(100);
  });

  it('contains a square aspect inside a taller box, picking the limiting width', () => {
    expect(fitSize(100, 400, 1)).toBe(100);
  });

  it('handles a non-square aspect ratio', () => {
    // aspect 2 (wide): width = height * 2. Box is 100x100 -> width-limited
    // fit would be height = 50 (width 100), height-limited fit would be
    // height = 100 (width 200, too wide). The smaller wins: 50.
    expect(fitSize(100, 100, 2)).toBe(50);
    // A box wide enough for the full height fit (aspect 2, height 100 needs
    // width 200) returns the full height.
    expect(fitSize(300, 100, 2)).toBe(100);
  });

  it('returns 0 for a degenerate content box', () => {
    expect(fitSize(0, 100, 1)).toBe(0);
    expect(fitSize(100, 0, 1)).toBe(0);
    expect(fitSize(-10, 100, 1)).toBe(0);
    expect(fitSize(100, -10, 1)).toBe(0);
  });

  it('returns 0 for a non-finite or non-positive aspect ratio', () => {
    expect(fitSize(100, 100, 0)).toBe(0);
    expect(fitSize(100, 100, -1)).toBe(0);
    expect(fitSize(100, 100, Infinity)).toBe(0);
    expect(fitSize(100, 100, NaN)).toBe(0);
  });
});

describe('resolveSizePx', () => {
  it('passes a numeric size through unchanged', () => {
    expect(resolveSizePx(48)).toBe(48);
    expect(resolveSizePx(0)).toBe(0);
  });

  it("throws a clear, web-only error for 'fill'", () => {
    expect(() => resolveSizePx('fill')).toThrow(/web-only/i);
    expect(() => resolveSizePx('fill')).toThrow(/style/i);
  });
});

describe('effectiveDpr', () => {
  it('clamps the raw ratio to maxDpr', () => {
    expect(effectiveDpr(4, 3)).toBe(3);
    expect(effectiveDpr(2, 3)).toBe(2);
  });

  it('treats a non-finite or non-positive raw ratio as 1', () => {
    expect(effectiveDpr(0, 3)).toBe(1);
    expect(effectiveDpr(-1, 3)).toBe(1);
    expect(effectiveDpr(NaN, 3)).toBe(1);
    expect(effectiveDpr(Infinity, 3)).toBe(1); // non-finite raw reads as 1, then clamped
  });

  it('clamps maxDpr itself to at least 1', () => {
    expect(effectiveDpr(2, 0)).toBe(1);
    expect(effectiveDpr(2, -5)).toBe(1);
    expect(effectiveDpr(2, NaN)).toBe(1);
  });
});

describe('surfaceSize', () => {
  it('derives width from the shape aspect ratio at a given size', () => {
    // SQUARE_SHAPE is 10x10 -> aspect 1.
    expect(surfaceSize(48, SQUARE_SHAPE)).toEqual({ width: 48, height: 48 });
  });

  it('scales both dimensions by `scale`', () => {
    expect(surfaceSize(48, SQUARE_SHAPE, 2)).toEqual({ width: 96, height: 96 });
  });

  it('leaves the result unrounded', () => {
    const { width, height } = surfaceSize(48, SQUARE_SHAPE, 2.5);
    expect(width).toBeCloseTo(120);
    expect(height).toBeCloseTo(120);
  });
});
