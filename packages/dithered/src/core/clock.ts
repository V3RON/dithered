/**
 * Playback state as a single number, `phase`, in loop units: `1.0` is one
 * full loop. This is the whole of the playback design (see ADR 0006):
 * `speed` scales the increment rather than the accumulated value, so a
 * change in `speed` is continuous by construction; direction falls out
 * of a negative `speed` decrementing `phase`; `onLoop` falls out of a
 * signed loop counter; and `setTime` falls out of assigning `phase`
 * directly. `frameAt` (in `paint.ts`) is a distinct, wall-clock-only
 * convenience built on {@link frameForPhase} — it is not the playback
 * path these helpers serve.
 *
 * Kept free of anything DOM- or Reanimated-specific so both the web
 * driver and `native/playback.ts`'s `'worklet'` copies can build on the
 * same arithmetic.
 */

/** Wraps a phase in loop units into `[0, 1)`, guarding negative input. */
export function wrapPhase(phase: number): number {
  return ((phase % 1) + 1) % 1;
}

/** `phase + (dt / period) * speed` — the entire accumulator step. */
export function advancePhase(phase: number, dtMs: number, period: number, speed: number): number {
  return phase + (dtMs / period) * speed;
}

/**
 * Frame index in `[0, frames)` for a phase in loop units. Clamped to
 * `frames - 1` after the multiply: `wrapPhase` can return a value close
 * enough to 1 that `p * frames` rounds up to `frames` in floating point,
 * and an out-of-range index reads `undefined` out of the native picture
 * array.
 */
export function frameForPhase(phase: number, frames: number): number {
  const p = wrapPhase(phase);
  return Math.min(frames - 1, Math.floor(p * frames));
}

/** Signed cumulative loop count for a phase — how many times it has wrapped. */
export function loopsAt(phase: number): number {
  return Math.floor(phase);
}

/**
 * The phase that {@link frameForPhase} maps back to exactly `frame` —
 * the centre of the frame's phase band, not its leading edge.
 *
 * `frame / frames` does not survive the round trip: `frameForPhase(k /
 * n, n)` returns `k - 1` whenever `k / n` rounds down in binary, which
 * at the default `frames = 48` is 16 of the 48 valid indices. Anything
 * that starts from a frame *index* and needs a phase — seeding
 * `initialFrame`, mapping `progress` — must go through this, never a
 * bare division. See ADR 0006 §1 and §8.
 */
export function phaseForFrame(frame: number, frames: number): number {
  return (frame + 0.5) / frames;
}
