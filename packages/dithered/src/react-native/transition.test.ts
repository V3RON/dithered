import { describe, expect, it, vi } from 'vitest';

const makeFromSVGString = vi.fn((_d: string) => ({ contains: () => true }));
const createPictureImpl = vi.fn((recorder: (canvas: unknown) => void, bounds: unknown): unknown => {
  const canvas = {
    drawRect: vi.fn(),
    drawRRect: vi.fn(),
  };
  recorder(canvas);
  return { bounds, canvas };
});

vi.mock('@shopify/react-native-skia', () => ({
  Skia: {
    Path: { MakeFromSVGString: (d: string) => makeFromSVGString(d) },
    Paint: () => ({ setAntiAlias: vi.fn(), setColor: vi.fn() }),
    Color: (c: string) => `color:${c}`,
    XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    RRectXY: (rect: unknown, rx: number, ry: number) => ({ rect, rx, ry }),
  },
  createPicture: (recorder: (canvas: unknown) => void, bounds: unknown) =>
    createPictureImpl(recorder, bounds),
}));

const { renderHook } = await import('@testing-library/react');
const { useDitheredTransition } = await import('./transition');
const { SQUARE_SHAPE } = await import('../test-utils');
const { circle } = await import('../shapes');

describe('useDitheredTransition', () => {
  it("records steps at the outgoing loop's steady-state cadence: round(duration / (period / frames)) (finding 10)", () => {
    // `from`'s cadence: period 1000, frames 10 -> 100ms/frame; duration 350
    // -> 3.5 -> round to 4. `to` is deliberately given a *different*
    // period/frames (2000/40 -> 50ms/frame, which would round 350 to 7):
    // if the implementation used `toOpts` instead of `fromOpts` here, this
    // test would catch it, unlike the previous version (which gave both
    // sides identical period/frames, so it would have passed either way).
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: {
          shape: SQUARE_SHAPE,
          brightness: () => true,
          period: 1000,
          frames: 10,
          cols: 4,
        },
        to: {
          shape: circle,
          brightness: () => false,
          period: 2000,
          frames: 40,
          cols: 4,
        },
        duration: 350,
      }),
    );

    expect(result.current.pictures).toHaveLength(4);
  });

  it('clamps the step count to a minimum of 2, even for a very short duration', () => {
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: { shape: SQUARE_SHAPE, brightness: () => true, period: 1000, frames: 60 },
        to: { shape: circle, brightness: () => false, period: 1000, frames: 60 },
        duration: 1, // would round to 0 steps unclamped
      }),
    );

    expect(result.current.pictures).toHaveLength(2);
  });

  it('clamps the step count to a maximum of 240, even for a very long duration', () => {
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: { shape: SQUARE_SHAPE, brightness: () => true, period: 1000, frames: 60 },
        to: { shape: circle, brightness: () => false, period: 1000, frames: 60 },
        duration: 60_000, // 3600 steps unclamped
      }),
    );

    expect(result.current.pictures).toHaveLength(240);
  });

  it('records nothing under reduced motion, and still reports the target surface size', () => {
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: { shape: SQUARE_SHAPE, brightness: () => true, size: 48 },
        to: { shape: circle, brightness: () => false, size: 96 },
        duration: 400,
        reducedMotion: true,
      }),
    );

    expect(result.current.pictures).toEqual([]);
    // `to`'s surface, not `from`'s — the morph (were there one) runs on
    // the target's grid, same rule as steady-state sizing.
    expect(result.current.height).toBe(96);
  });

  it('drops previously-recorded pictures once reduced motion turns on', () => {
    const { result, rerender } = renderHook(
      (props: { reducedMotion: boolean }) =>
        useDitheredTransition({
          from: { shape: SQUARE_SHAPE, brightness: () => true, period: 1000, frames: 10 },
          to: { shape: circle, brightness: () => false, period: 1000, frames: 10 },
          duration: 400,
          reducedMotion: props.reducedMotion,
        }),
      { initialProps: { reducedMotion: false } },
    );

    expect(result.current.pictures.length).toBeGreaterThan(0);

    rerender({ reducedMotion: true });

    expect(result.current.pictures).toEqual([]);
  });

  it('paints through skiaPaintContext for every recorded step (createPicture called once per step)', () => {
    createPictureImpl.mockClear();
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: { shape: SQUARE_SHAPE, brightness: () => true, period: 1000, frames: 10 },
        to: { shape: circle, brightness: () => false, period: 1000, frames: 10 },
        duration: 400,
      }),
    );

    expect(createPictureImpl).toHaveBeenCalledTimes(result.current.pictures.length);
  });

  // Regression (finding 4): `now` for each recorded step must continue the
  // wall clock the live loop was already on (`startAt`), not restart both
  // sides at phase 0.
  it("bakes each side's phase from startAt, continuing the clock the live loop was on (finding 4)", () => {
    // `t` passed straight through as the numeric brightness: at phase 0 no
    // cell can clear its (strictly positive) Bayer threshold, so a morph
    // that (incorrectly) always restarts both sides at phase 0 draws
    // nothing in its very first recorded step; one that correctly
    // continues from `startAt`'s phase (0.7) draws several cells.
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: {
          shape: SQUARE_SHAPE,
          brightness: (_cell, t) => t,
          period: 1000,
          frames: 10,
          cols: 4,
        },
        to: { shape: SQUARE_SHAPE, brightness: (_cell, t) => t, period: 1000, frames: 10, cols: 4 },
        duration: 100,
        startAt: 700, // the outgoing loop was at phase 0.7 when the morph began.
      }),
    );

    const first = result.current.pictures[0] as unknown as {
      canvas: { drawRRect: ReturnType<typeof vi.fn> };
    };
    expect(first.canvas.drawRRect.mock.calls.length).toBeGreaterThan(0);
  });

  // Regression (finding 9): a caller-supplied `from.cells` is sampled for
  // *its own* options, not necessarily the target's grid (ADR 0004 §2), so
  // it must never be used verbatim for the outgoing side — only `to.cells`
  // (already on the target grid by construction) is trusted that way.
  it("ignores a caller-supplied from.cells and always resamples the outgoing shape onto the target's grid (finding 9)", () => {
    const { result } = renderHook(() =>
      useDitheredTransition({
        from: {
          shape: SQUARE_SHAPE,
          brightness: () => true,
          cells: [], // deliberately wrong/stale — must not be used as-is.
          period: 1000,
          frames: 10,
          cols: 4,
        },
        to: { shape: circle, brightness: () => false, period: 1000, frames: 10, cols: 4 },
        duration: 400,
      }),
    );

    // At progress 0 the morph should show exactly the outgoing shape: if
    // the bogus empty `from.cells` were used verbatim, `diffCells` would
    // see nothing in `from`, so nothing would be drawn until well past
    // `ENTER_START` — the very first recorded step would be blank.
    const first = result.current.pictures[0] as unknown as {
      canvas: { drawRRect: ReturnType<typeof vi.fn> };
    };
    expect(first.canvas.drawRRect.mock.calls.length).toBeGreaterThan(0);
  });
});
