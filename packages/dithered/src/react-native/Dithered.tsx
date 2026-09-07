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
import { TRANSITION_DEFAULTS, wrapFrame, type Brightness, type DitheredOptions } from '../core';
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
import { useDitheredTransition, type DitheredTransitionSide } from './transition';

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

/** The steady-state config a morph runs between — see {@link DitheredTransitionSide}. */
type Snapshot = DitheredTransitionSide;

/**
 * A morph in flight: what it's morphing between, and when it started.
 *
 * `startedAt` is in the *same clock* the steady loop computes its own
 * phase from — the frame callback's virtual, reset-proof clock (see
 * `useFrameCallback` below), sampled continuously into `elapsedMsRef` —
 * not `Date.now()`. Using a `Date.now()`-based clock here (as an earlier
 * version did) fed `useDitheredTransition` a `now` on a completely
 * different epoch than the loop's own, so both sides' phases baked into
 * the morph recording had no relationship to where the steady loop
 * actually was: ADR 0004 §4's "neither preset visibly jumps" requires
 * both clocks to agree (finding 4 of the original review).
 */
interface MorphState {
  from: Snapshot;
  to: Snapshot;
  startedAt: number;
}

/**
 * React Native counterpart to `dithered/react`'s `<Dithered>`, rendering
 * through `@shopify/react-native-skia`.
 *
 * Every frame of the steady-state loop is recorded once as an `SkPicture`
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
 * With `transition` set, a `shape`/`brightness` (or other steady-config)
 * change plays a morph first — recorded up front by
 * {@link useDitheredTransition} the same way, so playback stays on the UI
 * thread there too (ADR 0004 §5) — before handing off to the new steady
 * recordings. Without it, a change still cuts immediately, same as before
 * this ADR.
 *
 * Playback stops while the app is backgrounded, while `paused` is set,
 * while `time`/`progress` drive playback directly, and — unless
 * `respectReducedMotion` is false — while the OS reports a
 * reduced-motion preference; a morph in flight when that happens
 * completes immediately rather than freezing half-morphed (ADR 0004 §7).
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
  transition,
  progress,
  time,
  onFrame,
  onLoop,
  cells,
  hitTest,
  label = 'Loading',
  style,
}: DitheredProps) {
  const reducedMotion = useReducedMotion();
  const appActive = useAppActive();

  // `null` is treated the same as `undefined` — *not* driven (finding
  // 6) — because no write path below ever claims it: `typeof null ===
  // 'number'` is false and `isSharedValue(null)` is false (its
  // `value !== null` guard), so a `null` `time` reaches neither write
  // path and would otherwise leave `holding` permanently true with
  // nothing ever driving `applyPhase` again.
  const driven = isExternallyDriven(time, progress);
  // Whether playback is halted this render — computed from *this* render's
  // props/hooks, not carried over from before. That is a deliberate choice
  // (finding 4 of the original review, resolved between the two
  // platforms): unpausing and changing `shape` in the same commit starts a
  // morph here, because by the time this render's effects run, `holding`
  // already reflects the *new* `paused`. `dithered/react`'s wrapper is
  // ordered (its `paused` effect before its reconfigure effect) to make
  // the imperative core agree — see its own comment and the README's
  // "Transitions" section.
  const holding =
    paused || driven || !appActive || (respectReducedMotion && reducedMotion === true);

  // `transition`'s own fields, resolved with the same defaults
  // `resolveOptions` would fill in — read fresh from the prop object every
  // render, never merged with a previous render's `transition` (finding
  // 6): the *whole* `transition` prop is the truth for this render, so
  // dropping a field (e.g. `{ duration: 400 }` after `{ duration: 400,
  // onLoopEnd: true }`) puts it back to its default rather than leaving it
  // stuck at whatever an earlier render last set — the declarative prop
  // is not a one-way door. (The imperative `transitionTo(patch)` on the
  // web/core API keeps its own sticky merge — see `renderer.ts`'s
  // `mergeTransitionOption` — this rule is specifically about a
  // declarative `transition` prop's whole-object semantics.)
  const onLoopEnd = transition?.onLoopEnd ?? TRANSITION_DEFAULTS.onLoopEnd;
  const duration = transition?.duration ?? TRANSITION_DEFAULTS.duration;

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

  // Whether a callback is even attached, captured as a plain boolean so
  // the worklets below can skip the `runOnJS` hop entirely when nothing
  // is listening (finding 5) — the trampolines above are stable
  // regardless of whether a callback is passed, so the worklet has no
  // other way to know.
  const hasOnFrame = onFrame !== undefined;
  const hasOnLoop = onLoop !== undefined;

  const snapshot: Snapshot = {
    shape,
    brightness,
    size,
    cols,
    rows,
    matrix,
    frames,
    period,
    fg,
    bg,
    gap,
    radius,
    cells,
    hitTest,
  };

  // The last snapshot this component actually *diffed against* — advances
  // on every detected change, whether or not that change ends up starting
  // or queuing a morph, so the next change is always compared against the
  // most recently requested config rather than a stale one. Distinct from
  // `morphFromRef` below.
  const prevRef = useRef<Snapshot>(snapshot);
  const prevSnapshot = prevRef.current;

  const changed =
    prevSnapshot.shape !== snapshot.shape ||
    prevSnapshot.brightness !== snapshot.brightness ||
    prevSnapshot.size !== snapshot.size ||
    prevSnapshot.cols !== snapshot.cols ||
    prevSnapshot.rows !== snapshot.rows ||
    prevSnapshot.matrix !== snapshot.matrix ||
    prevSnapshot.frames !== snapshot.frames ||
    prevSnapshot.period !== snapshot.period ||
    prevSnapshot.fg !== snapshot.fg ||
    prevSnapshot.bg !== snapshot.bg ||
    prevSnapshot.gap !== snapshot.gap ||
    prevSnapshot.radius !== snapshot.radius ||
    prevSnapshot.cells !== snapshot.cells ||
    prevSnapshot.hitTest !== snapshot.hitTest;

  const wantsMorph = changed && transition !== undefined && !holding;

  /**
   * The config actually on screen before the *current* morph episode
   * (queued or active) began — frozen the instant that episode starts,
   * read back on every render for as long as it lasts, and cleared the
   * instant it ends (naturally via `finishMorph`, or forced by a halt
   * below). `null` whenever no episode is in flight.
   *
   * This — not `prevRef` — is what `useDitheredPictures` below is built
   * from while an episode is live. `prevRef` keeps moving forward on
   * every superseding change so the *next* diff is always correct
   * (matching the core renderer's `computeTargetOpts`), but the picture
   * this component actually paints must not: it has to stay on the
   * *original* outgoing config for the whole episode, exactly like the
   * core renderer's `ActiveTransition`/`PendingTransition` keep a fixed
   * `from` while recomputing only the target (finding 2 of the original
   * review). Using `prevRef` here directly — as an earlier version did —
   * meant a second queued change before the first's wrap arrived quietly
   * re-based the morph onto an intermediate, never-displayed target
   * instead of what the user actually saw.
   *
   * Read and written synchronously during render, not from an effect:
   * `useDitheredPictures` and `useFrameCallback` below are called later
   * in *this same render*, so whatever this decides has to be decided
   * before they run — an effect settling it afterward would be one React
   * commit (and, on the UI thread, one paint) too late. This is what
   * finding 1 of the original review was: the UI-thread loop's steady
   * branch has no morph state to gate it while a morph is merely
   * *queued*, so if `useDitheredPictures` had already rebuilt for the
   * target by then, the loop would paint that target on its very next
   * tick, long before any morph frame existed to justify it. Gating a
   * JS-thread effect (the previous fix's `suppressRepointRef`) narrowed
   * the window but could not close it, because the frame callback reads
   * `pictures` directly and never consulted that ref.
   */
  const morphFromRef = useRef<Snapshot | null>(null);

  if (holding) {
    // ADR 0004 §7: a halted loop (paused, backgrounded, reduced motion,
    // controlled `progress`) never plays a morph — any episode in flight
    // or merely queued is force-completed immediately, so the steady
    // picture array must track the *current* props right away, same as
    // an ordinary cut always has. (The `morph` React state itself, if an
    // episode was actually *active*, is settled by the halt effect below
    // — this only unpins the picture source so that settling has
    // something correct to land on.)
    morphFromRef.current = null;
  } else if (wantsMorph) {
    if (morphFromRef.current === null) {
      // The first change of a fresh episode: freeze what's on screen now.
      morphFromRef.current = prevSnapshot;
    }
    // Else: already mid-episode (queued or active) and superseded by a
    // newer change before it resolved — keep the original freeze; only
    // the target (`next`, captured fresh by the effect below) moves.
  } else if (changed) {
    // An ordinary cut: nothing to morph in front of (no `transition`, or
    // it was just unset). Release any stale pin too, in case `transition`
    // itself is what just changed mid-episode.
    morphFromRef.current = null;
  }

  const steadySnapshot = morphFromRef.current ?? snapshot;

  const { pictures, width, height } = useDitheredPictures({
    shape: steadySnapshot.shape,
    brightness: steadySnapshot.brightness,
    size: steadySnapshot.size,
    cols: steadySnapshot.cols,
    rows: steadySnapshot.rows,
    matrix: steadySnapshot.matrix,
    frames: steadySnapshot.frames,
    fg: steadySnapshot.fg,
    bg: steadySnapshot.bg,
    gap: steadySnapshot.gap,
    radius: steadySnapshot.radius,
    cells: steadySnapshot.cells,
    hitTest: steadySnapshot.hitTest,
  });
  const frameCount = pictures.length;

  // --- playback shared values ------------------------------------------

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
  // Distinct from `currentFrame`/`picture` above: tracks which recorded
  // morph frame is currently painted, while a morph owns the canvas.
  const morphStep = useSharedValue(0);
  // The steady loop's own *virtual* clock — see `useFrameCallback` below —
  // refreshed every tick. Read from JS (an ordinary, if up-to-a-frame-stale,
  // shared-value read) whenever a morph starts, so its recording continues
  // *this* clock instead of `Date.now()`, which has no fixed relationship
  // to it (see `MorphState`).
  const elapsedMsRef = useSharedValue(0);
  // The raw `info.timeSinceFirstFrame` observed on the previous tick, and
  // a running offset folded in every time that raw clock is seen to go
  // backwards — see `useFrameCallback` below (finding 2).
  const lastRawTimeRef = useSharedValue(0);
  const clockOffsetRef = useSharedValue(0);

  // The initial paint at `initialFrame` fires `onFrame`, on both
  // platforms (ADR 0006 §2) — already on the JS thread at mount, so no
  // `runOnJS` hop is needed for a value that only exists once.
  useEffect(() => {
    onFrameRef.current?.(seedFrame, wrapPhaseUI(phaseForFrameUI(seedFrame, frameCount)));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

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

  // --- transitions (ADR 0004) ----------------------------------------

  const [morph, setMorph] = useState<MorphState | null>(null);
  // A morph deferred by `transition.onLoopEnd`, waiting for the next
  // frame-index wrap — see the `useAnimatedReaction` below. Consumed by
  // `handleLoopWrap`.
  const pendingMorphStartRef = useRef<(() => void) | null>(null);

  const handleLoopWrap = useCallback(() => {
    const start = pendingMorphStartRef.current;
    if (start) {
      pendingMorphStartRef.current = null;
      start();
    }
  }, []);

  useEffect(() => {
    if (!changed) return;
    prevRef.current = snapshot;

    if (wantsMorph) {
      const from = morphFromRef.current;
      // `wantsMorph` is only ever true alongside `morphFromRef.current`
      // having just been set (either freshly, or already pinned from a
      // superseded episode) by the render-time logic above, in this same
      // render — this is unreachable, not just "shouldn't happen".
      if (from === null) throw new Error('dithered: wantsMorph without a frozen outgoing config.');
      const start = () => setMorph({ from, to: snapshot, startedAt: elapsedMsRef.value });
      if (onLoopEnd) {
        pendingMorphStartRef.current = start;
      } else {
        pendingMorphStartRef.current = null;
        start();
      }
    } else {
      // No `transition` set, or nothing to morph in front of (paused,
      // backgrounded, reduced motion, controlled progress, or externally
      // driven playback — all folded into `holding`): cut, same as
      // `update()` always has — `pictures` above already reflects it,
      // via `steadySnapshot`/`morphFromRef` above.
      pendingMorphStartRef.current = null;
      setMorph(null);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    shape,
    brightness,
    size,
    cols,
    rows,
    matrix,
    frames,
    period,
    fg,
    bg,
    gap,
    radius,
    cells,
    hitTest,
    transition,
    holding,
  ]);

  // A morph *actively* in flight completes immediately when playback
  // halts (ADR 0004 §7), rather than leaving a half-morphed frame frozen.
  // A merely *queued* morph needs no special handling here: the
  // render-time logic above has already unpinned `morphFromRef` (so
  // `pictures` already reflects the target) and cleared nothing else that
  // needs clearing — the plain repoint effect below picks it up because
  // `pictures` changed. Only an *active* morph leaves `morph` state (and
  // hence `morphActive`, and the UI-thread loop's morph branch) still
  // holding on, which is what this settles.
  useEffect(() => {
    if (!holding) return;
    pendingMorphStartRef.current = null;
    if (morph === null) return;
    setMorph(null);
    const frame = frameForRepoint(externalPhase.value, internalPhase.value, frameCount);
    currentFrame.value = frame;
    picture.value = pictures[frame];
  }, [holding, morph, pictures, frameCount, currentFrame, picture, externalPhase, internalPhase]);

  const { pictures: morphPictures } = useDitheredTransition({
    from: morph?.from ?? snapshot,
    to: morph?.to ?? snapshot,
    duration,
    startAt: morph?.startedAt ?? 0,
    reducedMotion: !morph,
  });
  const morphStartedAt = morph?.startedAt ?? 0;
  const morphActive = morph !== null && morphPictures.length > 0;

  // Ends an active morph from JS: flips `morph` back to `null` and
  // releases the picture-source pin together, so `pictures` above starts
  // tracking the live props again on the very next render.
  const finishMorph = useCallback(() => {
    morphFromRef.current = null;
    setMorph(null);
  }, []);

  // Re-point at the new steady recordings whenever they're rebuilt — so an
  // option change is visible even while playback is halted. Guarded only
  // on `morph`: while one is *actively* playing, the UI-thread loop's
  // morph branch owns `picture.value` and this must not race it; a merely
  // *queued* morph has no such owner (`pictures` itself stays pinned to
  // the outgoing config for as long as `morphFromRef` holds it — see its
  // own comment — so there is nothing here to repaint prematurely).
  // Re-derives the frame from whichever of `externalPhase`/`internalPhase`
  // is currently driving (finding 2): `wrapFrame(currentFrame.value,
  // frameCount)` — the old frame index modulo the new count — disagrees
  // with the web driver (which re-points from the preserved *phase*, not
  // the frame index) whenever `frames` changes.
  useEffect(() => {
    if (morph) return;
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
  }, [
    pictures,
    frameCount,
    currentFrame,
    picture,
    externalPhase,
    internalPhase,
    onFrameRef,
    morph,
  ]);

  // Detects the steady loop wrapping back to phase 0 — the same "frame
  // index decreased" signal the core (web) renderer's `finishLoop` uses —
  // to release a morph that `transition.onLoopEnd` deferred.
  useAnimatedReaction(
    () => currentFrame.value,
    (curr, prev) => {
      if (prev !== null && curr < prev) runOnJS(handleLoopWrap)();
    },
    [handleLoopWrap],
  );

  // Internal clock: a phase accumulator identical in shape to the web
  // driver's. `dt` comes from differencing `info.timestamp` against
  // `lastTimestamp` (finding 4), reset to `null` whenever the clock is
  // deactivated below — the native equivalent of the web driver
  // resetting `lastNow` on `halt()` — so the first tick after every
  // (re)activation always sees `dt = 0` rather than a jump. Memoized
  // with `useCallback` on top of that (ADR 0006 §6): belt and braces,
  // since an unmemoized worklet would otherwise churn the frame-callback
  // registration on every unrelated parent render.
  //
  // A morph in flight (ADR 0004) takes over the picture swap first —
  // stepped by elapsed wall-clock time against `duration`, the same way
  // the web driver's `paintTransitionFrame` does — before handing back
  // to the phase accumulator once it's exhausted.
  const loop = useFrameCallback(
    useCallback(
      (info) => {
        'worklet';
        // Reanimated resets `info.timeSinceFirstFrame` to 0 whenever this
        // callback is deactivated and reactivated (`loop.setActive(false)`
        // then `(true)` — which happens whenever `holding` toggles, and can
        // toggle in the very same commit that also starts a new morph,
        // since `holding` is computed from this render's props). A morph's
        // `startedAt` is compared against this clock, so a raw reset would
        // make `elapsed` go negative (`morphPictures[step]` reads
        // `undefined` — a blank canvas for the rest of the window; finding
        // 2). Folding every observed decrease into a running offset keeps
        // a *virtual* version of this clock monotonic across any number of
        // deactivate/reactivate cycles, without assuming anything about
        // how Reanimated implements the reset beyond "it never goes below
        // 0". The steady branch below is unaffected — it differences
        // `info.timestamp`, a separate field Reanimated does not reset.
        const raw = info.timeSinceFirstFrame;
        if (raw < lastRawTimeRef.value) {
          clockOffsetRef.value += lastRawTimeRef.value;
        }
        lastRawTimeRef.value = raw;
        const virtualNow = clockOffsetRef.value + raw;

        // Kept current every tick, morphing or not, so a JS-thread read
        // when the *next* morph starts reflects where the loop actually
        // is (finding 4 — see `MorphState`).
        elapsedMsRef.value = virtualNow;

        if (morphActive) {
          const elapsed = virtualNow - morphStartedAt;
          // Clamped at *both* ends (finding 2) — not just the top, as
          // before. The clock-restart handling above already keeps
          // `elapsed` from going meaningfully negative, but clamping here
          // is cheap and removes any remaining assumption that
          // `virtualNow >= morphStartedAt` holds for literally every tick
          // ordering.
          const t = Math.max(0, Math.min(1, elapsed / duration));
          const steps = morphPictures.length;
          // Recorded at `p = i / (steps - 1)` (see `useDitheredTransition`),
          // so the nearest recorded step is `round(t * (steps - 1))`, not
          // `floor(t * steps)` — the latter uses a different denominator
          // than the recording and runs ahead of web's continuous `p = t`
          // by up to one step, freezing on the finished target for the
          // final fraction of the morph (finding 8).
          const step = Math.min(steps - 1, Math.round(t * (steps - 1)));
          if (step !== morphStep.value || picture.value !== morphPictures[step]) {
            morphStep.value = step;
            picture.value = morphPictures[step];
          }
          if (t >= 1) {
            // Hand off using the morph's own final recording — baked
            // exactly at p = 1, i.e. the target's cells at the target's
            // own phase (see `useDitheredTransition`) — rather than
            // reaching into `pictures`, which stays pinned to the
            // *outgoing* config for as long as this morph owns the canvas
            // (see `morphFromRef` above) and would hand off to the wrong
            // shape (finding 1).
            //
            // The internal phase accumulator itself is left exactly where
            // it was frozen when the morph began — mirroring the web
            // renderer's `finishTransitionNow`, which resets `lastNow`
            // rather than trying to reconstruct where a continuously-
            // running clock would have ended up. `dt` on the very next
            // steady tick is measured against `null`, so it reads `0`
            // instead of jumping forward by however long the morph took.
            // The repoint effect picks up the correct frame for the
            // *new* frame count once `finishMorph` below causes `pictures`
            // to catch up to the target, on the next render.
            lastTimestamp.value = null;
            picture.value = morphPictures[steps - 1];
            runOnJS(finishMorph)();
          }
          return;
        }

        const dt = lastTimestamp.value === null ? 0 : info.timestamp - lastTimestamp.value;
        lastTimestamp.value = info.timestamp;
        const loopsBefore = loopsAtUI(internalPhase.value);
        internalPhase.value = advancePhaseUI(internalPhase.value, dt, period, speed);
        const loopsAfter = loopsAtUI(internalPhase.value);
        if (loopsAfter !== loopsBefore && hasOnLoop) runOnJS(notifyLoop)(loopsAfter);
        applyPhase(internalPhase.value);
      },
      [
        morphActive,
        morphStartedAt,
        duration,
        morphPictures,
        morphStep,
        picture,
        elapsedMsRef,
        lastRawTimeRef,
        clockOffsetRef,
        lastTimestamp,
        internalPhase,
        period,
        speed,
        hasOnLoop,
        notifyLoop,
        applyPhase,
        finishMorph,
      ],
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
