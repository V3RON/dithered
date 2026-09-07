import { useCallback, useEffect, useRef, useState } from 'react';
import { AppState, type StyleProp, type ViewStyle } from 'react-native';
import { Canvas, Picture } from '@shopify/react-native-skia';
import {
  runOnJS,
  useAnimatedReaction,
  useFrameCallback,
  useReducedMotion,
  useSharedValue,
  type SharedValue,
} from 'react-native-reanimated';
import type { Brightness, DitheredOptions } from '../core';
import { gem } from '../presets';
import type { Cell, Shape } from '../shape';
import { useDitheredPictures } from './pictures';
import { advancePhaseUI, frameForPhaseUI, loopsAtUI, wrapPhaseUI } from './playback';

export interface DitheredProps extends Omit<
  DitheredOptions,
  'shape' | 'brightness' | 'cache' | 'paused' | 'size' | 'onFrame' | 'onLoop'
> {
  shape: Shape;
  /** Per-cell, per-frame brightness. Default `presets.gem()`. */
  brightness?: Brightness;
  /**
   * Height in dp; width follows the shape's aspect ratio. `'fill'` is a
   * web-only concept — size the `<Canvas>` through `style` instead.
   * Default 48.
   */
  size?: number;
  /** Freeze the animation on the current frame. Default false. */
  paused?: boolean;
  /**
   * Determinate progress in `[0, 1]`. Sugar over `time` with playback
   * paused. Ignored while `time` is also set — `time` wins.
   */
  progress?: number;
  /**
   * Drive playback externally, in loop units (`1` = one full loop).
   * Halts the internal frame callback. A plain `number` updates from an
   * ordinary effect; a Reanimated `SharedValue<number>` is mirrored on
   * the UI thread via `useAnimatedReaction`, so a gesture or scroll
   * handler writing `time.value` reaches the picture swap without a JS
   * round trip. Takes precedence over `progress`; clearing it back to
   * `undefined` resumes the frame callback from wherever it was left.
   */
  time?: number | SharedValue<number>;
  /**
   * Called after a frame is painted, with the frame index and loop
   * phase in `[0, 1)`. Crosses to the JS thread via `runOnJS` — not for
   * per-frame work.
   */
  onFrame?: (frame: number, t: number) => void;
  /**
   * Called each time the internal clock's loop wraps, with the signed
   * cumulative loop count. Not fired while `time`/`progress` drive
   * playback — a jump isn't a wrap.
   */
  onLoop?: (loops: number) => void;
  /**
   * Pre-sampled cells, skipping the shape hit-test on mount. Must match
   * `cols`, `rows` and `matrix` — see `sampleCells`. When set, `matrix`
   * is ignored: the thresholds are already baked into those cells. A
   * `matrix` change still re-records every frame in this case (for
   * byte-identical output) — see `useDitheredPictures`'s `cells` doc.
   */
  cells?: readonly Cell[];
  /** Accessible label. Set to '' to hide from assistive tech entirely. Default 'Loading'. */
  label?: string;
  style?: StyleProp<ViewStyle>;
}

// Stable across renders so an un-memoized caller (the common case: nobody
// passes `brightness` at all) doesn't re-record every picture on render.
const DEFAULT_BRIGHTNESS = gem();

/** True while the app is foregrounded; recordings keep playing only then. */
function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setActive(next === 'active'),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

function wrapFrame(frame: number, count: number): number {
  return ((Math.round(frame) % count) + count) % count;
}

/** Duck-typed rather than Reanimated's `isSharedValue`, to avoid raising the peer floor. */
function isSharedValue(value: unknown): value is SharedValue<number> {
  return typeof value === 'object' && value !== null && 'value' in value;
}

/**
 * React Native counterpart to `dithered/react`'s `<Dithered>`, rendering
 * through `@shopify/react-native-skia`.
 *
 * Every frame of the loop is recorded once as an `SkPicture`
 * (see {@link useDitheredPictures}); playback then only swaps which
 * recording the canvas draws. Both the internal clock (a phase
 * accumulator in the frame callback, mirroring the web driver — see ADR
 * 0006) and an externally-driven `time` funnel through the same
 * workletized `applyPhase`, so there is exactly one place that decides
 * what is painted. `time` as a `SharedValue` is read inside a
 * `useAnimatedReaction`'s UI-thread prepare function, so a gesture or
 * scroll handler writing straight into it reaches the picture swap
 * without ever crossing to JS.
 *
 * Playback stops while the app is backgrounded, while `paused` is set,
 * while `time`/`progress` drive playback directly, and — unless
 * `respectReducedMotion` is false — while the OS reports a
 * reduced-motion preference.
 */
export function Dithered({
  shape,
  brightness = DEFAULT_BRIGHTNESS,
  size,
  cols,
  rows,
  matrix,
  frames,
  period = 2000,
  fg,
  bg,
  gap,
  radius,
  paused = false,
  initialFrame = 0,
  respectReducedMotion = true,
  speed = 1,
  progress,
  time,
  onFrame,
  onLoop,
  cells,
  hitTest,
  label = 'Loading',
  style,
}: DitheredProps) {
  const { pictures, width, height } = useDitheredPictures({
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
    cells,
    hitTest,
  });
  const frameCount = pictures.length;

  const reducedMotion = useReducedMotion();
  const appActive = useAppActive();

  const currentFrame = useSharedValue(wrapFrame(initialFrame, frameCount));
  const picture = useSharedValue(pictures[wrapFrame(initialFrame, frameCount)]);
  // The internal clock's own accumulator, in loop units — only advanced
  // by the frame callback, and only while nothing external is driving.
  const internalPhase = useSharedValue(frameCount > 0 ? initialFrame / frameCount : 0);
  // Mirrors whatever `time` currently is, from whichever source wrote it
  // last (see the two write paths below); `null` means nothing is
  // externally driving playback right now.
  const externalPhase = useSharedValue<number | null>(null);

  // Re-point at the new recordings whenever they are rebuilt, so an
  // option change is visible even while playback is halted.
  useEffect(() => {
    const frame = wrapFrame(currentFrame.value, frameCount);
    currentFrame.value = frame;
    picture.value = pictures[frame];
  }, [pictures, frameCount, currentFrame, picture]);

  // Latest-value ref trampolines, mirroring `dithered/react`: `onFrame`
  // fires via `runOnJS` from the UI thread and must not itself force a
  // worklet rebuild every render, so the identity handed to `runOnJS`
  // stays stable across renders while always calling the latest prop.
  const onFrameRef = useRef(onFrame);
  onFrameRef.current = onFrame;
  const onLoopRef = useRef(onLoop);
  onLoopRef.current = onLoop;
  const notifyFrame = useCallback((frame: number, t: number) => onFrameRef.current?.(frame, t), []);
  const notifyLoop = useCallback((loops: number) => onLoopRef.current?.(loops), []);

  // The one place that decides what is painted, whether `phase` came
  // from the internal accumulator, a numeric `time`, or a `time`
  // `SharedValue` — mirroring the web driver's `paintForPhase`. Redefined
  // each render (a plain closure, not memoized) so it always sees the
  // latest `pictures`/`frameCount`; the shared values it touches are
  // stable across renders, so that's cheap.
  const applyPhase = (phase: number) => {
    'worklet';
    const frame = frameForPhaseUI(phase, frameCount);
    if (frame !== currentFrame.value) {
      currentFrame.value = frame;
      picture.value = pictures[frame];
      runOnJS(notifyFrame)(frame, wrapPhaseUI(phase));
    }
  };

  const driven = time !== undefined || progress !== undefined;
  const holding =
    paused || driven || !appActive || (respectReducedMotion && reducedMotion === true);

  // Internal clock: a phase accumulator identical in shape to the web
  // driver's, advanced from `timeSincePreviousFrame` (`?? 0` on the
  // first frame after every (re)activation, so a pause/resume or a
  // background/foreground cycle can never jump the phase — the native
  // equivalent of the web driver resetting `lastNow` on `halt()`).
  // Deactivated below whenever something external is driving.
  const loop = useFrameCallback((info) => {
    'worklet';
    const dt = info.timeSincePreviousFrame ?? 0;
    const loopsBefore = loopsAtUI(internalPhase.value);
    internalPhase.value = advancePhaseUI(internalPhase.value, dt, period, speed);
    const loopsAfter = loopsAtUI(internalPhase.value);
    if (loopsAfter !== loopsBefore) runOnJS(notifyLoop)(loopsAfter);
    applyPhase(internalPhase.value);
  }, false);

  useEffect(() => {
    loop.setActive(!holding);
    // `loop` is a fresh object each render; keying the effect on it would
    // cross to the UI thread on every render for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding]);

  const drivingSharedValue = isSharedValue(time);

  // Write path 1: a numeric `time`, or `progress` as sugar over it
  // (`time` wins when both are set). Runs on the JS thread — the value
  // only ever changes on a JS render anyway, so there's nothing to save
  // by reading it from a worklet.
  useEffect(() => {
    if (typeof time === 'number') {
      externalPhase.value = time;
      applyPhase(time);
      return;
    }
    if (drivingSharedValue) return; // handled by the reaction below
    if (typeof progress === 'number') {
      const clamped = Math.min(1, Math.max(0, progress));
      const phase = frameCount > 0 ? (clamped * (frameCount - 1)) / frameCount : 0;
      externalPhase.value = phase;
      applyPhase(phase);
      return;
    }
    // Neither `time` nor `progress`: hand control back to the internal
    // clock, continuing from wherever the external driver left the
    // phase rather than snapping back to wherever `internalPhase` was
    // frozen when driving started.
    if (externalPhase.value !== null) {
      internalPhase.value = externalPhase.value;
      externalPhase.value = null;
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [time, drivingSharedValue, progress, frameCount]);

  // Write path 2: a `SharedValue` `time`, mirrored on the UI thread so a
  // gesture or scroll handler writing `time.value` reaches the picture
  // swap without a JS round trip.
  useAnimatedReaction(
    () => (drivingSharedValue ? (time as SharedValue<number>).value : null),
    (value) => {
      'worklet';
      if (!drivingSharedValue || value === null) return;
      externalPhase.value = value;
      applyPhase(value);
    },
    // `time` itself, not just `drivingSharedValue`: swapping in a
    // *different* SharedValue must rebuild the worklets' capture of it
    // too, or the reaction would silently keep reading the old one.
    [time, drivingSharedValue],
  );

  return (
    <Canvas
      style={[{ width, height }, style]}
      accessible={label !== ''}
      accessibilityLabel={label || undefined}
      accessibilityRole="progressbar"
      accessibilityValue={
        progress === undefined
          ? undefined
          : { min: 0, max: 100, now: Math.round(Math.min(1, Math.max(0, progress)) * 100) }
      }
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
    >
      <Picture picture={picture} />
    </Canvas>
  );
}
