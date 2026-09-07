import type { Brightness } from './core';
import type { Cell } from './shape';

// `process.env.NODE_ENV` below is a build-time convention every bundler
// (webpack, Vite, Rollup, Metro) statically replaces — not an actual Node
// global this platform-free library depends on. This ambient declaration
// exists only so the expression typechecks without pulling in `@types/node`.
// The `typeof process !== 'undefined'` guard at the call site (not here)
// keeps a plain, unbundled browser ESM import (no `process` global at all)
// from throwing a `ReferenceError` on a bare read.
declare const process: { env: { NODE_ENV?: string } } | undefined;

/**
 * `blend`'s mix weight: a constant, or `(cell, t) => number` for a
 * spatially/temporally varying mix. A function receives the exact
 * `(cell, t)` the composed `Brightness` was called with.
 */
export type MixAmount = number | ((cell: Cell, t: number) => number);

/** A spatial-only predicate used by `mask`. Never sees `t` — masks are shape, not time. */
export type CellPredicate = (cell: Cell) => boolean;

/** Wraps `t` into `[0, 1)`. */
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
// are both reported. Lazily created so a production bundle keeps only an
// unused `let` once this whole block is stripped (see below).
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
  if (typeof process !== 'undefined' && process.env.NODE_ENV !== 'production') {
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
