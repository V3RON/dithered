import { renderHook } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';
import type { Cell } from '../shape';
import type { Palette } from '../core';

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface FakeRRect {
  rect: FakeRect;
  rx: number;
  ry: number;
}
interface FakePaint {
  color: string;
  antiAlias: boolean;
  setAntiAlias(on: boolean): void;
  setColor(color: string): void;
}
type Draw =
  { op: 'rect'; rect: FakeRect; color: string } | { op: 'rrect'; rrect: FakeRRect; color: string };

interface FakePicture {
  draw: (canvas: unknown) => void;
  bounds: FakeRect;
}

function fakeCanvas() {
  const draws: Draw[] = [];
  const canvas = {
    drawRect: vi.fn((rect: FakeRect, paint: FakePaint) =>
      draws.push({ op: 'rect', rect, color: paint.color }),
    ),
    drawRRect: vi.fn((rrect: FakeRRect, paint: FakePaint) =>
      draws.push({ op: 'rrect', rrect, color: paint.color }),
    ),
  };
  return { canvas, draws };
}

/**
 * Runs every recorded picture's draw callback and counts the lit cells.
 * `pictures` is typed as `SkPicture[]` by `useDitheredPictures`, but the
 * mocked `createPicture` below actually hands back the `FakePicture`
 * shape — real in tests, opaque in production.
 */
function countDraws(pictures: readonly unknown[]): number {
  let total = 0;
  for (const picture of pictures as readonly FakePicture[]) {
    const { canvas, draws } = fakeCanvas();
    picture.draw(canvas);
    total += draws.length;
  }
  return total;
}

vi.mock('@shopify/react-native-skia', () => ({
  Skia: {
    Paint: (): FakePaint => {
      const paint: FakePaint = {
        color: '',
        antiAlias: false,
        setAntiAlias(on) {
          paint.antiAlias = on;
        },
        setColor(color) {
          paint.color = color;
        },
      };
      return paint;
    },
    Color: (color: string) => `color:${color}`,
    XYWHRect: (x: number, y: number, width: number, height: number): FakeRect => ({
      x,
      y,
      width,
      height,
    }),
    RRectXY: (rect: FakeRect, rx: number, ry: number): FakeRRect => ({ rect, rx, ry }),
  },
  // The real `createPicture` hands the draw callback a live `SkCanvas` and
  // returns an opaque `SkPicture`. The stand-in below just keeps the
  // callback around so a test can invoke it against a fake canvas later —
  // which is what both `countDraws` and the palette test below do.
  createPicture: vi.fn((draw: (canvas: unknown) => void, bounds: FakeRect) => ({ draw, bounds })),
}));

// Real hit-testing is `./hit-test.test.ts`'s job; these tests are about the
// currentColor guard, the memo's dependency shape, and that a palette or
// matrix option actually reaches drawing — none of which need real
// point-in-path testing — so every sampled point is accepted.
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

  // Round-2 review finding 3: `DitheredPicturesOptions['fg']` (via
  // `DitheredOptions`) must accept the `Palette` type the library itself
  // hands back to callers -- `readonly string[]` -- not just a mutable
  // `string[]` literal. This fails to typecheck (`pnpm typecheck`) if `fg`
  // regresses to `string | string[]`.
  it('accepts a readonly Palette value for fg (type-level)', () => {
    const palette: Palette = ['#111', '#222', '#333'];
    expect(() =>
      renderHook(() =>
        useDitheredPictures({ shape: SQUARE_SHAPE, brightness: () => true, fg: palette }),
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

// ---------------------------------------------------------------------------
// useDitheredPictures: a palette reaches drawing, end-to-end
//
// The two describe blocks above never invoke a recorded picture's `draw`
// callback, so neither proves a palette actually flows from
// `useDitheredPictures`'s options through `computeGeometry`/`paintFrame`
// into what gets drawn (the PRD's "Skia pictures support palettes"
// acceptance criterion). This does, through the real hook and the real
// `computeGeometry` + `paintFrame` + `skiaPaintContext` chain — only
// `createPicture` and the `Skia.*` primitives it and `skiaPaintContext`
// call are faked.
// ---------------------------------------------------------------------------

describe('useDitheredPictures: palette reaches drawing end-to-end', () => {
  it('paints multiple tones of a real palette through a recorded picture', () => {
    // Pre-sampled cells (skipping the shape hit-test) with fixed
    // thresholds, so the expected tone for each brightness value is
    // unambiguous — same quantization table as
    // `paint-context.test.ts`'s multi-tone test: b=0.4 -> level 1
    // ('#a00'), b=0.6 -> level 2 ('#0a0'), b=1 -> level 3 ('#00a').
    const cells: Cell[] = [
      { i: 0, j: 0, u: -0.33, v: 0, threshold: 0.5 },
      { i: 1, j: 0, u: 0, v: 0, threshold: 0.5 },
      { i: 2, j: 0, u: 0.33, v: 0, threshold: 0.5 },
    ];
    const brightnessByCell = [0.4, 0.6, 1];

    const { result } = renderHook(() =>
      useDitheredPictures({
        shape: SQUARE_SHAPE,
        brightness: (cell) => brightnessByCell[cell.i],
        cols: 3,
        rows: 1,
        frames: 1,
        cells,
        fg: ['#a00', '#0a0', '#00a'],
        bg: 'transparent',
      }),
    );

    const [picture] = result.current.pictures as unknown as FakePicture[];
    const { canvas, draws } = fakeCanvas();
    picture.draw(canvas);
    expect(draws.map((d) => d.color)).toEqual(['color:#a00', 'color:#0a0', 'color:#00a']);
  });
});

describe('useDitheredPictures — matrix', () => {
  it('passes matrix through to sampling: bayer8 clears a fixed brightness differently than the bayer4 default', () => {
    // cols=8 on a square shape makes an 8x8 grid: bayer4 tiles 2x2, bayer8
    // matches it exactly, so 0.53 (between quantization levels for both,
    // but different ones) draws a different cell count under each.
    const brightness = () => 0.53;

    const { result: bayer4 } = renderHook(() =>
      useDitheredPictures({ shape: SQUARE_SHAPE, brightness, cols: 8, frames: 1 }),
    );
    const { result: bayer8 } = renderHook(() =>
      useDitheredPictures({
        shape: SQUARE_SHAPE,
        brightness,
        cols: 8,
        frames: 1,
        matrix: 'bayer8',
      }),
    );

    const bayer4Draws = countDraws(bayer4.current.pictures);
    const bayer8Draws = countDraws(bayer8.current.pictures);

    expect(bayer4Draws).toBeGreaterThan(0);
    expect(bayer8Draws).not.toBe(bayer4Draws);
  });

  it('re-records (a new pictures array) when matrix changes, but not when it stays the same', () => {
    const brightness = () => true;
    const { result, rerender } = renderHook(
      ({ matrix }: { matrix: 'bayer4' | 'bayer8' }) =>
        useDitheredPictures({ shape: SQUARE_SHAPE, brightness, cols: 4, frames: 1, matrix }),
      { initialProps: { matrix: 'bayer4' } },
    );
    const first = result.current.pictures;

    rerender({ matrix: 'bayer4' });
    expect(result.current.pictures).toBe(first);

    rerender({ matrix: 'bayer8' });
    expect(result.current.pictures).not.toBe(first);
  });

  it('an invalid matrix throws rather than silently sampling with the default', () => {
    // React logs the error to console as well as re-throwing it (there's
    // no error boundary in this render tree); silence that expected noise.
    const consoleSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(() =>
        renderHook(() =>
          useDitheredPictures({
            shape: SQUARE_SHAPE,
            brightness: () => true,
            matrix: [
              [0, 1, 2],
              [1, 2],
            ],
          }),
        ),
      ).toThrow(/ragged/);
    } finally {
      consoleSpy.mockRestore();
    }
  });
});
