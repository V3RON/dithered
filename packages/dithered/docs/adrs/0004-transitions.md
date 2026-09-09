# 0004 — Transitions between shapes and presets

## Status

Proposed

## Context

`dithered` renders a shape as a grid of dithered cells animated over a looping
phase `t`. Today the only way to move from one shape/preset to another is:

- unmount the `Dithered` and mount a different one — a hard cut, plus a fresh
  sample/cache build; or
- `update({ shape, brightness })` — which resamples cells and restarts the
  paint from the new loop immediately, so the change lands mid-cycle.

Both read as a jump, and issue #4 points out that the jump happens at exactly
the moment a user is looking at the indicator: the `loading → done` beat.

Issue #4 (the PRD) asks for `transitionTo(patch)` and `finishLoop()` on the
instance, a `transition` option, a `blend(a, b, mix)` brightness helper,
built-in `check`/`cross` shapes, and identical behaviour on `dithered/react`
and `dithered/native`. It fixes the broad strokes — sample both shapes on the
same grid, dissolve by Bayer threshold, crossfade brightness, don't cache
transition frames — and leaves the mechanics open. This ADR fixes them.

The constraints that shape the answer:

- The core (`src/core/`) must stay platform-free. Everything about _what_ is
  drawn during a morph has to live there; only _when_ and _onto what_ differs
  between the canvas driver and the Skia driver.
- The web driver's steady state is a sprite strip (one `drawImage` per frame);
  the native driver's is an array of pre-recorded `SkPicture`s. A transition
  frame is a function of continuous progress, so it belongs to neither.
- Cells carry `(i, j, u, v, threshold)` and are sampled on a `cols × rows`
  grid derived from the shape's aspect ratio. Two different shapes do not, in
  general, resolve to the same grid.

## Decision

### 1. A transition is a time-boxed overlay on the steady-state loop

`transitionTo(patch)` computes the target options exactly as `update(patch)`
would (`assignDefined` onto the current resolved options), then runs a morph
for `duration` ms before applying that target as the new steady state. The
completion path _is_ the existing `update` path: when progress reaches 1 the
driver adopts the target options, resamples, rebuilds its cache, and resumes
normal playback. There is no separate "post-transition" state to keep
consistent.

Progress is linear in wall-clock time: `p = clamp01((now - startedAt) / duration)`.
No easing — the dissolve schedule below already carries the visual character,
and a linear `p` keeps the schedule directly testable.

### 2. The morph runs on the _target's_ grid

The grid (`cols`, `rows`) and the surface size are the target's, adopted at the
first transition frame. The outgoing shape is re-sampled onto that grid for the
duration of the morph.

The alternative — hold the outgoing grid and switch at the end — was rejected
because it puts the discontinuity at the end of the morph, which is precisely
the "done" moment the feature exists to smooth. Ending pixel-identical to a
plain `update()` is worth more than starting pixel-identical to the previous
frame: the outgoing silhouette only has to survive `duration` ms while it
dissolves away, and a change in row quantisation is far less visible on a
shape that is disappearing than a resize on the shape that remains.

When the two shapes share an aspect ratio (or the caller passes an explicit
`rows`), nothing changes at all and this decision is invisible. The shipped
`check` and `cross` use a `0 0 100 100` viewBox for that reason. A `cols`
mismatch is handled by the same rule — the target's `cols` wins — which keeps
the PRD's "position interpolation between arbitrary grids is out of scope"
honest without erroring.

### 3. Cell dissolve: rank-based schedules, complementary Bayer orders

Both shapes are sampled on the target grid and cells are matched by
`key = j * cols + i`:

- `shared` = A ∩ B — drawn for the whole morph.
- `exiting` = A \ B — sorted ascending by `(threshold, j, i)`.
- `entering` = B \ A — sorted descending by `threshold`, then ascending by
  `(j, i)`.

Ordering the two dissolves by _complementary_ Bayer keys means the cells that
leave first are not the cells that arrive first, so the morph reads as a
dither churn rather than one Bayer sweep played twice.

Schedules are **rank-based**, not raw-threshold-based:

```
exitAt(rank, n)   = ((rank + 1) / (n + 1)) * EXIT_END       // EXIT_END = 0.75
enterAt(rank, m)  = ENTER_START + (rank / m) * (1 - ENTER_START)  // ENTER_START = 0.25
```

A cell of `exiting` is drawn while `p < exitAt(rank, n)`; a cell of `entering`
is drawn once `p >= enterAt(rank, m)`.

Rank-based schedules are what make the PRD's "no frame where the canvas is
empty" a _guarantee_ rather than a statistical hope. With raw thresholds, a
small cell set whose Bayer values all sit low would vacate the canvas before
anything arrived. With ranks: the last exiting cell survives until
`p = n/(n+1) * 0.75 >= 0.375`, and the first entering cell arrives at
`p = 0.25`. The two windows overlap for any `n, m >= 1`, and if either set is
empty the other side plus `shared` covers the whole range. The overlap is also
what makes the two dissolves visibly cross-fade instead of running in
sequence.

They are also directly testable — "the k-th cell to leave is the one with the
k-th lowest Bayer threshold" is an assertion; "roughly ordered by threshold"
is not.

### 4. Brightness crossfade: `blend`, plus per-side clocks

`blend(a, b, mix): Brightness` interpolates two brightness functions. Booleans
are coerced to levels first — `true → 1`, `false → 0` — which is exact, since
every Bayer threshold lies strictly inside `(0, 1)`: a coerced `true` always
clears its threshold and a coerced `false` never does. `mix` is clamped to
`[0, 1]`, so `blend(a, b, 0)` and `blend(a, b, 1)` reproduce `a` and `b`'s draw
decisions exactly.

This is the minimal helper the transition needs. Issue #9 (brightness
combinators) specifies a `blend` of its own; this one is deliberately small
and self-contained so the two can be reconciled later without either blocking
the other.

During a morph each side keeps its own phase, from the same wall clock:

```
ta = frameAt(now, from.period, from.frames) / from.frames
tb = frameAt(now, to.period,   to.frames)   / to.frames
```

No stored phase offsets. The outgoing side keeps ticking on exactly the clock
it was already on, and the incoming side is already on the clock the steady
loop will use after completion — so neither preset jumps, at either end. Each
side's `t` is still quantised to its own frame grid so the dither pattern
matches the steady state; only `p` is continuous.

`blend` itself takes a single `t` (the PRD signature). The transition uses an
internal `blendPhases(a, b, mix, ta, tb)` built on the same level-coercion and
lerp primitives.

### 5. Cache interaction

Transition frames are painted directly and never cached, on both platforms.

**Web.** At morph start the sprite strip is dropped (`sheet = null`) and the
canvas is resized to the target surface; the first transition frame is painted
synchronously in the same turn, so the resize never shows through as a blank
frame. Every tick repaints, because `p` is continuous — the "skip if the frame
index didn't change" shortcut does not apply during a morph. On completion the
driver runs the normal `configure()`, which rebuilds the strip for the new
steady state. Building at the end rather than the start is deliberate: it puts
the synchronous burst where the animation has already settled, not at the
moment it begins.

**Native.** The morph is recorded up front as its own array of `SkPicture`s —
the same mechanism as the steady state, so playback stays on the UI thread.
Step count follows the steady-state cadence,
`steps = clamp(round(duration / (period / frames)), 2, 240)`, so a morph ticks
at the same rate as the loop it interrupts. The cap bounds recording cost for
a long `duration`. The transition array is played once, in order, then dropped
and the new steady-state array takes over. Each step `i` is recorded at
progress `p = i / (steps - 1)` — `i = 0` is exactly `p = 0`, `i = steps - 1` is
exactly `p = 1` — so _selecting_ a step during playback has to use the same
denominator, `round(t * (steps - 1))`, not `floor(t * steps)`: the two
denominators disagree by one step, and the wrong one runs playback ahead of
`t`, freezing on the finished target for the last fraction of the morph.

The steady-state `SkPicture[]` a completed morph hands off to must not be
rebuilt from the target config until the morph itself is done with the
canvas — recording is comparatively cheap, but it is not free, and (more
importantly) `useDitheredPictures` and the frame callback that reads its
output both live on ordinary React state/props: if the steady array already
reflected the target the instant `shape`/`brightness` changed, the UI-thread
loop's steady branch — which has no morph state to gate it while one is
merely _queued_ behind `onLoopEnd` — would paint that target on its very next
tick, before any morph frame existed to justify it. The steady array is
therefore built from whatever config is _currently backing playback_, which
stays pinned to the outgoing config for as long as an episode (queued or
active) is unresolved and only advances once it ends — mirroring, on native,
the same "outgoing stays fixed, target is applied only on completion" split
`opts`/`ActiveTransition`/`PendingTransition` give the web renderer for free
by construction.

### 6. `finishLoop()` and `onLoopEnd`

`finishLoop()` returns a promise that resolves the next time playback wraps to
phase 0, resolved from the playback tick rather than from a timer, so it lines
up with what was actually drawn. Wrap detection itself is purely a wall-clock
comparison — `Math.floor(nowMs / period)` against the same quantity computed
on the previous tick — never the painted frame index: a frame index is
written by more than steady playback (`update()` holds it across a phase
change, `renderFrame()` sets it to whatever the caller asks, a morph doesn't
touch it at all while it's running), so a decrease there does not reliably
mean a loop boundary was crossed.

That wall-clock baseline is tagged with the `period` it was captured under,
and a comparison against a baseline captured under a _different_ `period`
(one changed since) is treated the same as having no baseline at all — no
wrap reported, baseline reset — rather than compared anyway, which could
manufacture a false wrap or hide a real one. This tag lives independently of
`configure()`: an earlier version reset the whole baseline on every
`configure()` regardless of _why_ it ran, which swallowed any wrap that fell
in the same rAF gap as an unrelated reconfigure (a transition landing on the
same `period` is the common case) — delaying `finishLoop()`/a queued
`onLoopEnd` morph by up to a full `period`, or indefinitely under reconfigures
frequent enough to always land inside that gap.

A promise that can never settle is worse than one that settles early, so
pending resolvers are also drained — resolved, never rejected — whenever the
loop stops advancing: `setPaused(true)`, tab hidden, canvas off-screen,
reduced motion, or `destroy()`. Resolution therefore means "the loop is not
mid-cycle any more", not "a full cycle was drawn"; the README says so. This
applies uniformly regardless of _which_ call is what actually stops the
loop — `update()`/`cutToTarget()` landing on a patch that halts it (an
explicit `paused: true`, or reduced motion having turned on since the last
check) drain exactly like `setPaused(true)` does, not only the calls that are
always a halt by construction. A morph completing on its own — `finishTransitionNow`
running from `tick()`'s `p >= 1` branch, with nothing else in the call stack
to drain afterward — is the same case again: the patch that started (or
superseded into) the morph can itself carry `paused: true`, or reduced motion
can have turned on during `duration` and only get re-read there, so
`finishTransitionNow` drains on its way out exactly like `update()`/`cutToTarget()`
do.

`transition.onLoopEnd` is **not** implemented as `await finishLoop()` before
starting the morph. It has its own mechanism: a `transitionTo` call with
`onLoopEnd` set stores the caller's patch (not a precomputed target — see
below) in a single pending-transition slot instead of calling `startTransition`
right away. The same wrap detection that resolves `finishLoop()`'s resolvers
also releases this slot — both live in the tick that observes the wrap — but
`await finishLoop()` chained in front of `startTransition` was the first
implementation, and it did not survive contact with the rest of this ADR:

- **Staleness.** `finishLoop()` resolving is a promise callback, a microtask
  away from the tick that resolved it. `transitionTo`'s target is computed by
  merging the caller's patch onto `opts` — and by the time that `.then`
  continuation ran, `opts` could already reflect an intervening plain
  `update()`, which the merge would then silently discard. Storing the
  _patch_ and recomputing the target only when the wait actually ends (release
  or an early settle) is what keeps a later `update()`/`transitionTo()` from
  being reverted by a deferred one firing after it.
- **Settling on halt.** `finishLoop()`'s drain rule (§6, above) resolves the
  promise early when the loop stops advancing, but a promise resolving is all
  it does — it has no target state to apply. A deferred `transitionTo`
  does: if playback halts while its morph is still queued, "the loop
  isn't mid-cycle any more" is true, but "cut to the target now" also has to
  happen, or the instance is stranded showing the pre-`transitionTo` shape
  indefinitely. `finishLoop()`'s own resolvers can't carry that extra step.

Concretely: `pendingTransition` holds `{ patch, resolve }`. The same tick that
detects the wrap calls `releasePendingTransition()`, which recomputes the
target from the live `opts`, re-checks reduced motion and whether the loop is
still advancing, and either starts the real morph or — if either check now
says otherwise — cuts straight to the target and resolves immediately, the same
"never leave a promise hanging" instinct `finishLoop()` follows. A halt before
the wrap ever comes (`setPaused(true)`, tab hidden, canvas off-screen) calls
`settlePendingNow()`, the same cut-and-resolve path, from the halt handler
instead of the wrap tick; `destroy()` calls the paint-free `settlePendingSilently()`
variant. So a queued `onLoopEnd` transition _does_ end up sharing `finishLoop()`'s
"resolve early rather than hang" instinct on halt — just via its own slot and
its own settle functions, not by literally being `await finishLoop()`, and
with the additional obligation (applying the target) that a bare `finishLoop()`
call never has.

### 7. Reduced motion, pausing, and overlap

- `prefers-reduced-motion` (web) / `useReducedMotion()` (native), when
  `respectReducedMotion` is set: `transitionTo` skips the morph entirely,
  applies the patch through `update()`, and returns an already-resolved
  promise. `onLoopEnd` is ignored — there is no loop to wait for.
- A morph in progress when playback halts (paused, hidden, off-screen) or when
  the instance is destroyed **completes immediately**: the target options are
  applied and the promise resolves. Half-morphed state is never left behind,
  and no promise outlives the thing it describes. On `destroy()` the target is
  not painted — the canvas is going away — but the promise still resolves.
- A `transitionTo` while another morph is running finishes the running one
  instantly (its target becomes the current steady state, its promise
  resolves) and starts the new morph from there. Blends are never nested, so
  the state stays bounded no matter how fast a caller flips props.
- `renderFrame(frame)` "draws a specific frame directly, bypassing the
  animation loop" — bypassing wins over a transition too: it settles one in
  flight or queued first (the same cut-short path a halt uses), then paints
  `frame` against the now fully-resolved, mutually consistent target. A bare
  paint against a mid-transition instance would mix the outgoing shape's
  cells/brightness with the target's already-resized surface (the resize
  happens at morph start, per §5) — the wrong cell count at the wrong pitch,
  not a recognizable point on the morph curve.
- `paused` and an option change landing in the same render/commit is decided
  by the state that commit actually ends on, not the state from just before
  it: unpausing and changing `shape` together starts a real morph (there is a
  loop to overlay it on by the time the change lands); pausing and changing
  `shape` together still cuts immediately (there is not, once it lands) — the
  same rule regardless of which prop a caller happens to have changed in
  which commit, and the same on `dithered/react` and `dithered/native`. On
  native, where `holding` is computed straight from each render's own props,
  this falls out for free. `dithered/react` drives the imperative core
  through two separate effects (pausing, and reconfigure/`transitionTo`) — to
  get the same answer there, the pausing effect is declared _before_ the
  reconfigure effect, so `setPaused()` has already landed on the instance by
  the time `transitionTo()` reads whether the loop is advancing.

### 8. Where the code lives

Everything about _what_ to draw at progress `p` is a pure function in
`src/core/transition.ts`. The web renderer and the native hook each own only
the scheduling and the surface. That is what makes the "identical props on
both platforms" acceptance criterion structural rather than a promise.

The one place the two platform wrappers deliberately diverge from the core is
how `patch.transition` gets built. `renderer.ts`'s own merge
(`mergeTransitionOption`) is sticky — a `transitionTo({ transition: {
duration: 600 } })` after an earlier call that set `onLoopEnd: true` keeps
`onLoopEnd: true`, the same rule every other field in a patch follows. That is
correct for the _imperative_ API, where a caller who didn't mention a field
plainly meant "leave it". It is wrong for the _declarative_ `transition` prop
on `dithered/react`/`dithered/native`: a fresh render's props are supposed to
be the whole truth, and a component whose `transition={{ duration: 400 }}`
can never turn a previously-set `onLoopEnd: true` back off is a one-way door.
Both wrappers resolve the prop against `TRANSITION_DEFAULTS` on every render,
before it ever reaches `update()`/`transitionTo()`, so the object the core
sees always has every field populated — the sticky merge underneath it never
actually has anything to fall back to, and the two rules never collide.

## Alternatives considered

- **Per-cell position interpolation** (morph cell centres from A's grid to
  B's). Explicitly out of scope in the PRD, and it would defeat the point:
  cells at fixed grid positions are what makes the dither read as a dither.
- **Hold the outgoing grid for the morph, switch at the end.** Rejected in
  §2 — it moves the discontinuity to the "done" beat.
- **Raw Bayer threshold as the dissolve schedule** (`drawn while p < threshold`).
  Simplest reading of the PRD, and what §3 replaces: it cannot guarantee a
  non-empty canvas, and it is untestable beyond "roughly ordered".
- **Distance from centre as the dissolve key** (the PRD's stated alternative).
  Kept available in spirit — the schedule is a pure function of a sort order,
  so a future `transition.order: 'bayer' | 'radial'` is an added comparator
  and nothing else. Not shipped now; Bayer matches the renderer's identity.
- **Eased progress** (`easeInOut`). Deferred: it composes with the schedule
  by transforming `p` at a single call site, and it makes the schedule
  assertions indirect for no visual gain at 400 ms.
- **Caching transition frames on web.** The morph is played once; a strip for
  it would cost a synchronous build of `steps` frames to save one repaint
  each. Native records pictures anyway because that is the only way to keep
  playback off the JS thread.
- **Rejecting the promise on `destroy()`/cancel.** Rejected — an
  `await transitionTo(...)` on an unmount path would become an unhandled
  rejection for doing nothing wrong.
- **Letting a paused instance hold a half-morphed frame.** Rejected: it makes
  the visible state depend on when the tab was hidden.

## Consequences

- `DitheredInstance` gains two methods and `DitheredOptions` one option; both
  are additive, so nothing on `claude/react-native-canvas-erbrlw` breaks.
  `ResolvedOptions` gains a resolved `transition`, which means `DEFAULTS`
  grows an entry.
- Morph frames cost a full `paintFrame` per tick on web (no strip). Bounded by
  `duration`, and the steady state is unchanged.
- Native pays a recording burst of up to 240 pictures when a morph starts.
- Two shapes with different aspect ratios resize the canvas at morph start.
  Documented, with the "pair shapes that share a viewBox aspect" guidance.
- `finishLoop()` resolving early on halt is a real semantic wrinkle. It is the
  lesser evil against a hanging promise, and it is documented.
- `blend` will need reconciling with issue #9's combinator version.

## Implementation plan

### Files to add

| File                                              | What                                                                                                                                                                                                                                                                    |
| ------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dithered/src/core/transition.ts`        | `TransitionOptions`, `TRANSITION_DEFAULTS`, `EXIT_END`/`ENTER_START`, `toLevel`, `blend`, `blendPhases`, `diffCells`, `exitAt`/`enterAt`, `transitionCells(diff, p)`, `createTransition(...)` returning `{ progressAt, cellsAt, brightnessAt }`. Pure; no DOM, no Skia. |
| `packages/dithered/src/core/transition.test.ts`   | Unit tests for the above.                                                                                                                                                                                                                                               |
| `packages/dithered/src/native/transition.ts`      | `useDitheredTransition` — records the morph as `SkPicture[]` from the same `paintFrame`/`skiaPaintContext` path as `useDitheredPictures`.                                                                                                                               |
| `packages/dithered/src/native/transition.test.ts` | Tests against a mocked `@shopify/react-native-skia`, following `native/hit-test.test.ts`.                                                                                                                                                                               |
| `packages/dithered/docs/adrs/0004-transitions.md` | This ADR.                                                                                                                                                                                                                                                               |

### Files to change

| File                                                               | What                                                                                                                                                                                           |
| ------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/options.ts`                                              | `DitheredOptions.transition?: TransitionOptions`; `DEFAULTS.transition`.                                                                                                                       |
| `src/core/index.ts`                                                | Re-export the transition surface.                                                                                                                                                              |
| `src/renderer.ts`                                                  | `DitheredInstance.transitionTo` / `finishLoop`; morph scheduling in the rAF tick; drop/rebuild the sprite strip per §5; drain resolvers on halt and in `destroy()`.                            |
| `src/shapes.ts`                                                    | `check` and `cross` (viewBox `0 0 100 100`), added to the `shapes` map.                                                                                                                        |
| `src/index.ts`, `src/native.ts`                                    | Export `blend`, `check`, `cross`, the transition types.                                                                                                                                        |
| `src/react.tsx`                                                    | `transition` prop; route option changes through `transitionTo` instead of `update` when it is set.                                                                                             |
| `src/native/Dithered.tsx`                                          | `transition` prop; play the morph recordings, then the new steady-state ones; honour `onLoopEnd` and reduced motion.                                                                           |
| `src/renderer.test.ts`, `src/react.test.tsx`, `src/shapes.test.ts` | Extend.                                                                                                                                                                                        |
| `packages/playground-web/main.tsx`                                 | A "Loading → done" example (§ PRD acceptance criteria): a button that flips `shape`/`brightness` to `check`/`fill()` with `transition={{ duration: 400 }}`, and back.                          |
| `README.md` (repo root — the package has no README of its own)     | A "Transitions" section: `transitionTo`, `finishLoop` (including the early-resolve rule), the `transition` option, `blend`, `check`/`cross`, the shared-grid caveat, reduced-motion behaviour. |

### Tests to write

**`core/transition.test.ts`**

1. `diffCells` partitions two cell sets into `exiting` / `entering` / `shared`
   by `(i, j)`, and `shared` uses the target's cell objects.
2. `exiting` is ordered by ascending Bayer threshold; `entering` by
   descending; ties broken by `(j, i)` so the order is deterministic.
3. `transitionCells(diff, 0)` equals the source set and
   `transitionCells(diff, 1)` equals the target set, exactly.
4. The drawn set is monotone: exiting cells only ever leave, entering cells
   only ever arrive, as `p` increases.
5. **Non-empty for every `p`** — swept finely over `[0, 1]`, including the
   disjoint case (no shared cells) and small sets (`n = 1`, `m = 1`).
6. `blend`: exact at `mix = 0` and `mix = 1`; linear in between; `mix` clamped
   outside `[0, 1]`; boolean coercion (`true`/`false` blended against numbers
   and against each other) produces the documented draw decisions.
7. `createTransition` drives each side's `t` from its own `period`/`frames`,
   and `progressAt` clamps to `[0, 1]`.

**`renderer.test.ts`**

8. `transitionTo` resolves after `duration` of ticks and leaves the instance in
   the target state (subsequent frames use the target shape's cells).
9. No blank frame: every tick during the morph paints at least one cell.
10. The sprite strip is dropped for the morph and rebuilt once afterwards —
    assert on `drawImage` usage before/during/after.
11. Reduced motion cuts straight to the target and resolves.
12. `finishLoop()` resolves when the frame index wraps to 0.
13. `finishLoop()` resolves when playback halts (paused / hidden / off-screen)
    without a wrap.
14. `transition.onLoopEnd` defers the morph until after a wrap.
15. A second `transitionTo` mid-morph resolves the first and lands on the
    second target.
16. `destroy()` resolves every pending `finishLoop`/`transitionTo` promise and
    releases the strip; no listener or observer survives.

**`react.test.tsx`** — with `transition` set, a `shape` prop change calls
`transitionTo` rather than `update`; without it, `update` as before.

**`native/transition.test.ts`** — the morph records `steps` pictures at the
steady-state cadence, clamped to `[2, 240]`; reduced motion records none and
lands on the steady-state array; the recordings are dropped after playback.

**`shapes.test.ts`** — `check` and `cross` sample to a non-empty cell set and
are exported from the `shapes` map.

### Checks

`pnpm install`, `pnpm format`, `pnpm build`, `pnpm typecheck`, `pnpm test` from
the workspace root, all green, before the branch is pushed.
