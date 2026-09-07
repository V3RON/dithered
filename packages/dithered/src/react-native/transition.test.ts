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
  it("records steps at the outgoing loop's steady-state cadence: round(duration / (period / frames))", () => {
    // period 1000, frames 10 -> cadence 100ms/frame; duration 350 -> 3.5 -> round to 4.
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
          period: 1000,
          frames: 10,
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
});
