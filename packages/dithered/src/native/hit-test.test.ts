import { describe, expect, it, vi } from 'vitest';

const makeFromSVGString = vi.fn();

vi.mock('@shopify/react-native-skia', () => ({
  Skia: { Path: { MakeFromSVGString: (d: string) => makeFromSVGString(d) } },
}));

const { skiaHitTester } = await import('./hit-test');
const { sampleCells } = await import('../shape');
const { SQUARE_SHAPE } = await import('../test-utils');

describe('skiaHitTester', () => {
  it('delegates to SkPath.contains', () => {
    const contains = vi.fn((x: number) => x < 5);
    makeFromSVGString.mockReturnValueOnce({ contains });

    const hitTest = skiaHitTester(SQUARE_SHAPE);

    expect(makeFromSVGString).toHaveBeenCalledWith(SQUARE_SHAPE.path);
    expect(hitTest(1, 1)).toBe(true);
    expect(hitTest(9, 1)).toBe(false);
    expect(contains).toHaveBeenCalledTimes(2);
  });

  it('parses the path once, not per point', () => {
    makeFromSVGString.mockClear();
    makeFromSVGString.mockReturnValueOnce({ contains: () => true });

    sampleCells(SQUARE_SHAPE, 4, skiaHitTester(SQUARE_SHAPE), 4);

    expect(makeFromSVGString).toHaveBeenCalledTimes(1);
  });

  it('explains itself when Skia cannot parse the path', () => {
    makeFromSVGString.mockReturnValueOnce(null);

    expect(() => skiaHitTester({ ...SQUARE_SHAPE, path: 'not a path' })).toThrow(
      /could not parse/i,
    );
  });
});
