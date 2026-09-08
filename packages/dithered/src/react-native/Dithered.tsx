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
import { wrapFrame } from '../core';
import { gem } from '../presets';
import type { Cell, Shape } from '../shape';
import { useDitheredPictures } from './pictures';
import {
  advancePhaseUI,
  frameForRepoint,
  isExternallyDriven,
  loopsAtUI,
  phaseForFrameUI,
  resolveAppliedFrame,
  wrapPhaseUI,
} from './playback';

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
   * `undefined` *or* `null` resumes the frame callback from wherever it
   * was left — `null` behaves exactly like an absent prop (useful for
   * `time={sharedValue ?? null}`, before the shared value exists), it
   * does not freeze playback.
   */
  time?: number | SharedValue<number> | null;
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

  // The seed frame/phase pair agree exactly: `internalPhase` is derived
  // from `seedFrame` via `phaseForFrameUI`, not a bare `initialFrame /
  // frameCount` (finding 7 — the latter rounds down for a third of its
  // valid inputs, same as finding 3 on the web side, and disagreed with
  // `currentFrame`'s exact `wrapFrame` seed).
  const seedFrame = wrapFrame(initialFrame, frameCount);
  const currentFrame = useSharedValue(seedFrame);
  const picture = useSharedValue(pictures[seedFrame]);
  // The internal clock's own accumulator, in loop units — only advanced
  // by the frame callback, and only while nothing external is driving.
  const internalPhase = useSharedValue(frameCount > 0 ? phaseForFrameUI(seedFrame, frameCount) : 0);
  // Mirrors whatever `time` currently is, from whichever source wrote it
  // last (see the two write paths below); `null` means nothing is
  // externally driving playback right now.
  const externalPhase = useSharedValue<number | null>(null);
  // Differenced against `info.timestamp` to get `dt` for the internal
  // clock (see the frame callback below) — deliberately not
  // `info.timeSincePreviousFrame`, which resets to `null` every time
  // `useFrameCallback` re-registers its worklet (finding 4).
  const lastTimestamp = useSharedValue<number | null>(null);

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

  // Re-point at the new recordings whenever they are rebuilt, so an
  // option change is visible even while playback is halted. Re-derives
  // the frame from whichever of `externalPhase`/`internalPhase` is
  // currently driving (finding 2): `wrapFrame(currentFrame.value,
  // frameCount)` — the old frame index modulo the new count — is
  // exactly the `currentFrame % opts.frames` mapping ADR 0006 §4
  // replaced on the web, and disagrees with the web driver (which
  // re-points from the preserved *phase*) whenever `frames` changes.
  useEffect(() => {
    const previousFrame = currentFrame.value;
    const phase = externalPhase.value ?? internalPhase.value;
    const frame = frameForRepoint(externalPhase.value, internalPhase.value, frameCount);
    currentFrame.value = frame;
    picture.value = pictures[frame];
    // Reports the move, matching the web driver's structural `update()`
    // (finding 4). Without this a `frames` change repaints native
    // silently while web fires `onFrame`, so a caller tracking "which
    // frame is showing" diverges from the canvas until the accumulator
    // happens to move it again. Called directly rather than through
    // `runOnJS`: this is an effect, already on the JS thread.
    if (frame !== previousFrame) onFrameRef.current?.(frame, wrapPhaseUI(phase));
  }, [pictures, frameCount, currentFrame, picture, externalPhase, internalPhase, onFrameRef]);

  // The initial paint at `initialFrame` fires `onFrame`, on both
  // platforms (ADR 0006 §2) — already on the JS thread at mount, so no
  // `runOnJS` hop is needed for a value that only exists once.
  useEffect(() => {
    onFrameRef.current?.(seedFrame, wrapPhaseUI(phaseForFrameUI(seedFrame, frameCount)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Whether a callback is even attached, captured as a plain boolean so
  // the worklets below can skip the `runOnJS` hop entirely when nothing
  // is listening (finding 5) — the trampolines above are stable
  // regardless of whether a callback is passed, so the worklet has no
  // other way to know.
  const hasOnFrame = onFrame !== undefined;
  const hasOnLoop = onLoop !== undefined;

  // The one place that decides what is painted, whether `phase` came
  // from the internal accumulator, a numeric `time`, or a `time`
  // `SharedValue` — mirroring the web driver's `paintForPhase`. Memoized
  // over its real dependencies (finding 1 / finding 4): closing over a
  // stale `pictures`/`frameCount` is exactly the bug where a
  // `SharedValue`-driven `useAnimatedReaction` (below) keeps painting
  // from a recording set that was already replaced.
  const applyPhase = useCallback(
    (phase: number) => {
      'worklet';
      // What to paint (or whether to paint at all) is decided by
      // `resolveAppliedFrame` — a non-finite `phase` (ADR 0006 §3,
      // finding 1) or one that maps to the frame already showing both
      // return `null`, and this worklet does nothing: no shared-value
      // write, no `onFrame`. Pulled out so the decision is unit-testable
      // without a React Native renderer (this package has none).
      const frame = resolveAppliedFrame(phase, frameCount, currentFrame.value);
      if (frame !== null) {
        currentFrame.value = frame;
        picture.value = pictures[frame];
        if (hasOnFrame) runOnJS(notifyFrame)(frame, wrapPhaseUI(phase));
      }
    },
    [pictures, frameCount, currentFrame, picture, hasOnFrame, notifyFrame],
  );

  // `null` is treated the same as `undefined` — *not* driven (finding
  // 6) — because no write path below ever claims it: `typeof null ===
  // 'number'` is false and `isSharedValue(null)` is false (its
  // `value !== null` guard), so a `null` `time` reaches neither write
  // path and would otherwise leave `holding` permanently true with
  // nothing ever driving `applyPhase` again.
  const driven = isExternallyDriven(time, progress);
  const holding =
    paused || driven || !appActive || (respectReducedMotion && reducedMotion === true);

  // Internal clock: a phase accumulator identical in shape to the web
  // driver's. `dt` comes from differencing `info.timestamp` against
  // `lastTimestamp` (finding 4), reset to `null` whenever the clock is
  // deactivated below — the native equivalent of the web driver
  // resetting `lastNow` on `halt()` — so the first tick after every
  // (re)activation always sees `dt = 0` rather than a jump. Memoized
  // with `useCallback` on top of that (ADR 0006 §6): belt and braces,
  // since an unmemoized worklet would otherwise churn the frame-callback
  // registration on every unrelated parent render.
  const loop = useFrameCallback(
    useCallback(
      (info) => {
        'worklet';
        const dt = lastTimestamp.value === null ? 0 : info.timestamp - lastTimestamp.value;
        lastTimestamp.value = info.timestamp;
        const loopsBefore = loopsAtUI(internalPhase.value);
        internalPhase.value = advancePhaseUI(internalPhase.value, dt, period, speed);
        const loopsAfter = loopsAtUI(internalPhase.value);
        if (loopsAfter !== loopsBefore && hasOnLoop) runOnJS(notifyLoop)(loopsAfter);
        applyPhase(internalPhase.value);
      },
      [lastTimestamp, internalPhase, period, speed, hasOnLoop, notifyLoop, applyPhase],
    ),
    false,
  );

  useEffect(() => {
    loop.setActive(!holding);
    if (holding) lastTimestamp.value = null;
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
      // Guarded at the point of *storage*, not just where it is painted.
      // `applyPhase` refusing to paint a non-finite phase (ADR 0006 §3)
      // keeps the wrong frame off screen, but storing one is what does
      // the lasting damage: the hand-back branch below copies
      // `externalPhase` into the accumulator, and from there
      // `loopsAt(NaN) !== loopsAt(NaN)` fires `onLoop(NaN)` on every
      // tick forever while the picture never changes again. Skipping the
      // write leaves the previous phase in place, which is what "the
      // displayed frame just holds" means.
      if (Number.isFinite(time)) {
        externalPhase.value = time;
        applyPhase(time);
      }
      return;
    }
    if (drivingSharedValue) return; // handled by the reaction below
    if (typeof progress === 'number') {
      // The frame index is computed once, explicitly, and only then
      // turned into a phase that quantizes back to it exactly (ADR 0006
      // §8) — a bare `(clamped * (frameCount - 1)) / frameCount` is
      // quantized straight back by `frameForPhaseUI`, and the round trip
      // loses a bit for most frame counts (finding 2).
      const clamped = Math.min(1, Math.max(0, progress));
      const frame = frameCount > 0 ? Math.floor(clamped * (frameCount - 1)) : 0;
      const phase = frameCount > 0 ? phaseForFrameUI(frame, frameCount) : 0;
      // Same storage guard as the `time` branch above: `progress={loaded
      // / total}` with `total === 0` is `NaN`, and `Math.floor(NaN * n)`
      // survives every clamp on the way here.
      if (Number.isFinite(phase)) {
        externalPhase.value = phase;
        applyPhase(phase);
      }
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
  }, [time, drivingSharedValue, progress, frameCount, applyPhase]);

  // Write path 2: a `SharedValue` `time`, mirrored on the UI thread so a
  // gesture or scroll handler writing `time.value` reaches the picture
  // swap without a JS round trip.
  useAnimatedReaction(
    () => (drivingSharedValue ? (time as SharedValue<number>).value : null),
    (value) => {
      'worklet';
      if (!drivingSharedValue || value === null) return;
      // Storage guard, as in write path 1: a gesture handler computing
      // `time.value = x / width` can hand this a `NaN` on a zero-width
      // layout pass, and a stored `NaN` outlives the bad frame.
      if (!Number.isFinite(value)) return;
      externalPhase.value = value;
      applyPhase(value);
    },
    // `time` itself, not just `drivingSharedValue`: swapping in a
    // *different* SharedValue must rebuild the worklets' capture of it
    // too, or the reaction would silently keep reading the old one.
    // `applyPhase` is the finding-1 fix: without it, this reaction keeps
    // closing over whatever `pictures`/`frameCount` were current the
    // last time `time`/`drivingSharedValue` themselves changed, so a
    // recordings rebuild (a `shape`/`brightness`/... change) that
    // happens while a `SharedValue` is actively driving never reaches
    // this worklet — the next gesture-driven write silently repaints
    // from the stale recording set.
    [time, drivingSharedValue, applyPhase],
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
