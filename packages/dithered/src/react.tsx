import { forwardRef, useEffect, useMemo, useRef, useState } from 'react';
import type { CSSProperties, MutableRefObject, Ref } from 'react';
import {
  DEFAULTS,
  hasCurrentColor,
  phaseForFrame,
  renderToDataURL,
  resolveOptions,
  resolveSizePx,
  surfaceSize,
  toPalette,
  TRANSITION_DEFAULTS,
  type ResolvedTransitionOptions,
} from './core';
import { gem } from './presets';
import { createDithered } from './renderer';
import type { Brightness, DitheredInstance, DitheredOptions } from './renderer';
import type { Shape } from './shape';

// Re-exported so `dithered/react` consumers never need a second import
// from plain `dithered` for shapes, presets, or the core renderer.
export type { Shape, Cell, HitTester } from './shape';
export type { DitherMatrix, ResolvedMatrix } from './matrix';
export { BAYER_4, aspectOf, defaultRowsFor, sampleCells } from './shape';
export { domHitTester } from './hit-test';
export { hash, valueNoise, fbm } from './noise';
export type { Brightness, DitheredOptions, PaintContext, PaintGeometry } from './core';
export { computeGeometry, frameAt, paintFrame, resolveOptions, resolveRows } from './core';
export type { JsHitTesterOptions } from './core';
export { jsHitTester, pointInPolygons } from './core';
export type { RenderToSvgOptions } from './core';
export { renderToDataURL, renderToSvg } from './core';
export type { DitheredInstance } from './renderer';
export { createDithered } from './renderer';
export { presets, gem, sweep, pulse, rain, wave, fill, gameOfLife } from './presets';
export { shapes, rozenite, circle, square, diamond, heart } from './shapes';
export { shapeFromSvg } from './svg';
export { shapeFromSvgLite } from './svg-lite';
export type { MixAmount, CellPredicate } from './compose';
export { compose, blend, mask, timeScale, reverse, offset, invert, clamp } from './compose';

export interface DitheredProps extends Omit<
  DitheredOptions,
  'brightness' | 'shape' | 'hitTest' | 'onFrame' | 'onLoop'
> {
  shape: Shape;
  /** Per-cell, per-frame brightness. Default `presets.gem()`. */
  brightness?: Brightness;
  /** Accessible label. Set to '' to hide from assistive tech entirely. Default 'Loading'. */
  label?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Determinate progress in `[0, 1]`. Sugar over `time` (see below) with
   * playback paused: `setTime(progress * (frames - 1) / frames)`.
   * Ignored while `time` is also set — `time` wins.
   */
  progress?: number;
  /**
   * Populated with the underlying `DitheredInstance` on mount, and reset
   * to `null` on unmount. This is the only way to reach the instance from
   * `dithered/react` — `ref` keeps forwarding to the canvas element,
   * unchanged — and it exists so `refreshColors()` is callable directly
   * for the case the `[className, style, fg]`-independent refresh effect
   * below doesn't cover on its own: an ambient `currentColor` change with
   * no re-render of this component at all (see the Palettes section of
   * the README).
   */
  instanceRef?: Ref<DitheredInstance | null>;
  /**
   * Render the `initialFrame` SVG as a `background-image` (with matching
   * CSS width/height) until the first client render has painted, so
   * server-rendered HTML shows the shape instead of a blank canvas. The
   * data URL is computed in a `useMemo` that is only entered while the
   * fallback is live, so a mounted component never pays for it. Default
   * true.
   */
  ssrFallback?: boolean;
  /**
   * Drive playback externally, in loop units (`1` = one full loop).
   * Pauses the internal clock. Applied in its own effect, separate from
   * every other prop — a scrub at 60 Hz never triggers a reconfigure
   * (resample / cache rebuild). Takes precedence over `progress` when
   * both are set; clearing it back to `undefined` *or* `null` resumes
   * the internal clock from wherever it was left, not from where it was
   * interrupted — `null` behaves exactly like an absent prop (useful for
   * `time={someOptionalTime ?? null}`), it does not freeze playback.
   */
  time?: number | null;
  /** Called after a frame is painted, with the frame index and loop phase in `[0, 1)`. */
  onFrame?: (frame: number, t: number) => void;
  /**
   * Called each time the internal clock's loop wraps, with the signed
   * cumulative loop count. Not fired while `time`/`progress` drive
   * playback — a jump isn't a wrap.
   */
  onLoop?: (loops: number) => void;
}

// Stable across renders so an un-memoized caller (the common case: nobody
// passes `brightness` at all) doesn't trigger a reconfigure every render.
const DEFAULT_BRIGHTNESS = gem();

function mergeRefs<T>(...refs: Array<Ref<T> | undefined>): (value: T) => void {
  return (value: T) => {
    for (const ref of refs) {
      if (!ref) continue;
      if (typeof ref === 'function') ref(value);
      else (ref as MutableRefObject<T | null>).current = value;
    }
  };
}

/** Assigns `value` to a single (possibly absent) ref, function or object form. */
function setRef<T>(ref: Ref<T> | undefined, value: T): void {
  if (!ref) return;
  if (typeof ref === 'function') ref(value);
  else (ref as MutableRefObject<T>).current = value;
}

/** A stable join of a palette's *value*, for identity-insensitive comparison. */
function paletteKey(fg: string | readonly string[] | undefined): string | undefined {
  return fg === undefined ? undefined : typeof fg === 'string' ? fg : fg.join(' ');
}

/**
 * Returns `fg` unchanged in value, but keeps returning the *same
 * reference* across renders as long as its value (not identity) is
 * unchanged.
 *
 * `fg={['#a', '#b']}` is a fresh array every render for an unmemoized
 * caller — the common case, since nobody wraps an inline palette literal
 * in `useMemo`. Without this, every render would see a new `fg` identity
 * and the reconfigure effect below would rebuild the sprite cache and
 * re-record every frame on every render, palette or not.
 */
function useStablePalette(
  fg: string | readonly string[] | undefined,
): string | readonly string[] | undefined {
  const key = paletteKey(fg);
  const ref = useRef(fg);
  const keyRef = useRef(key);
  if (key !== keyRef.current) {
    keyRef.current = key;
    ref.current = fg;
  }
  return ref.current;
}

/**
 * React wrapper around {@link createDithered}. Creates one instance on
 * mount and destroys it on unmount; every other prop change reconfigures
 * that same instance via `update()` rather than recreating it.
 *
 * `brightness` (and `shape`) participate in that reconfigure by identity —
 * pass a stable reference (a module-level preset, or memoized with
 * `useMemo`/`useCallback`) or every render will trigger a reconfigure.
 */
export const Dithered = forwardRef<HTMLCanvasElement, DitheredProps>(function Dithered(
  {
    shape,
    brightness = DEFAULT_BRIGHTNESS,
    size,
    maxDpr,
    cols,
    rows,
    matrix,
    frames,
    period,
    fg: fgProp,
    bg,
    cache,
    paused = false,
    gap,
    radius,
    respectReducedMotion,
    initialFrame,
    speed,
    transition,
    progress,
    time,
    onFrame,
    onLoop,
    label = 'Loading',
    className,
    style,
    instanceRef: instanceRefProp,
    ssrFallback = true,
  },
  forwardedRef,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const instanceRef = useRef<DitheredInstance | null>(null);
  const skipNextUpdate = useRef(true);
  const skipNextPaused = useRef(true);

  // Stabilized by value, not identity — see `useStablePalette`.
  const fg = useStablePalette(fgProp);

  // Starts equal to `ssrFallback` on both server and client, so the first
  // client render's markup matches the server's exactly (no hydration
  // mismatch); an effect below then drops it once `createDithered` has
  // painted the real canvas.
  const [showFallback, setShowFallback] = useState(ssrFallback);

  useEffect(() => {
    setShowFallback(false);
  }, []);

  // Width/height are cheap and kept in the style object for as long as
  // `ssrFallback` is true (even after the fallback image itself is
  // dropped), so a later re-render never has React clear a size that
  // `createDithered` already set imperatively on the same element.
  const fallbackStyle = useMemo((): CSSProperties | undefined => {
    if (!ssrFallback) return undefined;
    const resolved = resolveOptions({ shape, brightness, size });
    // The server has no DOM to measure a `'fill'` canvas against, so the
    // placeholder falls back to the default pixel size — the real size
    // takes over via `ResizeObserver` once `createDithered` mounts.
    const fallbackSize = resolved.size === 'fill' ? resolveSizePx(DEFAULTS.size) : resolved.size;
    const { width, height } = surfaceSize(fallbackSize, shape);
    if (!showFallback) return { width, height };
    // Render the frame the mount effect will actually paint, not always
    // `initialFrame`: when `progress` is controlled, the determinate-
    // progress effect immediately overrides `initialFrame` with
    // `Math.round(clamp(progress) * (frameCount - 1))`. Falling back to
    // `initialFrame` regardless made a determinate `<Dithered
    // progress={0.9} />` server-render an empty bar and snap to 90% on
    // hydration.
    const frameCount = frames ?? 48;
    const fallbackFrame =
      typeof progress === 'number'
        ? Math.round(Math.min(1, Math.max(0, progress)) * (frameCount - 1))
        : initialFrame;
    const dataUrl = renderToDataURL({
      shape,
      brightness,
      size: fallbackSize,
      cols,
      rows,
      matrix,
      frames,
      fg,
      bg,
      gap,
      radius,
      frame: fallbackFrame,
    });
    return { width, height, backgroundImage: `url(${dataUrl})`, backgroundSize: '100% 100%' };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    ssrFallback,
    showFallback,
    shape,
    brightness,
    size,
    cols,
    rows,
    matrix,
    frames,
    fg,
    bg,
    gap,
    radius,
    initialFrame,
    progress,
  ]);

  // `transition`'s own fields, resolved with the same defaults
  // `resolveOptions` would fill in — read fresh from the `transition` prop
  // object every render, never merged with an *earlier* render's
  // `transition` (finding 6): the whole prop is the truth for this
  // render, so dropping a field (`{ duration: 400 }` after `{ duration:
  // 400, onLoopEnd: true }`) puts it back to its default instead of
  // leaving it stuck at whatever a previous render last set — the
  // declarative prop is not a one-way door. This is deliberately *not*
  // how `transitionTo`'s own patch merging works on the imperative core
  // API (`renderer.ts`'s `mergeTransitionOption` is sticky on purpose,
  // and stays that way) — only the declarative prop gets whole-object
  // semantics, because only the declarative prop can silently go stale
  // between renders without the caller writing every field every time.
  const resolvedTransition: ResolvedTransitionOptions | undefined = transition
    ? {
        duration: transition.duration ?? TRANSITION_DEFAULTS.duration,
        onLoopEnd: transition.onLoopEnd ?? TRANSITION_DEFAULTS.onLoopEnd,
      }
    : undefined;

  // The reconfigure effect's own "did any *option* actually change" record
  // — deliberately excludes `transition` (see the effect below, and
  // finding 5: the documented `transition={{ duration: 400 }}` usage is a
  // fresh object literal every render, so comparing `transition` itself by
  // identity would treat *every* unrelated re-render as a change).
  const prevOptionsRef = useRef({
    shape,
    brightness,
    size,
    maxDpr,
    cols,
    rows,
    matrix,
    frames,
    period,
    fg,
    bg,
    cache,
    gap,
    radius,
    respectReducedMotion,
    initialFrame,
    speed,
  });

  // Latest-value refs rather than passing the callbacks through
  // `update()`: an inline arrow function (the overwhelmingly common
  // case) has a fresh identity every render, and routing that through
  // options would either reconfigure on every render or force every
  // caller to memoize. The core gets one stable trampoline at mount;
  // these refs are only ever read from an effect or the instance's own
  // callback, never during render, so assigning them during render
  // (rather than in a `useLayoutEffect`) is safe and means the
  // mount-time paint at `initialFrame` already reaches the caller.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onLoopRef = useRef(onLoop);
  onLoopRef.current = onLoop;

  // Mount/unmount only. Re-creating the instance on every prop change
  // would throw away its cache/animation state for no benefit — that's
  // what the `update()` effect below is for.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const instance = createDithered(canvas, {
      shape,
      brightness,
      size,
      maxDpr,
      cols,
      rows,
      matrix,
      frames,
      period,
      fg,
      bg,
      cache,
      paused,
      gap,
      radius,
      respectReducedMotion,
      initialFrame,
      speed,
      transition,
      onFrame: (f, t) => onFrameRef.current?.(f, t),
      onLoop: (loops) => onLoopRef.current?.(loops),
    });
    instanceRef.current = instance;
    setRef(instanceRefProp, instance);
    skipNextUpdate.current = true;
    skipNextPaused.current = true;
    return () => {
      instance.destroy();
      instanceRef.current = null;
      setRef(instanceRefProp, null);
    };
    // `instanceRefProp` deliberately excluded, same as `forwardedRef`
    // below: a ref changing identity between renders shouldn't tear down
    // and recreate the instance, only mount/unmount should.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Applies `paused` directly via `setPaused()` — separate from the
  // reconfigure effect below so toggling it never triggers a resample/
  // cache rebuild. Skipped while `time` or `progress` is controlled,
  // since the effect below owns pausing then.
  //
  // Declared *before* the reconfigure effect on purpose (finding 4):
  // React runs a component's effects in declaration order, so when
  // `paused` and an option like `shape` change in the same commit, this
  // effect's `setPaused()` call lands on the instance before the
  // reconfigure effect below calls `update()`/`transitionTo()` — meaning
  // that call sees the instance's *new* pause state, not the one it had
  // before this render. That matters because `transitionTo()` decides
  // morph-vs-cut from whether the loop is currently advancing: with the
  // effects in the other order, unpausing and changing `shape` together
  // would call `transitionTo()` while the instance was *still* paused
  // from the previous render, taking the immediate-cut branch — on
  // `dithered/native`, the same two props in the same commit start a real
  // morph, because `holding` there is computed from *this* render's props
  // directly (see `native/Dithered.tsx`'s own comment on `holding`). This
  // ordering makes the two platforms agree: the *final*, post-commit
  // pause state decides, not which prop a caller happened to change in
  // which commit. See the README's "Transitions" section for the
  // user-facing rule.
  useEffect(() => {
    if (skipNextPaused.current) {
      skipNextPaused.current = false;
      return;
    }
    // `time == null` — loose, so it covers `null` as well as `undefined`.
    // `null` is documented as behaving exactly like an absent prop (the
    // `time={sharedValue ?? null}` pattern), and the effect below hands
    // it to `clearTime()` rather than to `setTime`, so it does not own
    // pausing and must not suppress it here.
    if (progress === undefined && time == null) instanceRef.current?.setPaused(paused);
  }, [paused, progress, time]);

  // Reconfigure (may resample cells / rebuild the sprite cache) on option
  // changes, skipping the initial mount run since `createDithered` above
  // already applied these values. `time`, `progress`, `onFrame` and
  // `onLoop` are deliberately absent: the first two get their own effect
  // below (a scrub at 60 Hz must never touch this one), and the
  // callbacks are wired once at mount via the refs above.
  //
  // Guarded on whether an option *actually* changed since the last render
  // (finding 5): this effect's dependency array still has to list
  // `transition` (its `duration`/`onLoopEnd` need to reach `update()`/
  // `transitionTo()` too), but `transition` is deliberately left out of
  // the "did anything change" comparison itself. Without that, the
  // documented `transition={{ duration: 400 }}` usage — a fresh object
  // literal every render — would make *every* unrelated parent re-render
  // look like a change, calling `transitionTo()` on props that never
  // moved. Via `transitionTo`, that cuts a half-finished morph straight to
  // its target (the abrupt jump the feature exists to remove) and pays a
  // full synchronous sprite-strip rebuild for nothing; `native/Dithered.tsx`
  // already has this guard, so this brings the two platforms back in line.
  //
  // With `transition` set, a genuine change is routed through
  // `transitionTo()` instead of `update()` — the whole point of the prop
  // is that a `shape`/`brightness` change morphs rather than cuts.
  // `transitionTo` never rejects (see `DitheredInstance`), so there is
  // nothing to catch; `void` just tells the linter the floating promise is
  // intentional.
  useEffect(() => {
    if (skipNextUpdate.current) {
      skipNextUpdate.current = false;
      prevOptionsRef.current = {
        shape,
        brightness,
        size,
        maxDpr,
        cols,
        rows,
        matrix,
        frames,
        period,
        fg,
        bg,
        cache,
        gap,
        radius,
        respectReducedMotion,
        initialFrame,
        speed,
      };
      return;
    }

    const prev = prevOptionsRef.current;
    const changed =
      prev.shape !== shape ||
      prev.brightness !== brightness ||
      prev.size !== size ||
      prev.maxDpr !== maxDpr ||
      prev.cols !== cols ||
      prev.rows !== rows ||
      prev.matrix !== matrix ||
      prev.frames !== frames ||
      prev.period !== period ||
      prev.fg !== fg ||
      prev.bg !== bg ||
      prev.cache !== cache ||
      prev.gap !== gap ||
      prev.radius !== radius ||
      prev.respectReducedMotion !== respectReducedMotion ||
      prev.initialFrame !== initialFrame ||
      prev.speed !== speed;

    prevOptionsRef.current = {
      shape,
      brightness,
      size,
      maxDpr,
      cols,
      rows,
      matrix,
      frames,
      period,
      fg,
      bg,
      cache,
      gap,
      radius,
      respectReducedMotion,
      initialFrame,
      speed,
    };

    if (!changed) return;

    const patch = {
      shape,
      brightness,
      size,
      maxDpr,
      cols,
      rows,
      matrix,
      frames,
      period,
      fg,
      bg,
      cache,
      gap,
      radius,
      respectReducedMotion,
      initialFrame,
      speed,
      transition: resolvedTransition,
    };
    if (transition) {
      void instanceRef.current?.transitionTo(patch);
    } else {
      instanceRef.current?.update(patch);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    shape,
    brightness,
    size,
    maxDpr,
    cols,
    rows,
    matrix,
    frames,
    period,
    fg,
    bg,
    cache,
    gap,
    radius,
    respectReducedMotion,
    initialFrame,
    speed,
    transition,
  ]);

  // Re-resolve `'currentColor'` on *every* render, not just when
  // `className`/`style`/`fg` change. The overwhelmingly common web
  // theming mechanism is a class toggled on some *ancestor* element — a
  // `<div className={theme}>` wrapping `<Dithered fg="currentColor" />`
  // — which changes none of this component's own props. Re-rendering
  // `<Dithered>` (which the ancestor's own re-render/CSS cascade does not
  // by itself force, but any parent state change that reaches this
  // subtree will) is the only reliable signal available here short of a
  // MutationObserver, which is deliberately out of scope (ADR 0005 §5).
  // `refreshColors()` no-ops when the resolved color hasn't actually
  // changed, so running it unconditionally on every render costs at most
  // one `getComputedStyle` call and is never visible as a repaint when
  // nothing changed. Still guarded on the palette actually containing the
  // token, so a plain `fg` never pays even that cost. No dependency array
  // — this is intentionally not a `useEffect(fn, [...])`.
  useEffect(() => {
    if (fg === undefined) return;
    if (!hasCurrentColor(toPalette(fg))) return;
    instanceRef.current?.refreshColors();
  });

  // External phase: `time`, or `progress` as sugar over it. Its own
  // effect, deliberately outside the reconfigure effect above — driving
  // this at 60 Hz must never touch `configure()`. `time` wins when both
  // are passed; when neither is, `clearTime()` hands playback back to
  // the internal clock from wherever the external driver left it.
  useEffect(() => {
    const instance = instanceRef.current;
    if (!instance) return;
    if (typeof time === 'number') {
      instance.setTime(time);
      return;
    }
    if (typeof progress === 'number') {
      instance.setPaused(true);
      // Reads `DEFAULTS.frames`, not a hard-coded `48` — this mapping
      // must track the renderer's actual default, not duplicate it.
      const frameCount = frames ?? DEFAULTS.frames;
      const clamped = Math.min(1, Math.max(0, progress));
      // The frame index is computed once, explicitly, and only then
      // turned into a phase that quantizes back to it exactly (ADR 0006
      // §8) — `setTime((clamped * (frameCount - 1)) / frameCount)` looks
      // equivalent but isn't: the product is quantized straight back by
      // `frameForPhase`, and the round trip loses a bit for most frame
      // counts (`progress: 1` at the default `frames: 48` lands on frame
      // 46, not 47 — see finding 2). `frames: 0` is guarded explicitly:
      // `phaseForFrame(0, 0)` is `Infinity`, which `setTime` would
      // otherwise have to ignore via its own non-finite guard rather
      // than never producing it in the first place.
      const frame = frameCount > 0 ? Math.floor(clamped * (frameCount - 1)) : 0;
      instance.setTime(frameCount > 0 ? phaseForFrame(frame, frameCount) : 0);
      return;
    }
    instance.clearTime();
  }, [time, progress, frames]);

  return (
    <canvas
      ref={mergeRefs(canvasRef, forwardedRef)}
      className={className}
      style={{ imageRendering: 'pixelated', ...fallbackStyle, ...style }}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
});
