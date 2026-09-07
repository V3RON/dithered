import { describe, expect, it, vi } from 'vitest';
import { domHitTester } from './hit-test';
import { sampleCells, type Shape } from './shape';
import { stubGetContext } from './test-utils';

const SQUARE: Shape = {
  path: 'M0 0 H10 V10 H0 Z',
  viewBox: { x: 0, y: 0, width: 10, height: 10 },
};

function fakeContext(accept: (x: number, y: number) => boolean) {
  return {
    isPointInPath: vi.fn((_path: unknown, x: number, y: number) => accept(x, y)),
  } as unknown as CanvasRenderingContext2D;
}

describe('domHitTester', () => {
  it('delegates to isPointInPath on the supplied context', () => {
    const ctx = fakeContext((x) => x < 5);
    const hitTest = domHitTester(SQUARE, ctx);

    expect(hitTest(1, 1)).toBe(true);
    expect(hitTest(9, 1)).toBe(false);
    expect(ctx.isPointInPath).toHaveBeenCalledTimes(2);
  });

  it('builds the Path2D once, not per point', () => {
    const ctx = fakeContext(() => true);
    const construct = vi.fn();
    vi.stubGlobal(
      'Path2D',
      class {
        constructor(d?: string) {
          construct(d);
        }
      },
    );

    try {
      const hitTest = domHitTester(SQUARE, ctx);
      sampleCells(SQUARE, 4, hitTest, 4);
      expect(construct).toHaveBeenCalledTimes(1);
      expect(construct).toHaveBeenCalledWith(SQUARE.path);
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('falls back to a scratch canvas when no context is given', () => {
    const { stub, restore } = stubGetContext(fakeContext((x) => x < 5));

    try {
      expect(domHitTester(SQUARE)(1, 1)).toBe(true);
      expect(domHitTester(SQUARE)(9, 1)).toBe(false);
      expect(stub).toHaveBeenCalledWith('2d');
    } finally {
      restore();
    }
  });

  it('explains itself when no 2D context can be created', () => {
    const { restore } = stubGetContext(null);

    try {
      expect(() => domHitTester(SQUARE)).toThrow(/2D canvas context/);
    } finally {
      restore();
    }
  });
});
