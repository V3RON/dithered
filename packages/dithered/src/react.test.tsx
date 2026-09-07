import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { renderToString } from 'react-dom/server';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULTS, renderToSvg } from './core';
import { Dithered } from './react';
import type { DitheredInstance } from './renderer';
import type { Palette } from './core';
import {
  SQUARE_SHAPE,
  make2dCtx,
  setClientBox,
  stubAnimationGlobals,
  stubGetContext,
} from './test-utils';

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

  // Regression: `matrix` must reach `createDithered` on mount, not only
  // `update()` on a later re-render — a component whose props never
  // change again would otherwise render `bayer4` forever regardless of
  // what `matrix` prop it was given.
  it('mounts with the matrix prop passed to createDithered', () => {
    render(<Dithered shape={SQUARE_SHAPE} matrix="bayer8" />);

    expect(mockedCreateDithered).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ matrix: 'bayer8' }),
    );
  });

  // Regression for the missing-dependency failure mode: `update({ matrix })`
  // must actually be called when `matrix` changes, not silently skipped
  // because the update effect's dependency array forgot it.
  it('re-rendering with a changed matrix calls update() with that matrix', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} matrix="bayer4" />);
    const updateSpy = vi.spyOn(lastInstance(), 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} matrix="bayer8" />);

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ matrix: 'bayer8' }));
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });

  // ADR 0004: with `transition` set, an option change is routed through
  // transitionTo() (a morph) instead of update() (a cut).
  it('without `transition`, a shape change calls update() and never transitionTo()', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} fg="#111111" />);
    const instance = lastInstance();
    const updateSpy = vi.spyOn(instance, 'update');
    const transitionToSpy = vi.spyOn(instance, 'transitionTo');

    rerender(<Dithered shape={SQUARE_SHAPE} fg="#222222" />);

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ fg: '#222222' }));
    expect(transitionToSpy).not.toHaveBeenCalled();
  });

  it('with `transition` set, a shape/option change calls transitionTo() instead of update()', () => {
    const { rerender } = render(
      <Dithered shape={SQUARE_SHAPE} fg="#111111" transition={{ duration: 400 }} />,
    );
    const instance = lastInstance();
    const updateSpy = vi.spyOn(instance, 'update');
    const transitionToSpy = vi.spyOn(instance, 'transitionTo');

    rerender(<Dithered shape={SQUARE_SHAPE} fg="#222222" transition={{ duration: 400 }} />);

    expect(transitionToSpy).toHaveBeenCalledWith(
      expect.objectContaining({ fg: '#222222', transition: { duration: 400 } }),
    );
    expect(updateSpy).not.toHaveBeenCalled();
  });

  it('toggling paused calls setPaused with the new value', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} paused={false} />);
    const setPausedSpy = vi.spyOn(lastInstance(), 'setPaused');

    rerender(<Dithered shape={SQUARE_SHAPE} paused={true} />);
    expect(setPausedSpy).toHaveBeenCalledWith(true);

    rerender(<Dithered shape={SQUARE_SHAPE} paused={false} />);
    expect(setPausedSpy).toHaveBeenCalledWith(false);
  });

  it('progress={0.5} pauses and drives the expected phase (default frames=48)', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} />);
    const instance = lastInstance();
    const setPausedSpy = vi.spyOn(instance, 'setPaused');
    const setTimeSpy = vi.spyOn(instance, 'setTime');

    rerender(<Dithered shape={SQUARE_SHAPE} progress={0.5} />);

    expect(setPausedSpy).toHaveBeenCalledWith(true);
    // progress is sugar over setTime: 0.5 * (48 - 1) / 48 -> frame floor(...) = 23,
    // one lower than the old round-based mapping (frame 24) — see ADR 0006 §8.
    expect(setTimeSpy).toHaveBeenCalledWith((0.5 * 47) / 48);
  });

  // Asserts the actual *painted* frame (via the real `onFrame` path, on
  // the real underlying instance — `createDithered` is only wrapped in
  // a spy here, not replaced), not the raw argument `setTime` was
  // called with. `frames: 10` (where `0.9 * 10 === 9` exactly) can't
  // distinguish a correct mapping from `p * (frames - 1) / frames`
  // (finding 2's bug): both give the same argument there. `frames: 48`
  // — the component's own default — cannot: the naive formula computes
  // `(1 * 47) / 48 = 46.99999999999999`, which floors to frame 46, not
  // 47, contradicting the documented "endpoints are unchanged".
  it('progress endpoints 0 and 1 paint frame 0 and frame frames - 1, at a frame count where the naive formula is inexact', () => {
    const reported: number[] = [];
    const onFrame = (f: number) => reported.push(f);
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} frames={48} onFrame={onFrame} />);

    // Move off frame 0 first — the default `initialFrame: 0` already
    // paints frame 0 at mount, so asserting `progress={0}` lands there
    // too would pass even if nothing actually moved.
    rerender(<Dithered shape={SQUARE_SHAPE} frames={48} progress={0.5} onFrame={onFrame} />);
    reported.length = 0;

    rerender(<Dithered shape={SQUARE_SHAPE} frames={48} progress={0} onFrame={onFrame} />);
    expect(reported[reported.length - 1]).toBe(0);

    rerender(<Dithered shape={SQUARE_SHAPE} frames={48} progress={1} onFrame={onFrame} />);
    expect(reported[reported.length - 1]).toBe(47);
  });

  // ADR 0006 test 39, swept across frame counts that include several
  // where `progress * (frames - 1) / frames` is not exact.
  it('progress endpoints paint frame 0 and frame frames - 1 across a sweep of frame counts', () => {
    // 49, 22 and 26 are the load-bearing entries: they are frame counts
    // where a bare `k / frames` still rounds down even with an exact
    // `wrapPhase`, so they catch a regression to the formula ADR 0006
    // §8 rejects. The round numbers alone would not.
    for (const frames of [48, 36, 3, 12, 19, 27, 46, 47, 54, 49, 22, 26]) {
      const reported: number[] = [];
      const onFrame = (f: number) => reported.push(f);
      const { rerender, unmount } = render(
        <Dithered shape={SQUARE_SHAPE} frames={frames} onFrame={onFrame} />,
      );

      // Move off frame 0 first so `progress={0}` is an observable repaint.
      rerender(<Dithered shape={SQUARE_SHAPE} frames={frames} progress={0.5} onFrame={onFrame} />);
      reported.length = 0;

      rerender(<Dithered shape={SQUARE_SHAPE} frames={frames} progress={0} onFrame={onFrame} />);
      expect(reported[reported.length - 1]).toBe(0);

      rerender(<Dithered shape={SQUARE_SHAPE} frames={frames} progress={1} onFrame={onFrame} />);
      expect(reported[reported.length - 1]).toBe(frames - 1);

      unmount();
    }
  });

  // ADR 0006 test 49 / finding 7. `frames: 0` used to reach `setTime`
  // with a non-finite phase (`Math.floor(0.5 * -1) === -1`, then
  // `phaseForFrame(-1, 0) === -Infinity`) — finding 1's blank-canvas bug,
  // entered through the `progress` mapping rather than `time` directly.
  it('progress with frames: 0 does not produce a non-finite phase', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} />);
    const instance = lastInstance();
    const setTimeSpy = vi.spyOn(instance, 'setTime');

    rerender(<Dithered shape={SQUARE_SHAPE} frames={0} progress={0.5} />);

    expect(setTimeSpy).toHaveBeenCalledTimes(1);
    expect(Number.isFinite(setTimeSpy.mock.calls[0]![0])).toBe(true);
  });

  // ADR 0006 test 49, second half. The mapping must read
  // `DEFAULTS.frames`, not repeat the library's default as a bare `48`
  // literal, so the two can't silently drift apart if the real default
  // ever changes. Mutates the shared `DEFAULTS` object for the duration
  // of the test, restored in `finally`.
  it("progress's frame mapping (no frames prop) follows DEFAULTS.frames rather than a hard-coded 48", () => {
    const original = DEFAULTS.frames;
    DEFAULTS.frames = 20;
    try {
      const { rerender } = render(<Dithered shape={SQUARE_SHAPE} />);
      const instance = lastInstance();
      const setTimeSpy = vi.spyOn(instance, 'setTime');

      rerender(<Dithered shape={SQUARE_SHAPE} progress={0.5} />);

      // frame = floor(0.5 * (20 - 1)) = 9; phase = phaseForFrame(9, 20).
      expect(setTimeSpy).toHaveBeenCalledWith((9 + 0.5) / 20);
    } finally {
      DEFAULTS.frames = original;
    }
  });

  it('time takes precedence over progress when both are set', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} progress={0.5} />);
    const instance = lastInstance();
    const setTimeSpy = vi.spyOn(instance, 'setTime');

    rerender(<Dithered shape={SQUARE_SHAPE} progress={0.5} time={0.2} />);

    expect(setTimeSpy).toHaveBeenCalledWith(0.2);
    expect(setTimeSpy).not.toHaveBeenCalledWith((0.5 * 47) / 48);
  });

  // ADR 0006 test 31 / finding 5. The original version of this test only
  // asserted that `setTime` was *called* with `0.35` and that
  // `clearTime` was called — never the two things its name actually
  // claims: that the argument produces the right *painted* frame, and
  // that the RAF loop genuinely stops (as opposed to `setTime` being a
  // no-op stub that happens to record its argument).
  it('time renders the matching frame and pauses the loop, then clearTime resumes on removal', () => {
    const reported: number[] = [];
    const onFrame = (f: number) => reported.push(f);
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} frames={10} onFrame={onFrame} />);
    const instance = lastInstance();
    const clearTimeSpy = vi.spyOn(instance, 'clearTime');

    expect(env.rafCallbacks.length).toBe(1); // scheduled normally before time takes over
    reported.length = 0; // drop the mount-time initial paint at frame 0

    rerender(<Dithered shape={SQUARE_SHAPE} frames={10} time={0.35} onFrame={onFrame} />);

    // The actual painted frame index, via the real onFrame path — not
    // just the raw argument setTime happened to receive.
    expect(reported[reported.length - 1]).toBe(Math.floor(0.35 * 10));
    // The internal RAF loop actually stopped: no new frame was
    // scheduled, and the one that was pending got cancelled.
    expect(env.rafCallbacks.length).toBe(1);
    expect(cancelAnimationFrame).toHaveBeenCalled();

    rerender(<Dithered shape={SQUARE_SHAPE} frames={10} />);
    expect(clearTimeSpy).toHaveBeenCalled();
  });

  // ADR 0006 test 50, web half / finding 6. `time={null}` (as opposed
  // to an absent prop — e.g. `time={sharedProgress ?? null}`) must
  // behave exactly like `time` being `undefined`: `clearTime()` runs and
  // playback keeps going, rather than freezing (the native failure mode
  // this finding is really about — see native/playback.test.ts's
  // `isExternallyDriven` coverage). `typeof null === 'number'` is
  // already false, so the effect falls through to `clearTime()`; this
  // pins that so it can't regress.
  it('time={null} behaves as not externally driven: clearTime runs and playback resumes', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} time={0.2} />);
    const instance = lastInstance();
    const clearTimeSpy = vi.spyOn(instance, 'clearTime');
    const rafCountWhileDriven = env.rafCallbacks.length;

    rerender(<Dithered shape={SQUARE_SHAPE} time={null} />);

    expect(clearTimeSpy).toHaveBeenCalled();
    // The real instance actually resumed scheduling — not just a spy
    // recording that the method was called.
    expect(env.rafCallbacks.length).toBeGreaterThan(rafCountWhileDriven);
  });

  // Finding 3 (third review). `time={null}` is documented as behaving
  // exactly like an absent prop, and the time effect hands it to
  // `clearTime()` — so it does not own pausing and must not suppress the
  // paused effect. The gate was `time === undefined`, which `null` fails,
  // silently disabling the `paused` prop for the whole
  // `time={sharedValue ?? null}` pattern the docs recommend.
  it('paused still works while time={null}', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} time={null} paused={false} />);
    const instance = lastInstance();
    const setPausedSpy = vi.spyOn(instance, 'setPaused');

    rerender(<Dithered shape={SQUARE_SHAPE} time={null} paused={true} />);

    expect(setPausedSpy).toHaveBeenCalledWith(true);
  });

  it('time changing does not trigger update() (no reconfigure)', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} time={0} />);
    const instance = lastInstance();
    const updateSpy = vi.spyOn(instance, 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} time={0.1} />);
    rerender(<Dithered shape={SQUARE_SHAPE} time={0.2} />);

    expect(updateSpy).not.toHaveBeenCalled();
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });

  it('speed forwards to the instance via update() without recreating it', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} speed={1} />);
    const instance = lastInstance();
    const updateSpy = vi.spyOn(instance, 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} speed={2} />);

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ speed: 2 }));
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });

  it('an inline onFrame that changes identity every render never triggers update(), and the latest callback is invoked', () => {
    let latestReported = -1;
    const { rerender } = render(
      <Dithered shape={SQUARE_SHAPE} onFrame={() => (latestReported = -2)} />,
    );
    const instance = lastInstance();
    const updateSpy = vi.spyOn(instance, 'update');

    // A fresh arrow function every render — the common, unmemoized case.
    rerender(<Dithered shape={SQUARE_SHAPE} onFrame={(f) => (latestReported = f)} />);
    rerender(<Dithered shape={SQUARE_SHAPE} onFrame={(f) => (latestReported = f)} />);

    expect(updateSpy).not.toHaveBeenCalled();

    // Directly exercise the trampoline `createDithered` was actually
    // constructed with, simulating the core reporting a painted frame.
    const optionsPassed = mockedCreateDithered.mock.calls[0]![1];
    optionsPassed.onFrame?.(7, 0.5);
    expect(latestReported).toBe(7); // the *latest* render's callback ran, not the first's
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

  // Round-2 review finding 3: `DitheredProps['fg']` (via `DitheredOptions`)
  // must accept the `Palette` type the library itself hands back to
  // callers -- `readonly string[]` -- not just a mutable `string[]`
  // literal. This fails to typecheck (`pnpm typecheck`) if `fg` regresses
  // to `string | string[]`.
  it('accepts a readonly Palette value for fg (type-level)', () => {
    const palette: Palette = ['#a00', '#0a0'];
    render(<Dithered shape={SQUARE_SHAPE} brightness={alwaysDraw} fg={palette} label="" />);

    expect(mockedCreateDithered).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ fg: palette }),
    );
  });

  it('passes maxDpr through to createDithered', () => {
    render(<Dithered shape={SQUARE_SHAPE} maxDpr={2} />);
    expect(mockedCreateDithered).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ maxDpr: 2 }),
    );
  });

  // -- size="fill" (responsive sizing, ADR 0011) -----------------------------

  describe('size="fill"', () => {
    let container: HTMLDivElement;

    beforeEach(() => {
      container = document.createElement('div');
      document.body.appendChild(container);
      setClientBox(container, { width: 200, height: 200 });
    });

    afterEach(() => {
      container.remove();
    });

    it('fits the parent container on mount', () => {
      render(<Dithered shape={SQUARE_SHAPE} size="fill" />, { container });
      const canvas = container.querySelector('canvas')!;
      expect(canvas.style.width).toBe('200px');
      expect(canvas.style.height).toBe('200px');
    });

    // Regression: `Dithered` always builds a full options object from its
    // props, so every prop change (not just `size`) reaches `update()` with
    // `size: 'fill'` set. That must not clobber a fractional
    // ResizeObserver-delivered size with a coarser, integer-`clientWidth`-
    // based re-measurement on an unrelated prop change (review finding 2).
    it('a prop change other than size preserves the ResizeObserver-delivered size instead of re-measuring via clientWidth', () => {
      const { rerender } = render(<Dithered shape={SQUARE_SHAPE} size="fill" fg="#111111" />, {
        container,
      });
      const canvas = container.querySelector('canvas')!;
      expect(canvas.style.width).toBe('200px'); // the initial synchronous fit

      const ro = env.resizeObserverInstances[env.resizeObserverInstances.length - 1];
      ro.trigger({ width: 199.3, height: 199.3 }); // a live, fractional RO delivery
      expect(canvas.style.width).toBe('199.3px');

      rerender(<Dithered shape={SQUARE_SHAPE} size="fill" fg="#222222" />);

      // Must keep the RO-delivered value, not clobber it with a fresh
      // clientWidth-based re-measurement of the (unchanged) 200px container.
      expect(canvas.style.width).toBe('199.3px');
    });
  });
});

describe('Dithered SSR fallback', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;
  let getContextStub: ReturnType<typeof stubGetContext>;

  beforeEach(() => {
    mockedCreateDithered.mockClear();
    env = stubAnimationGlobals();
    getContextStub = stubGetContext(make2dCtx());
  });

  afterEach(() => {
    env.restore();
    getContextStub.restore();
  });

  it('renderToString includes a non-blank background-image data URL fallback', () => {
    const html = renderToString(<Dithered shape={SQUARE_SHAPE} brightness={() => true} />);

    expect(html).toContain('<canvas');
    const match = html.match(/background-image:\s*url\((data:image\/svg\+xml;utf8,[^)]*)\)/);
    expect(match).not.toBeNull();

    // A regression that rendered a well-formed but empty `<svg
    // …></svg>` — the exact "blank SSR canvas" this fallback exists to
    // prevent — would satisfy the prefix-only check this replaces;
    // decode the payload and require actual drawn cells.
    const dataUrl = match![1];
    const svg = decodeURIComponent(dataUrl.slice('data:image/svg+xml;utf8,'.length));
    const rectCount = (svg.match(/<rect\b/g) ?? []).length;
    expect(rectCount).toBeGreaterThan(0);
  });

  it('SSR fallback honours `progress`, rendering the frame the mount effect will actually paint', () => {
    // Frame-varying, unlike the `() => true` used elsewhere in this file:
    // with every cell drawn on every frame, frame 0 and frame 42's SVGs
    // would be identical regardless of which frame the fallback picks,
    // and this test would not be able to tell `initialFrame` (the pre-fix
    // behaviour) apart from the correct frame.
    const brightness = (cell: { u: number }, t: number) => cell.u < t - 0.5;
    const html = renderToString(
      <Dithered shape={SQUARE_SHAPE} brightness={brightness} progress={0.9} />,
    );
    const match = html.match(/background-image:\s*url\((data:image\/svg\+xml;utf8,[^)]*)\)/);
    expect(match).not.toBeNull();
    const svg = decodeURIComponent(match![1].slice('data:image/svg+xml;utf8,'.length));

    // round(0.9 * (48 - 1)) = round(42.3) = 42 — the frame the
    // determinate-progress mount effect paints via `instance.renderFrame`
    // (see the `progress={0.5}` test above for the same arithmetic).
    const expectedFrame42 = renderToSvg({ shape: SQUARE_SHAPE, brightness, frame: 42 });
    expect(svg).toBe(expectedFrame42);

    // Falling back to `initialFrame` (0) instead — the pre-fix behaviour
    // — would render this SVG, which must differ from the one above.
    const frame0 = renderToSvg({ shape: SQUARE_SHAPE, brightness, frame: 0 });
    expect(svg).not.toBe(frame0);
  });

  it('ssrFallback={false} omits the background-image', () => {
    const html = renderToString(
      <Dithered shape={SQUARE_SHAPE} brightness={() => true} ssrFallback={false} />,
    );

    expect(html).not.toContain('background-image');
  });

  it('the background-image is gone once the component has mounted', () => {
    render(<Dithered shape={SQUARE_SHAPE} brightness={() => true} />);
    const canvas = document.querySelector('canvas')!;

    expect(canvas.style.backgroundImage).toBe('');
  });

  it('hydrating the server-rendered markup logs no hydration mismatch warning', () => {
    const html = renderToString(<Dithered shape={SQUARE_SHAPE} brightness={() => true} />);
    const container = document.createElement('div');
    container.innerHTML = html;
    document.body.appendChild(container);

    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      // RTL's `hydrate` option drives `hydrateRoot` wrapped in `act()`, so
      // passive effects (the mount effect that clears the fallback) flush
      // synchronously within this test rather than after teardown.
      render(<Dithered shape={SQUARE_SHAPE} brightness={() => true} />, {
        container,
        hydrate: true,
      });
      const messages = errorSpy.mock.calls.map((args) => String(args[0]));
      expect(messages.filter((m) => /did not match|hydrat/i.test(m))).toEqual([]);
    } finally {
      errorSpy.mockRestore();
      container.remove();
    }
  });
});
