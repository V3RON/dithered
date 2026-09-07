import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dithered } from './react';
import type { DitheredInstance } from './renderer';
import { SQUARE_SHAPE, make2dCtx, stubAnimationGlobals, stubGetContext } from './test-utils';

vi.mock('./renderer', async () => {
  const actual = await vi.importActual<typeof import('./renderer')>('./renderer');
  return { ...actual, createDithered: vi.fn(actual.createDithered) };
});

// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import { createDithered } from './renderer';

const mockedCreateDithered = createDithered as unknown as ReturnType<
  typeof vi.fn<typeof createDithered>
>;

function lastInstance(): DitheredInstance {
  const results = mockedCreateDithered.mock.results;
  return results[results.length - 1]!.value as DitheredInstance;
}

// A stable reference, reused across the `currentColor` tests below, so
// that rerendering with an unrelated prop change (or no prop change at
// all) doesn't itself hand `brightness` a fresh identity — which would
// fire the separate reconfigure effect (`update()` -> `configure()` ->
// repaint) and mask whatever the refresh-effect-under-test does or
// doesn't do on its own.
function alwaysDraw() {
  return true;
}

describe('Dithered', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;
  let ctx: ReturnType<typeof make2dCtx>;
  let getContextStub: ReturnType<typeof stubGetContext>;

  beforeEach(() => {
    mockedCreateDithered.mockClear();
    env = stubAnimationGlobals();
    ctx = make2dCtx();
    getContextStub = stubGetContext(ctx);
  });

  afterEach(() => {
    env.restore();
    getContextStub.restore();
  });

  it('renders a canvas with role="status" and an aria-label by default', () => {
    render(<Dithered shape={SQUARE_SHAPE} />);
    const canvas = screen.getByRole('status');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-label', 'Loading');
  });

  it('label="" hides the canvas from assistive tech and drops the role', () => {
    render(<Dithered shape={SQUARE_SHAPE} label="" />);
    expect(screen.queryByRole('status')).toBeNull();
    const canvas = document.querySelector('canvas')!;
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).not.toHaveAttribute('aria-label');
  });

  it('forwards the ref to the underlying canvas element', () => {
    const ref = createRef<HTMLCanvasElement>();
    render(<Dithered ref={ref} shape={SQUARE_SHAPE} />);
    expect(ref.current).toBeInstanceOf(HTMLCanvasElement);
  });

  it('creates exactly one instance on mount and destroys it on unmount', () => {
    const { unmount } = render(<Dithered shape={SQUARE_SHAPE} />);
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);

    const destroySpy = vi.spyOn(lastInstance(), 'destroy');
    unmount();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('re-rendering with a new fg calls update() and does not recreate the instance', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} fg="#111111" />);
    const updateSpy = vi.spyOn(lastInstance(), 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} fg="#ff00ff" />);

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ fg: '#ff00ff' }));
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });

  // `useStablePalette` exists so an inline palette literal (a fresh array
  // every render for an unmemoized caller — the common case, since nobody
  // wraps `fg={[...]}` in `useMemo`) doesn't itself trigger a reconfigure.
  // Without it, `<Dithered fg={['#a00', '#0a0']} />` would resample cells
  // and rebuild the sprite cache on every render of the parent, palette
  // value unchanged or not.
  it('re-rendering with an equal-by-value but new fg array does not call update()', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} fg={['#a00', '#0a0']} />);
    const updateSpy = vi.spyOn(lastInstance(), 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} fg={['#a00', '#0a0']} />); // a fresh array, same values

    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('re-rendering with a palette that actually changes value calls update()', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} fg={['#a00', '#0a0']} />);
    const updateSpy = vi.spyOn(lastInstance(), 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} fg={['#a00', '#00f']} />);

    expect(updateSpy).toHaveBeenCalled();
  });

  it('toggling paused calls setPaused with the new value', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} paused={false} />);
    const setPausedSpy = vi.spyOn(lastInstance(), 'setPaused');

    rerender(<Dithered shape={SQUARE_SHAPE} paused={true} />);
    expect(setPausedSpy).toHaveBeenCalledWith(true);

    rerender(<Dithered shape={SQUARE_SHAPE} paused={false} />);
    expect(setPausedSpy).toHaveBeenCalledWith(false);
  });

  it('progress={0.5} pauses and renders the expected frame index (default frames=48)', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} />);
    const instance = lastInstance();
    const setPausedSpy = vi.spyOn(instance, 'setPaused');
    const renderFrameSpy = vi.spyOn(instance, 'renderFrame');

    rerender(<Dithered shape={SQUARE_SHAPE} progress={0.5} />);

    expect(setPausedSpy).toHaveBeenCalledWith(true);
    // round(0.5 * (48 - 1)) = round(23.5) = 24
    expect(renderFrameSpy).toHaveBeenCalledWith(24);
  });

  it('does not recreate the instance when only progress changes', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} progress={0} />);
    rerender(<Dithered shape={SQUARE_SHAPE} progress={1} />);
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });

  // Regression: `Dithered` always builds a full options object from its
  // props (`{ fg, bg, cols, ... }`), so any unset optional prop reaches
  // `createDithered` as an explicit `undefined`, not an omitted key. That
  // must still resolve to the renderer's real defaults (fg '#000', bg
  // 'transparent', cols 16) instead of painting opaque black squares.
  it('with no optional props, renders using the renderer defaults (fg, bg, cols)', () => {
    render(<Dithered shape={SQUARE_SHAPE} brightness={() => true} />);

    // Default fg '#000' is the last fillStyle set before drawing cells.
    expect(ctx.fillStyle).toBe('#000');
    // Default bg 'transparent' means no background fillRect call.
    expect(ctx.fillRect).not.toHaveBeenCalled();
    // Default cols (16) is a real number, so cells are sampled and drawn.
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('resolves fg="currentColor" against the canvas\'s own computed color', () => {
    render(
      <Dithered
        shape={SQUARE_SHAPE}
        brightness={alwaysDraw}
        fg="currentColor"
        style={{ color: 'rgb(1, 2, 3)' }}
      />,
    );
    const canvas = document.querySelector('canvas')!;

    expect(ctx.fillStyle).toBe(getComputedStyle(canvas).color);
    expect(ctx.fillStyle).not.toBe('currentColor');
  });

  it('re-resolves currentColor on rerender via refreshColors, not via a reconfigure', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        brightness={alwaysDraw}
        fg="currentColor"
        style={{ color: 'rgb(1, 2, 3)' }}
      />,
    );
    const canvas = document.querySelector('canvas')!;
    const firstColor = getComputedStyle(canvas).color;
    expect(ctx.fillStyle).toBe(firstColor);

    const instance = lastInstance();
    const refreshSpy = vi.spyOn(instance, 'refreshColors');
    const updateSpy = vi.spyOn(instance, 'update');

    rerender(
      <Dithered
        shape={SQUARE_SHAPE}
        brightness={alwaysDraw}
        fg="currentColor"
        style={{ color: 'rgb(4, 5, 6)' }}
      />,
    );

    // `brightness` is the same stable reference on both renders, and so is
    // every other prop the reconfigure effect depends on — so `update()`
    // must not have fired for this rerender. If it had (as it would with
    // an inline `() => true` brightness, a fresh identity every render),
    // it would repaint in the new color as a side effect and this test
    // would pass without `refreshColors` doing anything at all.
    expect(updateSpy).not.toHaveBeenCalled();
    expect(refreshSpy).toHaveBeenCalled();

    const secondColor = getComputedStyle(canvas).color;
    expect(secondColor).not.toBe(firstColor);
    expect(ctx.fillStyle).toBe(secondColor);
  });

  it('re-resolves currentColor on a re-render caused only by an ancestor class change (Finding 1 repro)', () => {
    // A real stylesheet with class selectors, exercising jsdom's actual
    // CSS cascade rather than an inline `style` prop on the canvas
    // itself — this is the theming mechanism the finding calls out as
    // "the overwhelmingly common" one, and it changes none of
    // `<Dithered>`'s own props (`className`, `style`, `fg`).
    const sheet = document.createElement('style');
    sheet.textContent = '.light { color: rgb(1, 1, 1); } .dark { color: rgb(9, 9, 9); }';
    document.head.appendChild(sheet);

    function App({ theme }: { theme: 'light' | 'dark' }) {
      return (
        <div className={theme}>
          <Dithered shape={SQUARE_SHAPE} brightness={alwaysDraw} fg="currentColor" />
        </div>
      );
    }

    const { rerender } = render(<App theme="light" />);
    const canvas = document.querySelector('canvas')!;
    const firstColor = getComputedStyle(canvas).color;
    expect(ctx.fillStyle).toBe(firstColor);

    rerender(<App theme="dark" />);

    const secondColor = getComputedStyle(canvas).color;
    expect(secondColor).not.toBe(firstColor);
    // The bug this guards against: keying the refresh effect on
    // `[className, style, fg]` (all unchanged here — only an ancestor's
    // class changed) would leave this stuck at `firstColor` forever.
    expect(ctx.fillStyle).toBe(secondColor);

    sheet.remove();
  });

  it('does not call refreshColors when fg has no currentColor token', () => {
    const { rerender } = render(
      <Dithered shape={SQUARE_SHAPE} brightness={() => true} fg="#111111" />,
    );
    const refreshSpy = vi.spyOn(lastInstance(), 'refreshColors');

    rerender(<Dithered shape={SQUARE_SHAPE} brightness={() => true} fg="#111111" className="x" />);

    expect(refreshSpy).not.toHaveBeenCalled();
  });

  it('instanceRef is populated with the DitheredInstance on mount and cleared on unmount', () => {
    const instanceRef = createRef<DitheredInstance | null>();
    const { unmount } = render(<Dithered shape={SQUARE_SHAPE} instanceRef={instanceRef} />);

    expect(instanceRef.current).toBe(lastInstance());
    expect(instanceRef.current).not.toBeNull();

    unmount();
    expect(instanceRef.current).toBeNull();
  });

  it('instanceRef exposes refreshColors as a usable escape hatch for currentColor', () => {
    const instanceRef = createRef<DitheredInstance | null>();
    render(
      <Dithered
        shape={SQUARE_SHAPE}
        brightness={alwaysDraw}
        fg="currentColor"
        style={{ color: 'rgb(1, 2, 3)' }}
        instanceRef={instanceRef}
      />,
    );
    const canvas = document.querySelector('canvas')!;
    canvas.style.color = 'rgb(4, 5, 6)';
    const expected = getComputedStyle(canvas).color;

    instanceRef.current?.refreshColors();

    expect(ctx.fillStyle).toBe(expected);
  });

  it('the regular ref still forwards the canvas element when instanceRef is also passed', () => {
    const ref = createRef<HTMLCanvasElement>();
    const instanceRef = createRef<DitheredInstance | null>();
    render(<Dithered ref={ref} shape={SQUARE_SHAPE} instanceRef={instanceRef} />);

    expect(ref.current).toBeInstanceOf(HTMLCanvasElement);
    expect(instanceRef.current).not.toBeInstanceOf(HTMLCanvasElement);
  });
});
