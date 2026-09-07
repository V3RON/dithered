/**
 * `'worklet'`-directed copies of `core/clock.ts`'s phase-accumulator
 * helpers, so `native/Dithered.tsx`'s frame callback, `useAnimatedReaction`
 * and picture swap can run entirely on the UI thread.
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
  return ((phase % 1) + 1) % 1;
}

/** `phase + (dt / period) * speed` — the entire accumulator step. */
export function advancePhaseUI(phase: number, dtMs: number, period: number, speed: number): number {
  'worklet';
  return phase + (dtMs / period) * speed;
}

/**
 * Frame index in `[0, frames)` for a phase in loop units. Clamped to
 * `frames - 1` after the multiply, since an out-of-range index reads
 * `undefined` out of the recorded-picture array.
 */
export function frameForPhaseUI(phase: number, frames: number): number {
  'worklet';
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
