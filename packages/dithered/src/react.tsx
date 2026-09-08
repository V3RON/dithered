import { forwardRef, useEffect, useRef } from 'react';
import type { CSSProperties, MutableRefObject, Ref } from 'react';
import { gem } from './presets';
import { createDithered } from './renderer';
import type { Brightness, DitheredInstance, DitheredOptions } from './renderer';
import type { Shape } from './shape';

// Re-exported so `dithered/react` consumers never need a second import
// from plain `dithered` for shapes, presets, or the core renderer.
export type { Shape, Cell, HitTester } from './shape';
export { BAYER_4, aspectOf, defaultRowsFor, sampleCells } from './shape';
export { domHitTester } from './hit-test';
export { hash, valueNoise, fbm } from './noise';
export type { Brightness, DitheredOptions, PaintContext, PaintGeometry } from './core';
export { computeGeometry, frameAt, paintFrame, resolveOptions, resolveRows } from './core';
export type { DitheredInstance } from './renderer';
export { createDithered } from './renderer';
export { presets, gem, sweep, pulse, rain, wave, fill, gameOfLife } from './presets';
export { shapes, rozenite, circle, square, diamond, heart } from './shapes';
export { shapeFromSvg } from './svg';
export { shapeFromSvgLite } from './svg-lite';

export interface DitheredProps extends Omit<DitheredOptions, 'brightness' | 'shape'> {
  shape: Shape;
  /** Per-cell, per-frame brightness. Default `presets.gem()`. */
  brightness?: Brightness;
  /** Accessible label. Set to '' to hide from assistive tech entirely. Default 'Loading'. */
  label?: string;
  className?: string;
  style?: CSSProperties;
  /**
   * Determinate progress in `[0, 1]`. When set, the animation is paused
   * and the frame corresponding to `progress` is rendered directly.
   */
  progress?: number;
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
    cols,
    rows,
    frames,
    period,
    fg,
    bg,
    cache,
    paused = false,
    gap,
    radius,
    respectReducedMotion,
    initialFrame,
    progress,
    label = 'Loading',
    className,
    style,
  },
  forwardedRef,
) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  const instanceRef = useRef<DitheredInstance | null>(null);
  const skipNextUpdate = useRef(true);
  const skipNextPaused = useRef(true);

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
      cols,
      rows,
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
    });
    instanceRef.current = instance;
    skipNextUpdate.current = true;
    skipNextPaused.current = true;
    return () => {
      instance.destroy();
      instanceRef.current = null;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Reconfigure (may resample cells / rebuild the sprite cache) on option
  // changes, skipping the initial mount run since `createDithered` above
  // already applied these values.
  useEffect(() => {
    if (skipNextUpdate.current) {
      skipNextUpdate.current = false;
      return;
    }
    instanceRef.current?.update({
      shape,
      brightness,
      size,
      cols,
      rows,
      frames,
      period,
      fg,
      bg,
      cache,
      gap,
      radius,
      respectReducedMotion,
      initialFrame,
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    shape,
    brightness,
    size,
    cols,
    rows,
    frames,
    period,
    fg,
    bg,
    cache,
    gap,
    radius,
    respectReducedMotion,
    initialFrame,
  ]);

  // Separate from the reconfigure effect so toggling `paused` never
  // triggers a resample/cache rebuild. Skipped when `progress` is a
  // controlled value, since that effect owns pausing in that mode.
  useEffect(() => {
    if (skipNextPaused.current) {
      skipNextPaused.current = false;
      return;
    }
    if (progress === undefined) instanceRef.current?.setPaused(paused);
  }, [paused, progress]);

  // Determinate progress: pause and render the matching frame directly.
  useEffect(() => {
    if (typeof progress !== 'number') return;
    const instance = instanceRef.current;
    if (!instance) return;
    instance.setPaused(true);
    const frameCount = frames ?? 48;
    const clamped = Math.min(1, Math.max(0, progress));
    instance.renderFrame(Math.round(clamped * (frameCount - 1)));
  }, [progress, frames]);

  return (
    <canvas
      ref={mergeRefs(canvasRef, forwardedRef)}
      className={className}
      style={{ imageRendering: 'pixelated', ...style }}
      role={label ? 'status' : undefined}
      aria-label={label || undefined}
      aria-hidden={label ? undefined : true}
    />
  );
});
