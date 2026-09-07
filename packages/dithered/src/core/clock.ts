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

/**
 * Wraps a phase in loop units into `[0, 1)`, guarding negative input.
 *
 * `phase - Math.floor(phase)` rather than the more obvious
 * `((phase % 1) + 1) % 1`: the latter is not the identity on `[0, 1)`,
 * because adding 1 to a fraction below 1 costs a mantissa bit and the
 * second `% 1` cannot give it back. That perturbation is small but
 * visible at the API surface — `setTime(0.35)` would report
 * `onFrame(_, 0.35000000000000009)`, so a caller could not round-trip
 * the value they set, and `setTime(0.3)` with `frames: 10` would land on
 * frame 3 where `Math.floor(0.3 * 10)` is 2. Subtracting the floor is
 * exact on `[0, 1)` and agrees with the modulo form everywhere else.
 *
 * Total, like {@link frameForPhase}: a non-finite `phase` returns `0`.
 * The `w < 1` guard also catches the one case where the subtraction
 * lands *on* 1 — a phase a hair below zero (`-1e-18 - -1` rounds to
 * exactly `1`), which would otherwise escape the half-open range this
 * function exists to guarantee.
 */
export function wrapPhase(phase: number): number {
  const w = phase - Math.floor(phase);
  return w < 1 ? w : 0;
}

/**
 * `phase + (dt / period) * speed` — the entire accumulator step.
 *
 * A step that would not be finite leaves `phase` untouched. `setTime` is
 * not the only way a bad number reaches the accumulator: `speed={a / b}`
 * with `b === 0`, `period={0}`, or a `Number('')`-style parse all reach
 * here, and because nothing but `setTime` ever *resets* `phase`, a
 * single `NaN` step would poison playback permanently — the frame frozen
 * (`frameForPhase` floors a non-finite phase to 0) while
 * `loopsAt(NaN) !== loopsAt(NaN)` fires `onLoop(NaN)` on every tick
 * forever, since `NaN !== NaN`. Not even `update({ speed: 1 })` would
 * recover it. Refusing the step keeps the accumulator in a state a later
 * good value can still drive.
 */
export function advancePhase(phase: number, dtMs: number, period: number, speed: number): number {
  const next = phase + (dtMs / period) * speed;
  return Number.isFinite(next) ? next : phase;
}

/**
 * Frame index in `[0, frames)` for a phase in loop units. Clamped to
 * `frames - 1` after the multiply: `wrapPhase` can return a value close
 * enough to 1 that `p * frames` rounds up to `frames` in floating point,
 * and an out-of-range index reads `undefined` out of the native picture
 * array.
 *
 * Total: a non-finite `phase` (`NaN`, `Infinity`, `-Infinity`) and any
 * `frames <= 0` return `0` rather than propagating. `Math.min(frames - 1,
 * NaN)` is `NaN`, so the clamp above guards the float edge but not the
 * input — without this, `NaN` reaches straight through to
 * `pictures[NaN]` (`undefined`, handed to Skia's `drawPicture` on
 * native) or a `drawImage` with non-finite args (a blank canvas, on
 * web). This is the floor, not the whole story: the *drivers* that carry
 * external time (`setTime`, the `time` prop, native's `applyPhase`)
 * ignore a non-finite `t` outright rather than relying on this to fall
 * back to frame `0` — see ADR 0006 §3. This totality is the backstop for
 * anything that slips past that.
 */
export function frameForPhase(phase: number, frames: number): number {
  if (!Number.isFinite(phase) || !(frames > 0)) return 0;
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
 * n, n)` returns `k - 1` whenever `k / n` rounds down in binary — 4560
 * `(n, k)` pairs across 396 of the frame counts in `1..512`, e.g.
 * `n = 49, k = 1` and `n = 22, k = 15`. Note that the common, round
 * frame counts (24, 36, 48, 60, 64, 120) are *not* among them now that
 * `wrapPhase` is exact, so a bare division looks fine until someone
 * picks an awkward number. Anything
 * that starts from a frame *index* and needs a phase — seeding
 * `initialFrame`, mapping `progress` — must go through this, never a
 * bare division. See ADR 0006 §1 and §8.
 */
export function phaseForFrame(frame: number, frames: number): number {
  return (frame + 0.5) / frames;
}

/**
 * Wraps a (possibly out-of-range, possibly non-integer) frame index into
 * `[0, frames)`. Used to normalize `initialFrame` *before* it is
 * converted to a phase by {@link phaseForFrame} — seeding it unwrapped
 * makes `loopsAt` start somewhere other than `0` for an out-of-range
 * `initialFrame` (e.g. `-1`), which disagrees with a driver that wraps
 * first. See ADR 0006 §6.
 */
export function wrapFrame(frame: number, frames: number): number {
  // Total for the same reason `frameForPhase` is: `initialFrame` is a
  // caller-supplied number, and `Math.round(Infinity) % n` is `NaN`,
  // which would seed the accumulator with a phase nothing can recover.
  if (!Number.isFinite(frame) || !(frames > 0)) return 0;
  return ((Math.round(frame) % frames) + frames) % frames;
}
