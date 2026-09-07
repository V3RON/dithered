import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

// `createPicture`'s draw callback is never invoked here — these tests are
// about the currentColor guard and the memo's dependency shape, neither of
// which touches actual drawing (that's `paint-context.test.ts`'s job), so
// there is no need to mock a fake `SkCanvas` for it.
vi.mock('@shopify/react-native-skia', () => ({
  Skia: {
    XYWHRect: (x: number, y: number, width: number, height: number): FakeRect => ({
      x,
      y,
      width,
      height,
    }),
  },
  createPicture: vi.fn((_draw: (canvas: unknown) => void, bounds: FakeRect) => ({ bounds })),
}));

// Real hit-testing is `./hit-test.test.ts`'s job; these tests are about the
// currentColor guard and the memo's dependency shape, so every sampled
// point is accepted.
vi.mock('./hit-test', () => ({
  skiaHitTester: () => () => true,
}));

const { useDitheredPictures } = await import('./pictures');
const { SQUARE_SHAPE } = await import('../test-utils');

describe('useDitheredPictures: currentColor is native-only unsupported', () => {
  it('throws when fg is the currentColor token', () => {
    expect(() =>
      renderHook(() =>
        useDitheredPictures({ shape: SQUARE_SHAPE, brightness: () => true, fg: 'currentColor' }),
      ),
    ).toThrow(/currentColor.*not supported on native/i);
  });

  it('throws when a currentColor token (any case) appears anywhere in a palette', () => {
    expect(() =>
      renderHook(() =>
        useDitheredPictures({
          shape: SQUARE_SHAPE,
          brightness: () => true,
          fg: ['#000', 'CURRENTCOLOR'],
        }),
      ),
    ).toThrow(/currentColor.*not supported on native/i);
  });

  it('does not throw for an ordinary palette', () => {
    expect(() =>
      renderHook(() =>
        useDitheredPictures({
          shape: SQUARE_SHAPE,
          brightness: () => true,
          fg: ['#111', '#222', '#333'],
        }),
      ),
    ).not.toThrow();
  });
});

describe('useDitheredPictures: memo stability', () => {
  // Stable across renders: an inline `() => true` literal in the render
  // callback below would itself be a fresh identity every render, which
  // would invalidate the memo regardless of `fg` and defeat the point of
  // these tests.
  const brightness = () => true;

  it('keeps the same `pictures` reference when fg is a new, equal-by-value array', () => {
    const { result, rerender } = renderHook(
      ({ fg }: { fg: string[] }) =>
        useDitheredPictures({ shape: SQUARE_SHAPE, brightness, frames: 3, fg }),
      { initialProps: { fg: ['#111', '#222'] } },
    );
    const first = result.current.pictures;

    rerender({ fg: ['#111', '#222'] }); // a fresh array, same values

    expect(result.current.pictures).toBe(first);
  });

  it('re-records when fg actually changes value', () => {
    const { result, rerender } = renderHook(
      ({ fg }: { fg: string[] }) =>
        useDitheredPictures({ shape: SQUARE_SHAPE, brightness, frames: 3, fg }),
      { initialProps: { fg: ['#111', '#222'] } },
    );
    const first = result.current.pictures;

    rerender({ fg: ['#111', '#333'] });

    expect(result.current.pictures).not.toBe(first);
  });
});
