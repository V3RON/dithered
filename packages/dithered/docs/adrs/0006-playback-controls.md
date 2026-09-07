# 0006 — External clock and playback controls

## Status

Proposed

## Context

Issue #6 asks for playback to become an input rather than an internal
detail. Today both drivers derive the displayed frame from a wall clock
they own:

- web (`src/renderer.ts`) calls `frameAt(now, period, frames)` inside a
  `requestAnimationFrame` tick, where `now` is the raw RAF timestamp;
- native (`src/native/Dithered.tsx`) inlines the same arithmetic inside a
  Reanimated `useFrameCallback`, using `info.timeSinceFirstFrame`.

`frameAt` is a pure function of absolute time. That is what makes the
four requested features impossible:

1. **Lockstep.** Two instances share the clock but not the origin — web
   uses the document timeline (so they actually agree), native uses a
   per-callback origin (so they do not). Neither can be aligned by the
   caller.
2. **Scrubbing.** There is no way to say "show me phase 0.42". `progress`
   comes close but is defined in frame indices, pauses the instance, and
   goes through `renderFrame`, which is a paint primitive rather than a
   clock input.
3. **`speed` / direction.** Scaling the argument (`frameAt(now * speed, …)`)
   is the obvious move and is wrong: changing `speed` at runtime moves
   the product `now * speed` discontinuously, so the animation jumps.
   With `now` in the millions of milliseconds, even a small change in
   `speed` jumps by many loops.
4. **`onLoop`.** A stateless frame function has no notion of "the loop
   wrapped"; it only ever reports where the hands are, never that they
   passed twelve.

There is a fifth constraint the PRD only hints at. On native the whole
point of #3 is that playback never touches the JS thread: pictures are
pre-recorded and the frame callback swaps `picture.value` on the UI
thread. An externally driven clock must preserve that — a `SharedValue`
driven by a gesture or a scroll handler has to be readable from the same
UI-thread context, and `onFrame` has to be the _only_ thing that crosses
back to JS.

Issue #4 (transitions) adds `finishLoop()` on top of the same machinery
and is being implemented in parallel; this ADR must leave the loop-count
state reachable but does not implement `finishLoop`.

## Decision

### 1. A phase accumulator replaces the wall clock; `frameAt` stays

Playback state becomes a single number, `phase`, in **loop units**: 1.0
is one full loop. Each tick advances it by the elapsed fraction of a
period, scaled by `speed`:

```
phase += (dt / period) * speed
```

The displayed frame is `floor(wrap(phase) * frames)`.

This is the whole design. `speed` falls out (it scales the increment,
not the accumulated value, so changing it mid-loop is continuous by
construction — no jump, ever), direction falls out (negative `speed`
decrements), `onLoop` falls out (`floor(phase)` is a signed loop
counter), and `setTime` falls out (assign `phase` directly).

New pure helpers live in a new `src/core/clock.ts`, exported from
`src/core`:

```ts
/** Wraps a phase in loop units into [0, 1). */
function wrapPhase(phase: number): number;
/** phase + (dt / period) * speed. */
function advancePhase(phase: number, dtMs: number, period: number, speed: number): number;
/** Frame index in [0, frames) for a phase in loop units. */
function frameForPhase(phase: number, frames: number): number;
/** Signed cumulative loop count for a phase. */
function loopsAt(phase: number): number;
/** The phase that `frameForPhase` maps back to exactly this frame. */
function phaseForFrame(frame: number, frames: number): number;
```

`wrapPhase` is `((p % 1) + 1) % 1`, guarding negative input.
`frameForPhase` clamps to `frames - 1` after the multiply: `wrapPhase`
can return a value close enough to 1 that `p * frames` rounds up to
`frames` in floating point, and an out-of-range index reads `undefined`
out of the native picture array. `loopsAt` is `Math.floor(phase)`.

`phaseForFrame` is `(frame + 0.5) / frames` — **the centre of the
frame's phase band, not its leading edge** — and it exists because
`frame / frames` does not survive the round trip. `frameForPhase(k / n, n)`
returns `k - 1` whenever `k / n` rounds down in binary: at the default
`frames = 48` that is 16 of the 48 valid indices (1, 4, 7, 10, …, 47).
Anything that starts from a frame _index_ and needs a phase — seeding
`initialFrame`, and mapping `progress` (§8) — must go through
`phaseForFrame`, never through a bare division. The half-frame offset it
introduces is invisible: it shifts a free-running loop's frame
boundaries by half a frame against nothing the caller can observe, and
`setTime` (the one API where an exact phase is meaningful) does not use
it.

**`frameAt(nowMs, period, frames)` is kept, unchanged and still
exported.** It is public API on both entry points and is covered by
existing tests; removing it is a breaking change that buys nothing. It
is re-expressed as `frameForPhase(nowMs / period, frames)`, gains a doc
note that it is a wall-clock convenience and no longer the playback
path, and keeps its current behaviour exactly (verified by the existing
tests, which are not modified).

### 2. `speed`, `onFrame`, `onLoop` on the core options

```ts
interface DitheredOptions {
  /** Playback rate multiplier. Default 1. Negative values play backwards. */
  speed?: number;
  /** Called after a frame is painted, with the frame index and loop phase in [0, 1). */
  onFrame?: (frame: number, t: number) => void;
  /** Called each time the loop wraps, with the signed cumulative loop count. */
  onLoop?: (loops: number) => void;
}
```

`ResolvedOptions` is currently `Required<DitheredOptions>`, which would
force the two callbacks to exist. Rather than default them to no-ops
(making "was a callback passed?" an identity comparison against a
sentinel), the alias becomes:

```ts
type DitheredCallbacks = 'onFrame' | 'onLoop';
type ResolvedOptions = Required<Omit<DitheredOptions, DitheredCallbacks>> &
  Pick<DitheredOptions, DitheredCallbacks>;
```

`speed` defaults to `1` in `DEFAULTS`. Callbacks have no default and
stay optional through resolution. `assignDefined`'s existing rule
applies to them unchanged: passing `undefined` in an `update()` patch
leaves the current value in place, it does not clear it. That is
consistent with every other option and is what the wrappers want anyway
(see §5).

Semantics fixed here:

- **`onFrame` fires only when the painted frame index changes.** The
  drivers already skip redraws for repeated frames; the callback is
  emitted from the same place that decides to paint, so a frame that is
  skipped as a repeat cannot fire it. A forced repaint at the _same_
  index (what `update()` does after a reconfigure) is silent. The
  initial paint at `initialFrame` does fire — **on both platforms**;
  native emits it from a mount effect, already on the JS thread, rather
  than through `runOnJS`.
- **`onFrame`'s `t` is `wrapPhase(phase)`**, not `frame / frames` — the
  caller gets the true sub-frame phase, which is what a scroll- or
  gesture-driven consumer wants. It is in `[0, 1)`.
- **`onLoop` fires only for the internal clock.** It compares
  `loopsAt(phase)` before and after an _advance_ and fires once, with
  the new count, when it changed. `setTime` assigns an absolute phase:
  a jump is not a wrap, so it never fires `onLoop`.
- **`onLoop` is coalesced, not repeated.** If one tick crosses several
  boundaries (a backgrounded tab, a debugger pause, `speed = 1000`), it
  fires once with the final count rather than once per boundary. An
  unbounded callback storm after a stall is worse than a skipped count,
  and the count itself is not lost — it is the argument.
- Negative `speed` decrements the count: wrapping backwards past 0
  reports `-1`, then `-2`. `onLoop` is a signed cumulative counter, not
  a "times completed" counter.
- `dt` is **not** clamped. Clamping would silently desynchronise an
  instance from a `time`-driven sibling; coalescing `onLoop` already
  removes the only unbounded cost of a large `dt`.

### 3. `setTime` on the instance, and giving the clock back

```ts
interface DitheredInstance {
  /** Drive playback externally. Halts the internal clock. `t` is in loop units. */
  setTime(t: number): void;
  /** Hand playback back to the internal clock, resuming from the current phase. */
  clearTime(): void;
}
```

`setTime(t)` sets `phase = t`, paints `frameForPhase(t, frames)` if that
differs from what is displayed, and halts the RAF loop / frame callback.
It is idempotent and cheap: repeated calls with values inside the same
frame do nothing but store the phase.

`clearTime()` is an addition beyond the PRD. Without it, a `time` prop
that goes from a number back to `undefined` (a scrub that ends, a
conditional driver) can never restart the loop, because `setTime` is
one-way. It resumes from wherever the external driver left the phase, so
handing control back is continuous rather than a snap back to the old
internal phase.

The externally-driven state is _separate from_ `paused`. An instance can
be externally driven and unpaused; `paused` still means "the internal
clock does not run", and while a `time` source is attached the internal
clock does not run regardless. Restoring via `clearTime()` re-applies
`paused`.

### 4. `update()` stops rebuilding the world

The acceptance criterion "sprite cache and pictures are unaffected: only
the frame selection changes" is not satisfiable today. `update()`
unconditionally calls `configure()`, which re-samples cells and
re-renders the entire sprite strip — so `update({ speed: 2 })` would
rebuild `frames` canvases.

`update()` is split by whether the patch touches a **structural** key —
one that changes _what_ is drawn:

```
shape, brightness, size, cols, rows, frames, fg, bg, gap, radius, cache
```

Only those trigger `configure()`. Everything else (`period`, `speed`,
`paused`, `respectReducedMotion`, `initialFrame`, `onFrame`, `onLoop`)
updates the resolved options and the loop state in place. Structural
keys are compared by value (identity, for `shape`/`brightness`) against
the current resolved options, so a patch that re-passes the same values
is also a no-op — which is what the React wrapper does on every render.

On the native side `useDitheredPictures`'s memo deps are already exactly
the structural set, so nothing changes there.

When `frames` _does_ change structurally, `phase` is preserved (it is in
loop units, not frames) and the newly-selected frame index follows from
it. This is strictly better than the current `currentFrame % opts.frames`.

### 5. `time` on the wrappers

**`dithered/react`** gains `time?: number`, `speed?: number`,
`onFrame?`, `onLoop?`.

`time` is applied in its own effect: `setTime(time)` when it is a
number, `clearTime()` when it transitions back to `undefined`. It is
deliberately _not_ in the reconfigure effect's dependency list — a
scrub at 60 Hz must not touch `configure()`.

`onFrame` and `onLoop` are **not** passed through `update()` and are not
effect dependencies. An inline arrow callback — the overwhelmingly
common case — has a fresh identity every render, and routing it through
the options would either reconfigure on every render or need the caller
to memoize. Instead the wrapper keeps a latest-value ref and hands the
core a _stable trampoline_ once, at mount:

```tsx
const onFrameRef = useRef(onFrame);
onFrameRef.current = onFrame;           // assigned during render
// …passed to createDithered once:
onFrame: (f, t) => onFrameRef.current?.(f, t),
```

Assigning during render (rather than in an effect) is safe here because
the ref is only ever _read_ from an effect or a RAF callback, never
during render, and it means the mount-time paint at `initialFrame`
already sees the caller's callback. A `useLayoutEffect` would also work
but warns under SSR, which this component otherwise survives.

**`dithered/native`** gains the same, with `time?: number | SharedValue<number>`.

`SharedValue` is detected by duck-typing (`typeof v === 'object' && v !== null
&& 'value' in v`) rather than Reanimated's `isSharedValue`, which would
raise the peer floor for no benefit.

### 6. Reading `time` on the UI thread (native)

The component keeps one internal `useSharedValue<number | null>(null)`,
`externalPhase`, and one write path into it per source kind:

- a **number** `time` is written from an ordinary effect (the value only
  changes on a JS render anyway, so there is nothing to save);
- a **`SharedValue`** `time` is mirrored by `useAnimatedReaction`, whose
  prepare function runs on the UI thread. A gesture or scroll handler
  writing `time.value` therefore reaches `externalPhase` without a JS
  round trip;
- `time === undefined` sets `externalPhase.value = null`.

Both paths end in the same workletized `applyPhase(phase)`, which
computes the frame, and — only if it differs from `currentFrame.value` —
assigns `currentFrame.value` and `picture.value` and emits `onFrame`.
The frame callback calls the same function. One place decides what is
painted, whether the phase came from the accumulator, a number, or a
shared value.

The frame callback is deactivated whenever `externalPhase.value !== null`,
matching the PRD ("the internal loop is halted").

`dt` comes from `info.timestamp` differenced against a `lastTimestamp`
shared value the component owns, seeded `null` and reset to `null`
wherever the web driver resets `lastNow` (deactivation, external time
taking over). It deliberately does **not** use
`info.timeSincePreviousFrame`: Reanimated's Babel plugin emits a fresh
worklet object for an inline callback on every render, and
`useFrameCallback` keys its registration effect on that identity, so the
callback is torn down and re-registered _once per render_ — which resets
its internal start time and makes `timeSincePreviousFrame` report `null`
again. A component whose parent re-renders every frame (a scroll handler
in an ancestor, say) would therefore see `dt = 0` forever and freeze.
Differencing an absolute timestamp is immune to re-registration, and it
makes the native clock structurally identical to the web one — same
state, same reset points, same parity story.

The worklet identity is additionally stabilised with `useCallback` over
its real dependencies, so an unrelated parent render does not churn the
frame-callback registration at all.

The alternative — closing over the caller's `SharedValue` directly
inside the frame callback — was rejected in §Alternatives.

### 7. Worklet helpers, and web/native parity

`src/native/playback.ts` (new) holds `wrapPhaseUI`, `advancePhaseUI`,
`frameForPhaseUI`, `loopsAtUI`: literal copies of the `core/clock.ts`
bodies, each with a `'worklet'` directive. The core stays free of any
dependency on Reanimated's babel plugin (the constraint #3 established
and documented in the existing inline-worklet comment), while the native
driver still gets shareable, _unit-testable_ functions instead of
arithmetic buried in a closure.

The duplication is deliberate and is pinned by a test: a parity suite
sweeps a range of phases, `dt`s, periods, speeds and frame counts and
asserts the two implementations agree exactly. Under Vitest the
`'worklet'` directive is an inert string-literal statement, so the UI
copies are plain functions and are testable directly.

Putting the native driver's math in a module also makes the component
itself thin enough to review: everything with an edge case in it
(wraparound, clamping, loop counting) is tested without a React Native
renderer, which the package does not have.

### 8. `progress` becomes sugar over `setTime`

Per the PRD, on both wrappers, `progress` selects a frame and pins the
instance there with playback paused. The PRD writes that as
`setTime(progress * (frames - 1) / frames)`. Taken literally that is
wrong, because the product is quantized straight back by
`frameForPhase` and the round trip loses a bit:
`(1 × 47) / 48 × 48 = 46.99999999999999`, so `progress = 1` at the
default frame count lands on frame **46** rather than 47 — and 83 of the
first 512 frame counts, 48 among them, are affected. `frames = 36,
progress = 0.2` is off by two frames.

So the frame index is computed once, explicitly, and _then_ turned into
a phase that quantizes back to it exactly:

```
frame → Math.floor(clamp01(progress) * (frames - 1))
setTime(phaseForFrame(frame, frames))   // and pause
```

This is the PRD's mapping, made exact rather than approximated through a
float product. It remains a **small, intentional behaviour change**
against the old code: `progress` previously selected
`Math.round(p * (frames - 1))` and now selects
`Math.floor(p * (frames - 1))`, so `progress = 0.5` with `frames = 48`
moves from frame 24 to frame 23. The endpoints really are unchanged
(`0 → 0`, `1 → frames - 1`) — that is now a property of the code rather
than an aspiration — and flooring is what free-running playback does, so
the two agree instead of being off by half a frame. The `frames = 1`
degenerate case maps every `progress` to frame 0, as before.

`initialFrame` is seeded the same way (`phase = phaseForFrame(initialFrame,
frames)`) on both platforms, for the same reason: a bare
`initialFrame / frames` paints frame `initialFrame - 1` for a third of
its valid values, and on native it also disagrees with the exact
`currentFrame` seed, making the indicator step backwards one frame on
the first tick after mount.

`progress` and `time` are both external drivers; if both are passed,
**`time` wins** and `progress` is ignored (with a doc note). Mixing them
is a caller bug, and silently letting the effect that happens to run
last win would be worse.

## Alternatives considered

**Keep `frameAt` as the playback path and scale its input.**
`frameAt(now * speed, …)`. Rejected: `speed` cannot change at runtime
without a discontinuity, negative `speed` needs the modulo guard anyway,
and there is still no loop counter. This is the option the PRD's design
note is arguing against, and the argument holds.

**Track an epoch offset instead of accumulating.** Store `t0` and
compute `phase = (now - t0) * speed / period`; on a `speed` change,
rewrite `t0` so the phase is preserved. Mathematically equivalent to the
accumulator and avoids float drift over long runs. Rejected because it
inverts badly: `setTime` has to solve for `t0`, `paused` has to freeze
and rebase it, and the native side has no stable `now` across
`setActive` cycles (`timeSinceFirstFrame` resets), so it would need a
second offset for that. The accumulator's drift is a double's 52-bit
mantissa against a value that grows by ~1 per period — irrelevant at any
realistic runtime, and `setTime` resets it outright.

**Default `onFrame`/`onLoop` to no-op functions** so `ResolvedOptions`
stays `Required<…>`. Rejected: it makes "is a callback attached?" an
identity check against a module-level sentinel, and on native it costs a
`runOnJS` hop per frame for callers who passed nothing — which is
precisely the cost #3 was built to avoid. The narrowed type is three
lines.

**Pass `onFrame` through `update()` like any other option.** Rejected:
an inline callback changes identity every render, so this either
reconfigures the instance 60 times a second or pushes memoization onto
every caller. The latest-ref trampoline is the standard fix and keeps
the core's options object honest — it receives one stable function.

**Close over the caller's `SharedValue` inside the frame callback**
(`time.value` read directly). Rejected: the worklet captures `time` from
the render that registered it, so a caller swapping in a _different_
shared value — or switching between a number and a shared value —
silently keeps reading the old one, and the capture has to be rebuilt on
every render to be safe. Mirroring through one internal shared value
gives a single stable capture and one place where "what is the current
external phase?" is answered, at the cost of one UI-thread assignment
per change. It also makes "no external time" representable (`null`)
without a second captured flag.

**Emit `onFrame` from a `useAnimatedReaction` on `currentFrame`** rather
than `runOnJS` at the swap site. Rejected: the reaction would also fire
for frames set by `setTime`/`progress` — which is fine — but it batches
and can coalesce two changes within a frame, so "at most once per
painted frame" becomes "at most once per painted frame, sometimes
fewer". Calling `runOnJS` at the swap site is exact.

**Make `setTime` accept `number | null`** instead of adding
`clearTime()`. Rejected: it contradicts the PRD's published signature
and reads worse at the call site (`setTime(null)` looks like a reset to
zero, not a release of control).

## Consequences

**Good**

- `speed` is continuous across changes by construction, at any point in
  the loop, in either direction, with no special-casing.
- Both drivers reduce to "compute a phase, call `applyPhase`". The
  native picture swap, the web blit, external time and the internal
  clock all flow through one decision point per platform.
- Native external time stays on the UI thread end to end: a gesture
  handler writing a `SharedValue` reaches the picture swap without
  waking JS.
- `update({ speed })`, `update({ period })` and `update({ paused })`
  stop rebuilding the sprite strip — a latent performance bug fixed as a
  side effect of the acceptance criterion.
- Two instances handed the same `time` are frame-identical, because the
  frame is now a pure function of phase with no hidden origin.
- `loopsAt(phase)` gives #4's `finishLoop()` the state it needs without
  either issue's code touching the other's.

**Costs and risks**

- `progress` shifts by up to one frame (round → floor). Documented in
  the README and the prop's doc comment.
- The phase math exists twice, in `core/clock.ts` and
  `native/playback.ts`. Mitigated by the parity test, but it is a place
  where a future edit can drift.
- `ResolvedOptions` is no longer literally `Required<DitheredOptions>`.
  Anyone who was constructing one by hand now needs two fewer keys, not
  more, so this is not breaking in practice.
- `onFrame` on native costs a `runOnJS` per _changed_ frame when it is
  attached. Documented as "not for per-frame work", per the PRD.
- Two frame-index-to-phase conversions (`initialFrame`, `progress`) now
  go through `phaseForFrame`'s half-frame offset rather than a bare
  division. That is the correct conversion, but it is a rule a future
  edit can forget: a bare `k / frames` looks right and is wrong for a
  third of its inputs.
- One more piece of instance state (`externalPhase` / the driven flag)
  that `paused`, reduced motion, visibility and `update()` all have to
  agree about. The rule is written down once: while a `time` source is
  attached, the internal clock never runs.

## Implementation plan

### Files to add

| File                                                    | Contents                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------- |
| `packages/dithered/src/core/clock.ts`                   | `wrapPhase`, `advancePhase`, `frameForPhase`, `loopsAt`. Pure, DOM-free, no Reanimated. |
| `packages/dithered/src/core/clock.test.ts`              | Unit tests for the four helpers, including negative and huge phases.                    |
| `packages/dithered/src/native/playback.ts`              | `'worklet'` copies: `wrapPhaseUI`, `advancePhaseUI`, `frameForPhaseUI`, `loopsAtUI`.    |
| `packages/dithered/src/native/playback.test.ts`         | Parity sweep against `core/clock.ts`, plus the native-specific edge cases.              |
| `packages/dithered/docs/adrs/0006-playback-controls.md` | This document.                                                                          |

### Files to change

| File                                                                         | Change                                                                                                                                                                                                                                                                                                                                                                                        |
| ---------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/options.ts`                                                        | Add `speed` (default `1`), `onFrame`, `onLoop` to `DitheredOptions`; narrow `ResolvedOptions` to keep the callbacks optional; add `speed: 1` to `DEFAULTS`.                                                                                                                                                                                                                                   |
| `src/core/paint.ts`                                                          | Re-express `frameAt` via `frameForPhase`; document it as a wall-clock convenience, not the playback path. Behaviour unchanged.                                                                                                                                                                                                                                                                |
| `src/core/index.ts`                                                          | Export the clock helpers and any new types.                                                                                                                                                                                                                                                                                                                                                   |
| `src/renderer.ts`                                                            | Accumulator loop (`phase`, `lastNow`, reset `lastNow` on every halt/resume); `setTime`/`clearTime` on `DitheredInstance`; `onFrame`/`onLoop` dispatch from the single paint decision point; structural-vs-runtime split in `update()`; `initialFrame` seeds `phase = initialFrame / frames`.                                                                                                  |
| `src/react.tsx`                                                              | `time`, `speed`, `onFrame`, `onLoop` props; latest-ref trampolines; `time` effect separate from the reconfigure effect; `progress` re-expressed via `setTime`; `time` beats `progress`.                                                                                                                                                                                                       |
| `src/native/Dithered.tsx`                                                    | `externalPhase` shared value + the two write paths (effect for numbers, `useAnimatedReaction` for shared values); one workletized `applyPhase`; accumulator in the frame callback, differencing `info.timestamp` against an owned `lastTimestamp` shared value; `speed`; `runOnJS` trampolines for `onFrame`/`onLoop`; deactivate the callback while externally driven; `progress` via phase. |
| `src/index.ts`                                                               | Export clock helpers and the new option/callback types.                                                                                                                                                                                                                                                                                                                                       |
| `src/native.ts`                                                              | Same, plus the `playback.ts` worklet helpers.                                                                                                                                                                                                                                                                                                                                                 |
| `README.md` (repo root — the library's README; `packages/dithered` has none) | Document `speed`, `onFrame`, `onLoop`, `setTime`/`clearTime`, the `time` prop on both wrappers, the shared-value form on native, and the `progress` rounding change.                                                                                                                                                                                                                          |
| `packages/playground-web/main.tsx`                                           | A scrub-slider example: a range input driving `time`, next to a free-running instance, plus a `speed` control on the existing playground form.                                                                                                                                                                                                                                                |

### Tests to write

**`core/clock.test.ts`**

1. `wrapPhase` maps `0, 0.5, 1, 1.5, 2` → `0, 0.5, 0, 0.5, 0`.
2. `wrapPhase` maps negatives: `-0.25 → 0.75`, `-1 → 0`, `-2.5 → 0.5`.
3. `advancePhase` is linear: `advancePhase(0, 1000, 2000, 1) === 0.5`.
4. `advancePhase` with `speed = -1` decrements; with `speed = 0` is a no-op.
5. `advancePhase` over many steps equals one big step (accumulator ≈ closed form) within a tight epsilon.
6. `frameForPhase` never returns `frames` or a negative index, swept over phases including values immediately below 1 and `Number.EPSILON`-adjacent ones.
7. `frameForPhase(-0.001, 48) === 47` (backwards wraparound lands on the last frame, not `-1`).
8. `loopsAt` is signed: `0.5 → 0`, `1 → 1`, `-0.001 → -1`, `-1 → -1`.

**`renderer.test.ts` (additions)**

9. Existing `frameAt` tests still pass, untouched.
10. `speed = 2` advances twice as far per RAF tick as `speed = 1` (drive the stubbed RAF with fixed timestamps).
11. Changing `speed` mid-loop via `update()` does not move the displayed frame on the tick of the change — the _drift_ case: assert the frame before and immediately after the change are equal, then that the rate changed on subsequent ticks.
12. Negative `speed` walks the frame index backwards and wraps `0 → frames - 1`.
13. `onFrame` fires once per changed frame and never twice for the same index across consecutive ticks inside one frame's worth of time.
14. `onFrame` does not fire for a repaint at the same index (call `update({ period })` and assert no extra call).
15. `onFrame`'s `t` is in `[0, 1)` and matches `wrapPhase(phase)`.
16. `onLoop` fires once when the phase crosses 1, with `1`; then `2`.
17. `onLoop` fires once, not N times, for a single tick that crosses several boundaries.
18. `onLoop` reports `-1` when a negative `speed` wraps backwards past 0.
19. `setTime` halts the loop: no further RAF is scheduled, and the frame stops changing as the stubbed clock advances.
20. `setTime` paints the frame for the phase; `setTime` twice within one frame's phase range paints once.
21. `setTime` does not fire `onLoop`, even across a whole-number boundary; it does fire `onFrame` when the index changes.
22. `clearTime` resumes the internal clock from the external phase, without a jump.
23. **Two instances given the same `time` render the same frame** (the PRD's explicit test): create two with different `frames`-irrelevant options, `setTime(x)` on both for a sweep of `x`, assert equal painted frame indices.
24. `update({ speed })` / `update({ period })` / `update({ paused })` do not rebuild the sprite strip — assert `document.createElement('canvas')` (or the strip factory) is not called again.
25. `update({ cols })` _does_ rebuild it.
26. `update({ frames })` preserves the phase rather than the raw frame index.
27. Pausing and resuming does not jump the phase (the `lastNow` reset).

**`native/playback.test.ts`**

28. Parity sweep: for a grid of phases × `dt`s × periods × speeds × frame counts, `*UI` helpers equal their `core/clock.ts` twins exactly.
29. `frameForPhaseUI` clamps identically at the top of the range.
30. A simulated accumulator loop (feeding `timeSincePreviousFrame`-shaped values, including a `null`-as-0 first frame) produces the same frame sequence as the web driver over the same timeline — the parity criterion that matters for "two instances, same `time`" across platforms.

**`react.test.tsx` (additions)**

31. `time` renders the matching frame and pauses the loop.
32. `time` changing re-renders without reconfiguring (no resample/cache rebuild).
33. `time` → `undefined` resumes playback.
34. `speed` forwards to the instance without a reconfigure.
35. An inline `onFrame` that changes identity every render does not trigger `update()`, and the _latest_ callback is the one invoked.
36. `progress` still pins a frame and pauses; endpoints `0` and `1` map to frame `0` and `frames - 1`.
37. `time` takes precedence when both `time` and `progress` are passed.

**Added after the first adversarial review** (these are the cases the
original list was blind to — every one of them corresponds to a real bug
the review found, so none may be asserted against a frame count where
the arithmetic happens to be exact):

38. `frameForPhase(phaseForFrame(k, n), n) === k` for **every** `k` in
    `[0, n)` and every `n` in `1..512`. This is the round-trip property
    the whole of §1's `phaseForFrame` exists to guarantee; a sampled
    version of it is not good enough.
39. `progress = 1` paints frame `frames - 1`, and `progress = 0` paints
    frame `0`, asserted on the **painted index** (not on the argument
    `setTime` received) and swept over frame counts that include 48, 36,
    3, 12, 19, 27, 46, 47 and 54.
40. `initialFrame: k` paints frame `k` for every `k` in `[0, frames)`, at
    `frames` values including 48, 60 and 36 — not only at counts where
    `k / frames` is exactly representable.
41. `update({ speed })` does not resurrect a `paused` value the caller
    overrode with `setPaused()`: mount `paused: true`, `setPaused(false)`,
    `update({ speed: 2 })`, assert playback is still running.
42. The web driver's own `tick` — driven through a real `createDithered`
    over a fixed `dt` timeline — produces the same frame sequence as the
    native UI helpers over that same timeline. Test #30 as written
    compares the UI helpers to the core helpers they were already proven
    equal to, which is the same expression twice.

### Checks

`pnpm install`, then `pnpm format`, `pnpm build`, `pnpm typecheck`,
`pnpm test` from the workspace root, all green. `pnpm build:playground`
if the playground changes.
