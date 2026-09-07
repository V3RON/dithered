# 0009 — Brightness combinators (`compose`)

## Status

Proposed

## Context

Issue #9 asks for a small set of pure helpers that take a `Brightness` and return a
`Brightness`, so a user can say "sweep, but slower and only on the left half" without
reimplementing `sweep`.

Two facts about the existing code shape the design:

1. `Brightness` is `(cell: Cell, t: number) => number | boolean`. The boolean arm is a
   real, used feature — `fill` and `gameOfLife` return booleans, and `paintFrame` reads
   `typeof b === 'boolean' ? b : b > cell.threshold`, so a boolean bypasses the dither
   entirely for a crisp edge. Every combinator therefore has to make an explicit choice
   about what it does with a boolean source, and the choices are not all the same.
2. Brightness functions run in the hot path — once per cell per frame, inside the web
   sprite-strip cache loop and inside a Skia picture recording. A combinator that
   allocates, branches on option shape, or closes over mutable state per call would show
   up in both.

The PRD leaves four things open, and this ADR settles them:

- what each helper does with a boolean source,
- what `mix` means when it is a function rather than a number,
- how the non-integer `timeScale` warning is emitted exactly once and stripped from
  production builds,
- the export shape of the `compose` namespace.

There is also a coordination constraint: issue #4 (transitions) needs `blend` and is being
implemented in parallel. The combinators must live in one self-contained module with no
imports from `presets`, `renderer` or anything DOM-shaped, so the transitions work can
adopt it without dragging in a dependency graph.

## Decision

Add `packages/dithered/src/compose.ts`: seven pure factories, each taking a `Brightness`
(and options) and returning a `Brightness`.

### Module shape

`compose.ts` imports **types only** — `Brightness` from `./core` (the platform-free home
of the type; _not_ from `./renderer`, which is web-side) and `Cell` from `./shape`. It has
no runtime imports, so it is safe for both the web and native entries and adoptable by the
transitions work as-is.

Two supporting types are exported:

```ts
export type MixAmount = number | ((cell: Cell, t: number) => number);
export type CellPredicate = (cell: Cell) => boolean;
```

### Allocation and branching discipline

Every helper resolves its options **at construction time** and returns a closure that does
no allocation and no option-shape branching per call. Where an option can take two shapes
(`blend`'s `mix`), the branch is taken once in the factory and one of two specialized
closures is returned — the returned function never re-tests `typeof mix`.

### Semantics, helper by helper

**`blend(a, b, mix)` — always numeric.** Booleans from either source are coerced (`true`
→ `1`, `false` → `0`); the result is always a number, because a linear mix of two crisp
masks is not itself crisp. The formula is `(1 - m) * a + m * b`, not `a + (b - a) * m`, so
that `m === 0` returns exactly `a` and `m === 1` returns exactly `b` in floating point.

`mix` as a function is evaluated as `mix(cell, t)` with **the same `(cell, t)` the composed
brightness was called with** — `blend` performs no time transform, so there is no second
time domain to be confused about. The value is **not clamped** to `[0, 1]`: values outside
it extrapolate, which is a legitimate over/undershoot effect, and silently clamping would
remove it with no way to opt out. `compose.clamp` is the documented way to bound the
result.

**`mask(source, predicate)` — preserves booleans, rejects to `false`.** When
`predicate(cell)` is true the source's value is returned **unchanged** (a boolean stays a
boolean, a number stays a number). When it is false the helper returns the boolean `false`
rather than `0`. `false` is unconditionally not drawn; `0` merely happens not to clear a
Bayer threshold, which is true only because thresholds are in the open interval `(0, 1)`.
Depending on that is a latent bug if the threshold set ever changes. The predicate takes
only `cell`, per the PRD — masks are spatial, and a time-varying mask is `blend` with a
function `mix`.

**`invert(source)` — preserves booleans.** Numbers become `1 - b`; booleans become `!b`.
No clamping: `1 - b` of an out-of-range brightness stays out of range, and `clamp` is
available.

**`clamp(source, min = 0, max = 1)` — coerces booleans to numbers.** Booleans are coerced
to `1`/`0` and then clamped, so the result is always a number. The alternative — passing
booleans through untouched — makes `clamp` a silent no-op on `fill()` and `gameOfLife()`,
which is a footgun; `clamp(fill(), 0, 0.5)` meaning "the lit part of the fill, at half
brightness" is both useful and the reading a user would expect. Bounds are applied as
`Math.min(max, Math.max(min, b))`, so if `min > max` the `max` bound wins; this is
documented rather than validated.

**`timeScale(source, factor)`, `reverse(source)`, `offset(source, dt)` — pass values
through untouched.** These transform the time argument only, so a boolean source stays
boolean and a numeric source stays numeric.

### Time-domain details

A module-private `wrap01(t) = t - Math.floor(t)` maps any real `t` into `[0, 1)`.

- **`offset(source, dt)`** computes `source(cell, wrap01(wrap01(t) + d))` where
  `d = wrap01(dt)` is resolved once in the factory. The **inner** wrap of `t` matters: the
  naive `wrap01(t + d)` is not exactly periodic in floating point (with `dt = 0.3`,
  `1.3 - 1 === 0.30000000000000004` but `0.3 - 0 === 0.3`), so `f(cell, 0) === f(cell, 1)`
  would fail an exact-equality test for most `dt`. Wrapping `t` first makes `t = 1` and
  `t = 0` land on the identical float, so periodicity is exact, not approximate. Inside
  `[0, 1)` the extra wrap is the identity, so nothing else changes.

- **`timeScale(source, factor)`** computes `source(cell, wrap01(t * factor))` and
  deliberately does **not** pre-wrap `t`. Pre-wrapping would make `f(cell, 0) === f(cell, 1)`
  hold trivially for _every_ factor, including non-integer ones — papering over exactly the
  discontinuity the PRD wants surfaced and making both the warning and the periodicity test
  meaningless. With no pre-wrap, an integer factor gives `wrap01(factor) === 0 === wrap01(0)`
  exactly, and a non-integer factor visibly does not.

- **`reverse(source)`** computes `source(cell, 1 - t)` with **no** wrapping. Wrapping would
  turn `t = 0` into `source(cell, 0)` instead of `source(cell, 1)`, which silently breaks
  reversal for the intentionally non-periodic `fill()` preset (a reversed fill must start
  full and drain). For a periodic source `source(0) === source(1)`, so the unwrapped form
  is exactly periodic anyway.

The asymmetry between the three is intentional and is documented in each helper's doc
comment.

### The non-integer `timeScale` warning

Emitted **at construction time**, not per call, so it costs nothing in the render loop:

```ts
let warnedTimeScaleFactors: Set<number> | undefined;
// ...inside timeScale()
if (process.env.NODE_ENV !== 'production') {
  if (!Number.isInteger(factor)) {
    warnedTimeScaleFactors ??= new Set();
    if (!warnedTimeScaleFactors.has(factor)) {
      warnedTimeScaleFactors.add(factor);
      console.warn(/* ... */);
    }
  }
}
```

Deduplication is **per distinct factor value**, not a single global boolean: a component
re-rendering in a loop must not spam the console, but a user who genuinely has two
different bad factors should hear about both. The `Set` is created lazily inside the guard
so a production bundle keeps only an unused `let`.

`process.env.NODE_ENV !== 'production'` is the guard because it is the one form every
consumer toolchain strips: webpack, Vite, Rollup + `@rollup/plugin-replace`, and Metro
(React Native) all replace it statically. `__DEV__` is React Native-only; `import.meta.env`
is Vite-only.

This requires one change to `packages/dithered/vite.config.ts`: a
`define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' }` entry. Vite's library build
otherwise substitutes the literal `"production"` into the emitted bundle, which would hard-
disable the warning for every consumer including in development. Defining the expression to
itself keeps it verbatim in `dist/` and lets the _consumer's_ bundler decide. This must be
verified by grepping the built output, not assumed.

### Export shape

Mirrors `presets` exactly: each helper is a named export, and a frozen-by-convention object
literal collects them.

```ts
export const compose = { blend, mask, timeScale, reverse, offset, invert, clamp };
```

Both entries re-export the named helpers, the `compose` namespace, and the two types:

- `src/index.ts` — the root entry, per the PRD's acceptance criteria.
- `src/native.ts` — for parity. `compose.ts` has no runtime imports and no DOM references,
  so there is no reason for the native entry to be missing it, and an asymmetric surface is
  a bug report waiting to happen.

No name collides with an existing root export (`fill` is a preset; `clamp`, `invert`,
`mask`, `blend`, `offset`, `reverse`, `timeScale` are all new).

## Alternatives considered

**A string or object DSL** (`compose('sweep | timeScale 2')`). Explicitly out of scope in
the PRD, and it would trade type safety for nothing — plain function composition already
reads fine.

**Making the combinators methods on a wrapper class** (`wrap(sweep()).timeScale(2).mask(p)`).
Chaining reads nicely, but it forces every `Brightness` through a wrapper object, breaks the
"a preset is just a function" contract that `brightness` props depend on, and adds an
`.unwrap()` step at every boundary. Free functions compose with `presets` output directly.

**Clamping `mix` to `[0, 1]` inside `blend`.** Rejected: it silently deletes extrapolation,
and the composed value is compared against a Bayer threshold anyway, so out-of-range values
are already well-defined (they simply always or never draw).

**Returning `0` from a rejected `mask` cell** rather than `false`. Rejected as described
above — it relies on thresholds being strictly greater than zero.

**Emitting the `timeScale` warning per call, with a call-site guard.** Rejected: it puts a
branch in the hot loop for a purely diagnostic feature. Construction time is where the
factor is known and where the cost is paid once.

**Warning once globally rather than per factor.** Rejected: a second, different mistake
would be silently swallowed.

**Passing the pre-scaled `t` to a function `mix` in `blend`.** Not applicable — `blend`
does not transform time. Documented so the transitions work (issue #4) does not have to
guess.

## Consequences

- Users get seven composable helpers with no new runtime dependency and no change to any
  existing export. The change is purely additive; nothing in `presets`, `core` or the
  renderers moves.
- `compose.ts` is self-contained (type-only imports), so issue #4's transitions work can
  import `blend` from it without inheriting anything else.
- `blend` and `clamp` lose the boolean fast path — composing `fill()` through them means
  the result is dithered against the Bayer threshold rather than drawn crisply. This is
  inherent to what those operations mean and is documented in the README.
- The `vite.config.ts` `define` change affects **all** entries, not just `compose`. It is
  the correct behavior for a published library, but it is a build-level change and is
  called out as such.
- Periodicity is preserved by construction for `offset`, `reverse` and integer `timeScale`,
  but only _given a periodic source_. Composing a non-periodic source (`fill`) still yields
  a non-periodic result; the helpers do not and cannot fix that.

## Implementation plan

### Files to add

- `packages/dithered/src/compose.ts` — the seven helpers, `wrap01`, the two exported types,
  the `compose` namespace object. Doc comments on every export, matching the density and
  voice of `presets.ts` (including the "why" notes on the time-domain asymmetry).
- `packages/dithered/src/compose.test.ts` — see tests below.
- `packages/dithered/docs/adrs/0009-brightness-combinators.md` — this file.

### Files to change

- `packages/dithered/src/index.ts` — re-export `compose`, the seven named helpers, and the
  `MixAmount` / `CellPredicate` types.
- `packages/dithered/src/native.ts` — the same re-exports.
- `packages/dithered/vite.config.ts` — add
  `define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' }`. After `pnpm build`, grep
  `packages/dithered/dist/*.js` to confirm the guard survives verbatim and was not replaced
  with `"production"`.
- `README.md` (repo root — this is the library's README; `packages/dithered` has none) — a
  new "Composing presets" section after "Custom animations", documenting all seven helpers
  in a table, the boolean rules, the non-integer `timeScale` caveat, and **two worked
  examples**: (1) the PRD's motivating case, `sweep` slowed down and masked to the left
  half; (2) a `blend` of two presets driven by a function `mix`.
- `packages/playground-web/main.tsx` — a second preset selector ("Blend with", defaulting
  to "none") plus a mix slider shown only when a second preset is chosen. When active the
  preview brightness becomes `compose.blend(primary, secondary, mix)`, and the live code
  snippet reflects it (importing `compose` and emitting the `compose.blend(...)` call).

### Tests to write (`compose.test.ts`)

1. **Export shape** — `Object.keys(compose)` is exactly the seven names; each named export
   is the same function reference as its `compose` member.
2. **Periodicity, every helper** — for a set of sample cells, wrapping the periodic `sweep()`
   in each of `blend`, `mask`, `timeScale(2)`, `reverse`, `offset(0.3)`, `invert`, `clamp`
   gives `f(cell, 0) === f(cell, 1)`. Use **exact** equality for `offset`, `reverse` and
   integer `timeScale` — the whole point of the wrapping decisions above is that these are
   exact, and a `toBeCloseTo` would not catch a regression to the naive form.
3. **`timeScale`** — integer factor preserves periodicity exactly; a non-integer factor
   (e.g. `2.5`) demonstrably does not; `timeScale(s, 2)` at `t = 0.25` equals `s` at
   `t = 0.5`; a boolean source stays boolean.
4. **`timeScale` warning** — with `console.warn` spied: a non-integer factor warns once;
   constructing it again with the _same_ factor does not warn again; a _different_
   non-integer factor does warn; an integer factor never warns.
5. **`blend`** — `mix = 0` returns exactly `a`, `mix = 1` returns exactly `b`, `mix = 0.5`
   is the midpoint; boolean sources coerce to `1`/`0`; a function `mix` receives the same
   `(cell, t)` the composed function was called with (assert on captured arguments); a
   mix outside `[0, 1]` extrapolates rather than clamping; each source is called exactly
   once per invocation.
6. **`mask`** — an accepted cell returns the source value unchanged, including preserving a
   boolean `true` and a numeric value; a rejected cell returns exactly `false` (not `0`);
   the predicate receives the cell and is not passed `t`.
7. **`invert`** — `0.25` → `0.75`; `true` → `false`, `false` → `true`; out-of-range input
   is not clamped.
8. **`clamp`** — values below `min` and above `max` are bounded, an in-range value passes
   through; boolean `true`/`false` coerce to `1`/`0` and are then clamped (so
   `clamp(source, 0, 0.5)` on a `true` gives `0.5`); defaults are `0` and `1`.
9. **`offset`** — `offset(s, 0.25)` at `t = 0` equals `s` at `t = 0.25`; `dt` greater than
   `1` and negative `dt` both wrap correctly; a boolean source stays boolean.
10. **`reverse`** — `reverse(s)` at `t = 0.25` equals `s` at `t = 0.75`; reversing the
    non-periodic `fill()` starts full and ends empty (the case that would regress if
    `reverse` wrapped its time argument).
11. **Composability** — a stacked case (`mask(timeScale(sweep(), 2), p)`) returns finite
    numbers over a sweep of `t`, and still satisfies `f(cell, 0) === f(cell, 1)`.

### Checks

`pnpm install`, `pnpm format`, `pnpm build`, `pnpm typecheck`, `pnpm test` from the
workspace root, all green, plus the `dist/` grep described above.

## Amendments after review

An adversarial review of the implementation found no critical issues, but surfaced three
points worth recording here because they change or sharpen something this ADR asserted.

**The `timeScale` warning's dedupe `Set` is now capped.** The original design deduped
warnings per distinct `factor` value with no bound on how many distinct values it would
remember. That's fine for hand-written factors, but a `factor` driven by a slider or an
animated value (e.g. `compose.timeScale(sweep(), speed)` behind `<input type="range"
step="0.01">`) passes through dozens of distinct floating-point values in normal use, each
one both warning and permanently retaining a `Set` entry — the console spam and unbounded
growth this dedupe strategy exists to prevent, reappearing for a different kind of caller.
`compose.ts` now stops adding to the `Set` (and stops warning) once it holds 8 distinct
factors. Below the cap, the original property holds exactly as designed: two different bad
factors are both reported. Above it, further non-integer factors are silently not warned
about, which is the right trade for a diagnostic feature — it must not be the reason a
slider-bound animation retains memory or floods the console.

**The `process` reference is now guarded with `typeof`.** The original code read
`process.env.NODE_ENV` directly, relying on every bundler in the toolchain list statically
replacing it. That holds for the toolchains named, but this is a zero-dependency library
with a documented plain-`<script type="module">` (Vanilla) entry point, and an unbundled
ESM import in a browser has no `process` global at all — the bare read throws a
`ReferenceError` from `timeScale`, including for an integer factor that was never going to
warn. The guard is now `typeof process !== 'undefined' && process.env.NODE_ENV !==
'production'`. This still folds away under every bundler this ADR names — `typeof x !==
'undefined'` is exactly as statically replaceable as the bare read once `process.env.NODE_ENV`
is substituted with a literal — and was re-verified against `dist/` and an esbuild
production-define consumer bundle after the change, per the ADR's own "must be verified by
grepping the built output, not assumed" instruction.

**Correction: the `typeof process` guard above was itself dead in every bundler, on the
platform the warning matters most for.** A second adversarial review found that the fix
described in the previous amendment does not do what it says. Bundlers substitute the
_token_ `process.env.NODE_ENV` with a string literal; none of them define a `process`
global for the browser. So after substitution, `typeof process !== 'undefined' &&
process.env.NODE_ENV !== 'production'` reads as `typeof process !== 'undefined' &&
"development" !== 'production'` — and `process` is still undefined at runtime, so
`typeof process !== 'undefined'` is `false` and the whole block never runs. This was
verified empirically, not assumed: this repo's own Vite dev server serves `compose.ts`
transformed to exactly that shape, and an esbuild bundle of `dist/index.js` with
`--define:process.env.NODE_ENV='"development"'`, executed in a Node `vm` context with no
`process` global (simulating an unbundled browser after bundling), produced zero warnings
for a non-integer factor. The "re-verified against `dist/`" claim in the previous amendment
checked that the guard's _shape_ survived the build unchanged; it did not check whether that
shape actually warns in a browser-like environment, which is the failure this correction
fixes.

The guard is now resolved once at module load into a plain boolean, via `try`/`catch` around
the bare read:

```ts
let devWarningsEnabled: boolean;
try {
  devWarningsEnabled = process.env.NODE_ENV !== 'production';
} catch {
  devWarningsEnabled = false;
}
```

`timeScale` then checks `if (devWarningsEnabled)` instead of re-reading `process.env.NODE_ENV`
(or a `typeof` guard around it). This was verified against all four scenarios that matter,
each executed rather than inferred:

- **Bundled dev browser app** (esbuild `--define:process.env.NODE_ENV='"development"'`,
  evaluated in a `vm` context with no `process` global): **warns.** The `define` replaces
  the token before the module ever runs, so the `try` body reduces to a literal comparison
  with no `process` reference left to throw.
- **Bundled production browser app** (same, with `"production"`): **does not warn.**
- **Unbundled ESM in a browser** (`dist/index.js` imported directly, no substitution, no
  `process` global at all, evaluated in a `vm` context with a recursive module linker):
  **does not throw** — the bare read throws a `ReferenceError` inside the `try`, the `catch`
  sets the flag to `false`, and the module finishes evaluating and running normally.
- **Node** (`NODE_ENV` unset, and again with `NODE_ENV=development`, importing the real
  built `dist/index.js`): **warns.** (`NODE_ENV=production`): **does not warn.**

**Trade-off, measured rather than assumed:** the previous, foldable `if (process.env.NODE_ENV
!== 'production')` let a minifier constant-fold the whole guard away under a production
`define`, deleting the dead `console.warn` branch entirely. Hoisting the flag into a
`try`/`catch`-assigned `let` defeats that: the minifier can still fold the _assignment_
(`devWarningsEnabled = false` in a production build), but the `if (devWarningsEnabled)` check
inside `timeScale` is a runtime read of a `let`, not a foldable literal, so the branch and its
`console.warn` string are not eliminated. Measured with esbuild's minifier on both a
`"development"`- and a `"production"`-defined bundle of the same entry point: both minified
outputs are byte-identical in size (954 bytes) and both contain the full warning string
verbatim. This is judged an acceptable trade — a few hundred bytes of unreachable string in
a production bundle, versus a warning that silently never fires in the one environment
(bundled browser dev) the PRD's "warn once in dev" is mainly for.

**`mask`'s `false` sentinel does not survive `invert` or `clamp` placed after it.** This was
always true given the semantics decided above — `invert` and `clamp` each have an explicit,
documented rule for _any_ boolean input, and neither rule distinguishes "this is `false`
because the source said so" from "this is `false` because `mask` rejected the cell" — but it
was not called out as a consequence, and it is easy to hit by composing in the less useful
order. `compose.invert(mask(source, predicate))` draws every masked-out cell solid (`!false
=== true`); `compose.clamp(mask(source, predicate), min, max)` lights up every masked-out
cell to `min` whenever `min > 0`. Composing the other way — `mask(invert(source),
predicate)`, `mask(clamp(source, min, max), predicate)` — behaves as expected, because
`mask` is then the last thing to see the boolean and its own rule (reject to `false`) is the
one that applies. No code changed; this is a documentation gap, now closed in the README's
boolean-rules paragraph: put `mask` last in a composition chain.
