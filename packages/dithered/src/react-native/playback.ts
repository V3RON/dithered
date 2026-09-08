/**
 * `'worklet'`-directed copies of `core/clock.ts`'s phase-accumulator
 * helpers, so `native/Dithered.tsx`'s frame callback, `useAnimatedReaction`
 * and picture swap can run entirely on the UI thread — plus a couple of
 * small helpers (`frameForRepoint`, `isExternallyDriven`) that pull
 * decision logic *out* of the component so it is unit-testable: this
 * package has no React Native test renderer, so anything left inline in
 * `Dithered.tsx` is only checked by inspection.
 *
 * A worklet can only call another worklet (or a function the Reanimated
 * babel plugin has processed) — not an arbitrary imported function — so
 * these bodies are deliberately duplicated rather than re-exported from
 * `core/clock.ts`, which stays free of any dependency on that babel
 * plugin having run. `playback.test.ts` pins the two copies to identical
 * behaviour with a parity sweep, so the duplication can't drift
 * silently. Under Vitest the `'worklet'` directive is an inert string
 * literal statement, so these are plain, directly testable functions
 * there — there is no React Native test renderer in this package to
 * exercise them any other way.
 */

/** Wraps a phase in loop units into `[0, 1)`, guarding negative input. */
export function wrapPhaseUI(phase: number): number {
  'worklet';
  const w = phase - Math.floor(phase);
  return w < 1 ? w : 0;
}

/** `phase + (dt / period) * speed` — the entire accumulator step. */
export function advancePhaseUI(phase: number, dtMs: number, period: number, speed: number): number {
  'worklet';
  const next = phase + (dtMs / period) * speed;
  return Number.isFinite(next) ? next : phase;
}

/**
 * Frame index in `[0, frames)` for a phase in loop units. Clamped to
 * `frames - 1` after the multiply, since an out-of-range index reads
 * `undefined` out of the recorded-picture array.
 *
 * Total, mirroring `core/clock.ts`'s `frameForPhase`: a non-finite
 * `phase` or a `frames <= 0` returns `0` rather than `undefined` handed
 * to Skia's `drawPicture`. See ADR 0006 §1.
 */
export function frameForPhaseUI(phase: number, frames: number): number {
  'worklet';
  if (!Number.isFinite(phase) || !(frames > 0)) return 0;
  const p = wrapPhaseUI(phase);
  return Math.min(frames - 1, Math.floor(p * frames));
}

/** Signed cumulative loop count for a phase — how many times it has wrapped. */
export function loopsAtUI(phase: number): number {
  'worklet';
  return Math.floor(phase);
}

/**
 * The phase that {@link frameForPhaseUI} maps back to exactly `frame` —
 * the centre of the frame's phase band. See `core/clock.ts`'s
 * `phaseForFrame` for why a bare `frame / frames` is wrong.
 */
export function phaseForFrameUI(frame: number, frames: number): number {
  'worklet';
  return (frame + 0.5) / frames;
}

/**
 * Decides what `Dithered.tsx`'s `applyPhase` worklet should do for a
 * given `phase`: the frame index to paint, or `null` if nothing should
 * happen at all — because `phase` is non-finite (ADR 0006 §3, finding
 * 1: the displayed frame holds and `onFrame` does not fire, exactly as
 * a transient `NaN` — e.g. a scroll ratio read before layout — deserves)
 * or because it maps to the frame already showing (no repaint, no
 * duplicate `onFrame`).
 *
 * Pulled out of the `applyPhase` worklet — which also has to perform the
 * shared-value writes and the `runOnJS` hop — so the *decision* itself
 * is unit-testable without a React Native renderer.
 */
export function resolveAppliedFrame(
  phase: number,
  frames: number,
  currentFrame: number,
): number | null {
  'worklet';
  if (!Number.isFinite(phase)) return null;
  const frame = frameForPhaseUI(phase, frames);
  return frame !== currentFrame ? frame : null;
}

/**
 * The frame recordings are re-pointed to whenever they are rebuilt (a
 * `shape`/`brightness`/`frames`/... change): reads whichever of
 * `externalPhase`/`internalPhase` is currently driving playback and runs
 * it back through {@link frameForPhaseUI}, so a structural change
 * answers "what does this phase mean at the new frame count?" the same
 * way the web driver does.
 *
 * `wrapFrame(currentFrame, frameCount)` — re-pointing from the *old
 * frame index* modulo the new count — is the bug this replaces (finding
 * 2): it disagrees with the web driver (which re-points from the
 * preserved *phase*, not the frame index) whenever `frames` changes, and
 * freezes on the wrong frame indefinitely while nothing else is driving
 * playback (e.g. `paused`). See ADR 0006 §6.
 *
 * Exported as a pure function (rather than left inline in the
 * component's re-point effect) so it is directly unit-testable: this
 * package has no React Native test renderer to exercise the effect
 * itself.
 */
export function frameForRepoint(
  externalPhase: number | null,
  internalPhase: number,
  frames: number,
): number {
  'worklet';
  return frameForPhaseUI(externalPhase ?? internalPhase, frames);
}

/**
 * Whether playback is currently being driven externally, from the
 * `time`/`progress` props as the component receives them. `time ===
 * null` is treated the same as `time === undefined` — *not* driven —
 * because no write path ever claims it: `typeof null === 'number'` is
 * false and a `SharedValue` duck-type check requires `value !== null`,
 * so a `null` `time` reaches neither write path and the component would
 * otherwise freeze on whatever frame was current, forever, with nothing
 * to hand control back (finding 6). A caller writing
 * `time={sharedValue ?? null}` before the shared value exists is exactly
 * this case, and it must behave like "not externally driven" — matching
 * `dithered/react`, where the same `null` already falls through a
 * `typeof time === 'number'` check to the same effect.
 *
 * Exported as a pure function for the same reason as
 * {@link frameForRepoint}: directly testable without a React Native
 * renderer.
 */
export function isExternallyDriven(
  time: number | { value: number } | null | undefined,
  progress: number | undefined,
): boolean {
  return (time !== undefined && time !== null) || progress !== undefined;
}
