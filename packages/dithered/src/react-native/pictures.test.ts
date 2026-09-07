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

// Unlike a minimal `createPicture` stub that just echoes back `bounds`,
// this one actually **invokes the draw callback** against a fake
// `SkCanvas` and records what got drawn, in the color it was drawn with.
// That's what lets the "palette reaches drawing" describe block below
// exercise the real `computeGeometry` -> `paintFrame` ->
// `skiaPaintContext` chain end-to-end from `useDitheredPictures`, rather
// than only checking the `currentColor` guard and the memo's dependency
// shape (which don't need any of this and remain the only things the
// other two describe blocks below care about).
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
  createPicture: vi.fn((draw: (canvas: unknown) => void, bounds: FakeRect) => {
    const draws: Draw[] = [];
    const canvas = {
      drawRect: (rect: FakeRect, paint: FakePaint) =>
        draws.push({ op: 'rect', rect, color: paint.color }),
      drawRRect: (rrect: FakeRRect, paint: FakePaint) =>
        draws.push({ op: 'rrect', rrect, color: paint.color }),
    };
    draw(canvas);
    return { bounds, draws };
  }),
}));

// Real hit-testing is `./hit-test.test.ts`'s job; these tests are about the
// currentColor guard, the memo's dependency shape, and (below) that a
// palette actually reaches drawing — none of which need real point-in-path
// testing — so every sampled point is accepted.
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
// The two describe blocks above never invoke `createPicture`'s draw
// callback, so neither proves a palette actually flows from
// `useDitheredPictures`'s options through `computeGeometry`/`paintFrame`
// into what gets drawn (the PRD's "Skia pictures support palettes"
// acceptance criterion). This does, through the real hook and the real
// `computeGeometry` + `paintFrame` + `skiaPaintContext` chain — only
// `createPicture` and the `Skia.*` primitives it and `skiaPaintContext`
// call are faked, and the fake now records what was drawn.
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

    const [picture] = result.current.pictures as unknown as { draws: Draw[] }[];
    expect(picture.draws.map((d) => d.color)).toEqual(['color:#a00', 'color:#0a0', 'color:#00a']);
  });
});
