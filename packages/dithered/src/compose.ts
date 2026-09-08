import type { Brightness } from './core';
import type { Cell } from './shape';

// `process.env.NODE_ENV` below is a build-time convention several bundlers
// substitute with a string literal, at least in production: webpack and
// Rollup + `@rollup/plugin-replace` do it for both dev and prod builds;
// Metro (React Native) only inlines it for a **production** build (see
// `isProcessEnvNodeEnv` in `metro-transform-plugins/src/inline-plugin.js`) —
// in Metro dev, `process.env.NODE_ENV` is a real read of the `process` global
// that `react-native/Libraries/Core/setUpGlobals.js` polyfills to `'development'`.
// Vite's library build (`build.lib` in `vite.config.ts`, which is how this
// package builds) does not substitute the token at all, in either mode — see
// the ADR 0009 amendments for how that was verified. This ambient
// declaration exists only so the expression typechecks without pulling in
// `@types/node`, on every one of those platforms.
declare const process: { env: { NODE_ENV?: string } };

// Resolved once, at module load, into a plain boolean — not read as
// `process.env.NODE_ENV` at each call site — for a reason that isn't
// obvious from the shape alone: `typeof process !== 'undefined'` looks like
// the safe guard, but it is dead in every bundler. A bundler substitutes the
// *token* `process.env.NODE_ENV` with a literal; it does not define a
// `process` global for the browser. So after substitution the guard reads
// `typeof process !== 'undefined' && "development" !== 'production'` and
// `process` is still undefined at runtime — the whole block never runs, in
// bundled dev or bundled prod alike. A `try`/`catch` around the bare read
// gets all four cases right:
//   - bundled dev (`process.env.NODE_ENV` -> `"development"`): the token is
//     replaced before this ever runs, so the assignment reduces to
//     `"development" !== 'production'` with no `process` reference left to
//     throw — evaluates to `true`.
//   - bundled prod (`process.env.NODE_ENV` -> `"production"`): same
//     substitution, evaluates to `false`.
//   - unbundled ESM in a browser (no substitution, no `process` global at
//     all): the bare read throws a `ReferenceError`, caught below, and dev
//     warnings stay off rather than crashing the module.
//   - Node / vitest / Metro (a real `process` global): reads it directly,
//     same as any other Node code.
// This trades away one thing: a minifier can constant-fold the old bare
// `if (process.env.NODE_ENV !== 'production')` down to `if (false)` and
// delete the dead `console.warn` branch under a production define. Hoisting
// the check into a `try`/`catch`-assigned `let` here means minifiers no
// longer see a foldable boolean *expression* at the `timeScale` call site —
// only a runtime boolean read — so the warning string can survive into a
// production consumer bundle as unreachable dead code. That's the
// documented trade (see ADR 0009 amendments): a few hundred bytes of inert
// string is an acceptable price for the warning actually firing in dev.
let devWarningsEnabled: boolean;
try {
  devWarningsEnabled = process.env.NODE_ENV !== 'production';
} catch {
  // No `process` global at all (unbundled ESM in a browser): stay quiet
  // rather than throw.
  devWarningsEnabled = false;
}

/**
 * `blend`'s mix weight: a constant, or `(cell, t) => number` for a
 * spatially/temporally varying mix. A function receives the exact
 * `(cell, t)` the composed `Brightness` was called with.
 */
export type MixAmount = number | ((cell: Cell, t: number) => number);

/** A spatial-only predicate used by `mask`. Never sees `t` — masks are shape, not time. */
export type CellPredicate = (cell: Cell) => boolean;

/**
 * Wraps `t` into `[0, 1)` for essentially all inputs. Exception: for a tiny
 * negative `t` very close to a multiple of 1 (e.g. `-1e-20`), floating-point
 * rounding of `t - Math.floor(t)` lands exactly on `1.0` rather than `0`, so
 * the result can briefly touch the closed end. No preset or documented use
 * operates at that magnitude, periodicity is unaffected either way, and a
 * branch to special-case it does not belong in this hot path.
 */
function wrap01(t: number): number {
  return t - Math.floor(t);
}

/** Coerces a `Brightness` return value to a number: booleans become `1`/`0`. */
function toNumber(b: number | boolean): number {
  return typeof b === 'boolean' ? (b ? 1 : 0) : b;
}

/**
 * Linear mix of two brightnesses: `(1 - m) * a + m * b`. Written this way
 * (rather than `a + (b - a) * m`) so `m = 0` returns exactly `a` and
 * `m = 1` returns exactly `b` in floating point.
 *
 * Booleans from either source are coerced (`true` -> `1`, `false` -> `0`)
 * — the result is always a number, because a linear mix of two crisp masks
 * isn't itself crisp.
 *
 * `mix` as a function is evaluated as `mix(cell, t)` with the same
 * `(cell, t)` the composed brightness was called with — `blend` doesn't
 * transform time, so there's no second time domain to be confused about.
 * The result is *not* clamped to `[0, 1]`: a `mix` outside that range
 * extrapolates, which is a legitimate over/undershoot effect. Wrap the
 * result in `compose.clamp` if you want it bounded.
 */
export function blend(a: Brightness, b: Brightness, mix: MixAmount): Brightness {
  if (typeof mix === 'number') {
    const m = mix;
    return (cell, t) => (1 - m) * toNumber(a(cell, t)) + m * toNumber(b(cell, t));
  }
  const mixFn = mix;
  return (cell, t) => {
    const m = mixFn(cell, t);
    return (1 - m) * toNumber(a(cell, t)) + m * toNumber(b(cell, t));
  };
}

/**
 * Keeps `source` only where `predicate(cell)` is true; elsewhere returns
 * the boolean `false` (not the number `0`). `false` is unconditionally
 * not drawn — `0` merely happens not to clear a Bayer threshold, which is
 * only true because thresholds live in the open interval `(0, 1)`.
 *
 * An accepted cell's value passes through unchanged: a boolean source
 * stays boolean, a number stays a number. `predicate` takes only `cell`,
 * per the PRD — masks are spatial; a time-varying mask is `blend` with a
 * function `mix`.
 */
export function mask(source: Brightness, predicate: CellPredicate): Brightness {
  return (cell, t) => (predicate(cell) ? source(cell, t) : false);
}

// Non-integer factors are logged at most once per distinct factor value, so
// a re-render loop doesn't spam the console but two different bad factors
// are both reported. Lazily created so that in a production bundle — where
// `devWarningsEnabled` is `false` at runtime but, per the trade-off above,
// not necessarily eliminated by the minifier — this `Set` is at worst
// allocated-and-unused rather than pre-populated.
//
// Capped at MAX_WARNED_FACTORS distinct values: an animated or slider-bound
// factor (e.g. `compose.timeScale(sweep(), speed)` behind a range input)
// would otherwise warn — and retain a `Set` entry — once per distinct
// floating-point value it ever takes, which is unbounded. Past the cap,
// further non-integer factors are silently not warned about; the point of
// per-factor dedupe (surfacing a second, different mistake) is preserved for
// the common case of a handful of hand-written bad factors, without the
// unbounded growth. See ADR 0009 amendments.
let warnedTimeScaleFactors: Set<number> | undefined;
const MAX_WARNED_FACTORS = 8;

/**
 * Scales how fast `source` moves through its loop: `source(cell, t * factor)`,
 * wrapped back into `[0, 1)`.
 *
 * An **integer** `factor` keeps the loop seamless — `wrap01(factor) === 0`,
 * the same as `wrap01(0)`, so `f(cell, 0) === f(cell, 1)` still holds. A
 * non-integer factor breaks that contract (the wrapped end no longer lines
 * up with the wrapped start) and is a visible jump at the loop boundary;
 * this is deliberately *not* hidden by pre-wrapping `t`, so the discontinuity
 * shows up in a periodicity test instead of being papered over. In
 * development, a non-integer factor is logged once per distinct factor
 * value, up to a small cap of distinct values (further ones are silently
 * not warned about — this bounds the memory an animated or slider-bound
 * factor would otherwise retain).
 */
export function timeScale(source: Brightness, factor: number): Brightness {
  if (devWarningsEnabled) {
    if (!Number.isInteger(factor)) {
      warnedTimeScaleFactors ??= new Set();
      if (!warnedTimeScaleFactors.has(factor) && warnedTimeScaleFactors.size < MAX_WARNED_FACTORS) {
        warnedTimeScaleFactors.add(factor);
        console.warn(
          `compose.timeScale: factor ${factor} is not an integer, so the loop will visibly ` +
            `jump at t=0/t=1. Use an integer factor to keep the loop seamless.`,
        );
      }
    }
  }
  return (cell, t) => source(cell, wrap01(t * factor));
}

/**
 * Plays `source` backwards: `source(cell, 1 - t)`. Deliberately *not*
 * wrapped — wrapping would turn `t = 0` into `source(cell, 0)` instead of
 * `source(cell, 1)`, silently breaking reversal for an intentionally
 * non-periodic source like `presets.fill` (a reversed fill must start full
 * and drain, not start empty). For a periodic source `source(0) === source(1)`
 * anyway, so the unwrapped form is exactly periodic there too.
 */
export function reverse(source: Brightness): Brightness {
  return (cell, t) => source(cell, 1 - t);
}

/**
 * Shifts `source` in time by `dt` (looped): `source(cell, (t + dt) mod 1)`.
 * `dt` outside `[0, 1]`, including negative, wraps correctly.
 *
 * `t` is wrapped *before* adding `dt`, not just after: the naive
 * `wrap01(t + dt)` isn't exactly periodic in floating point (e.g. with
 * `dt = 0.3`, `1.3 - 1 === 0.30000000000000004` but `0.3 - 0 === 0.3`), so
 * `f(cell, 0) === f(cell, 1)` would fail an exact-equality check for most
 * `dt`. Wrapping `t` first makes `t = 1` and `t = 0` land on the identical
 * float, so periodicity is exact rather than approximate. Inside `[0, 1)`
 * the extra wrap is a no-op.
 */
export function offset(source: Brightness, dt: number): Brightness {
  const d = wrap01(dt);
  return (cell, t) => source(cell, wrap01(wrap01(t) + d));
}

/**
 * Inverts `source`: numbers become `1 - b`, booleans become `!b`. Not
 * clamped — `1 - b` of an out-of-range brightness stays out of range;
 * pipe through `compose.clamp` if you want it bounded.
 */
export function invert(source: Brightness): Brightness {
  return (cell, t) => {
    const b = source(cell, t);
    return typeof b === 'boolean' ? !b : 1 - b;
  };
}

/**
 * Bounds `source` to `[min, max]` (default `0..1`). Booleans are coerced
 * to `1`/`0` first — passing them through untouched would make `clamp` a
 * silent no-op on `presets.fill()`/`presets.gameOfLife()`, whereas
 * `clamp(fill(), 0, 0.5)` reading as "the lit part of the fill, at half
 * brightness" is both useful and what a caller would expect.
 *
 * Bounds are applied as `Math.min(max, Math.max(min, b))`, so if
 * `min > max` the `max` bound wins; this is documented rather than
 * validated.
 */
export function clamp(source: Brightness, min = 0, max = 1): Brightness {
  return (cell, t) => Math.min(max, Math.max(min, toNumber(source(cell, t))));
}

export const compose = { blend, mask, timeScale, reverse, offset, invert, clamp };
