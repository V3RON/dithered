import type { Cell } from '../shape';
import { frameAt } from './paint';
import type { Brightness } from './options';

/**
 * Configures a `transitionTo()` morph. See {@link DitheredInstance.transitionTo}.
 */
export interface TransitionOptions {
  /** Duration of the morph in ms. Default 400. */
  duration?: number;
  /** Wait for the current loop to reach t=0 before starting. Default false. */
  onLoopEnd?: boolean;
}

export type ResolvedTransitionOptions = Required<TransitionOptions>;

export const TRANSITION_DEFAULTS: ResolvedTransitionOptions = {
  duration: 400,
  onLoopEnd: false,
};

/**
 * Progress, in `[0, 1]`, at which the last `exiting` cell (by rank) has
 * vacated. Kept below 1 so exiting cells are gone well before the morph
 * completes, rather than lingering to the very end.
 */
export const EXIT_END = 0.75;

/**
 * Progress, in `[0, 1]`, at which the first `entering` cell (by rank)
 * arrives. Kept above 0 so the canvas is never *only* newly-arriving
 * cells with nothing left of the outgoing shape in the opening frames.
 *
 * `EXIT_END` and `ENTER_START` overlap (`0.25 < 0.75`) by construction —
 * see {@link exitAt}/{@link enterAt} — which is what guarantees a
 * non-empty canvas at every `p`; see `transitionCells`.
 */
export const ENTER_START = 0.25;

/**
 * Coerces a {@link Brightness} return value to a numeric level for
 * blending. `true -> 1`, `false -> 0`. Exact for draw decisions: every
 * Bayer threshold lies strictly inside `(0, 1)`, so a coerced `true`
 * always clears its threshold (drawn) and a coerced `false` never does
 * (skipped) — blending never changes what a plain boolean would have
 * drawn on its own.
 */
export function toLevel(value: number | boolean): number {
  return typeof value === 'boolean' ? (value ? 1 : 0) : value;
}

/** Clamps `x` into `[0, 1]`. */
function clamp01(x: number): number {
  return Math.min(1, Math.max(0, x));
}

/**
 * Interpolates two {@link Brightness} functions at a shared loop phase
 * `t`: `mix = 0` reproduces `a`'s draw decisions exactly, `mix = 1`
 * reproduces `b`'s, and values in between linearly blend the coerced
 * levels (see {@link toLevel}). `mix` is clamped to `[0, 1]`.
 *
 * This is the minimal helper `transitionTo` needs for a brightness
 * crossfade — not a general combinator. Issue #9 (brightness combinators)
 * specifies a `blend` of its own; the two are expected to be reconciled
 * later, so this one is kept small and self-contained.
 */
export function blend(a: Brightness, b: Brightness, mix: number): Brightness {
  const m = clamp01(mix);
  return (cell, t) => {
    const av = toLevel(a(cell, t));
    const bv = toLevel(b(cell, t));
    return av + (bv - av) * m;
  };
}

/**
 * Like {@link blend}, but each side is sampled at its *own* phase (`ta`
 * for `a`, `tb` for `b`) rather than a shared `t`. This is what lets a
 * transition crossfade two loops without either one visibly jumping: the
 * outgoing side keeps ticking on exactly the clock it was already on, and
 * the incoming side is already on the clock the steady loop will use once
 * the morph completes.
 *
 * Internal to the transition machinery — built on the same
 * {@link toLevel} coercion and linear-interpolation primitives as
 * {@link blend}, just decoupled from a single shared `t`.
 */
export function blendPhases(
  a: Brightness,
  b: Brightness,
  mix: number,
  ta: number,
  tb: number,
): Brightness {
  const m = clamp01(mix);
  return (cell) => {
    const av = toLevel(a(cell, ta));
    const bv = toLevel(b(cell, tb));
    return av + (bv - av) * m;
  };
}

/** The three-way split of a cell-set morph from `from` to `to`. */
export interface CellDiff {
  /** Cells present in both sets (`A ∩ B`), using `to`'s cell objects. */
  shared: Cell[];
  /** `A \ B`, ordered ascending by Bayer threshold (ties by `(j, i)`). */
  exiting: Cell[];
  /** `B \ A`, ordered descending by Bayer threshold (ties by `(j, i)`). */
  entering: Cell[];
}

/** A cell's position in the sampled grid — the identity a diff matches on. */
function cellKey(cell: Cell): string {
  return `${cell.i},${cell.j}`;
}

function byThresholdAscending(a: Cell, b: Cell): number {
  return a.threshold - b.threshold || a.j - b.j || a.i - b.i;
}

function byThresholdDescending(a: Cell, b: Cell): number {
  return b.threshold - a.threshold || a.j - b.j || a.i - b.i;
}

/**
 * Partitions two cell sets — sampled onto the *same* grid, per ADR 0004 §2
 * — into the cells that stay (`shared`), leave (`exiting`) and arrive
 * (`entering`) when morphing from `from` to `to`.
 *
 * Cells are matched by grid position `(i, j)`, not object identity: two
 * shapes sampled with the same `cols`/`rows` produce cells with identical
 * `(u, v, threshold)` at a given `(i, j)`, since those only depend on the
 * grid, not the shape. `shared` deliberately keeps `to`'s cell objects
 * (not `from`'s) so a completed morph's cell set is exactly the one the
 * plain `update()` path would have sampled.
 *
 * `exiting` and `entering` are sorted by *complementary* Bayer order —
 * exiting ascending, entering descending — so the cells that leave first
 * are not the cells that arrive first: the morph reads as a dither churn
 * rather than one Bayer sweep played twice. See {@link exitAt}/
 * {@link enterAt} for how that ordering becomes a dissolve schedule.
 */
export function diffCells(from: readonly Cell[], to: readonly Cell[]): CellDiff {
  const toByKey = new Map<string, Cell>();
  for (const cell of to) toByKey.set(cellKey(cell), cell);

  const fromKeys = new Set<string>();
  const shared: Cell[] = [];
  const exiting: Cell[] = [];
  for (const cell of from) {
    const key = cellKey(cell);
    fromKeys.add(key);
    const match = toByKey.get(key);
    if (match) {
      shared.push(match);
    } else {
      exiting.push(cell);
    }
  }

  const entering: Cell[] = [];
  for (const cell of to) {
    if (!fromKeys.has(cellKey(cell))) entering.push(cell);
  }

  exiting.sort(byThresholdAscending);
  entering.sort(byThresholdDescending);

  return { shared, exiting, entering };
}

/**
 * Progress at which the `rank`-th (0-based) of `n` exiting cells vacates
 * the canvas: `p < exitAt(rank, n)` is when it is still drawn.
 *
 * Rank-based (not raw-threshold-based) on purpose: a small `exiting` set
 * whose thresholds all happened to sit low would, under a raw-threshold
 * schedule, vacate long before anything entered. Spacing evenly by rank
 * guarantees the *last* exiting cell survives until
 * `p = n/(n+1) * EXIT_END`, which is `>= EXIT_END / 2` for any `n >= 1` —
 * see {@link transitionCells} for why that overlap matters.
 */
export function exitAt(rank: number, n: number): number {
  return ((rank + 1) / (n + 1)) * EXIT_END;
}

/**
 * Progress at which the `rank`-th (0-based) of `m` entering cells arrives:
 * `p >= enterAt(rank, m)` is when it starts being drawn. Rank-based for
 * the same reason as {@link exitAt}: the *first* entering cell always
 * arrives at exactly `ENTER_START`, regardless of how the target shape's
 * thresholds happen to be distributed.
 */
export function enterAt(rank: number, m: number): number {
  return ENTER_START + (rank / m) * (1 - ENTER_START);
}

/**
 * The cells drawn at progress `p` of a morph: every `shared` cell, plus
 * whichever `exiting`/`entering` cells the dissolve schedule ( {@link
 * exitAt}/{@link enterAt} ) currently has on screen.
 *
 * `transitionCells(diff, 0)` is exactly `from`'s cell set (all of
 * `shared` + `exiting`, none of `entering` — the first `entering` cell
 * doesn't arrive until `ENTER_START > 0`) and `transitionCells(diff, 1)`
 * is exactly `to`'s (`shared` + `entering`, `exiting` fully gone since
 * `exitAt(...) < EXIT_END < 1` for every rank).
 *
 * The canvas is never empty for any `p` in `[0, 1]`: the last exiting
 * cell survives past `EXIT_END / 2` and the first entering cell arrives
 * at `ENTER_START < EXIT_END / 2`, so their windows overlap for any
 * non-empty `exiting`/`entering`; if one side is empty the other side (or
 * `shared`) covers the gap. This is a guarantee, not a statistical hope —
 * see the `transition.test.ts` sweep over `p`.
 */
export function transitionCells(diff: CellDiff, p: number): Cell[] {
  const { shared, exiting, entering } = diff;
  const result: Cell[] = shared.slice();

  const n = exiting.length;
  for (let rank = 0; rank < n; rank++) {
    if (p < exitAt(rank, n)) result.push(exiting[rank]);
  }

  const m = entering.length;
  for (let rank = 0; rank < m; rank++) {
    if (p >= enterAt(rank, m)) result.push(entering[rank]);
  }

  return result;
}

/** One side (outgoing or incoming) of a transition. */
export interface TransitionSide {
  /** Cells sampled on the transition's shared grid — see ADR 0004 §2. */
  cells: readonly Cell[];
  brightness: Brightness;
  /** Loop duration in ms, used to compute this side's own phase. */
  period: number;
  /** Frames per loop, used to compute this side's own phase. */
  frames: number;
}

/**
 * The pure "what to draw" surface of a morph in progress. Everything a
 * renderer needs to paint a transition frame, decoupled from wall-clock
 * scheduling and from the platform's drawing surface — see ADR 0004 §8.
 */
export interface Transition {
  /** Wall-clock progress in `[0, 1]`, clamped, for a given `now`. */
  progressAt(now: number): number;
  /** The cells to paint at progress `p` (see {@link transitionCells}). */
  cellsAt(p: number): Cell[];
  /**
   * The blended brightness function for progress `p`, with each side's
   * own loop phase computed from `now` (see {@link blendPhases}).
   */
  brightnessAt(p: number, now: number): Brightness;
}

/**
 * Builds a {@link Transition} morphing from `from` to `to`, starting at
 * wall-clock `startedAt` and running for `duration` ms. The cell diff is
 * computed once, up front, from `from.cells`/`to.cells` — both are
 * expected to already be sampled on the transition's shared (target)
 * grid, per ADR 0004 §2; `createTransition` itself is agnostic to how
 * they got that way.
 */
export function createTransition(
  from: TransitionSide,
  to: TransitionSide,
  startedAt: number,
  duration: number,
): Transition {
  const diff = diffCells(from.cells, to.cells);

  return {
    progressAt(now) {
      if (duration <= 0) return 1;
      return clamp01((now - startedAt) / duration);
    },
    cellsAt(p) {
      return transitionCells(diff, p);
    },
    brightnessAt(p, now) {
      // Each side keeps ticking on its own clock throughout the morph —
      // no stored phase offsets — so neither preset visibly jumps, at
      // either end. See `blendPhases`.
      const ta = frameAt(now, from.period, from.frames) / from.frames;
      const tb = frameAt(now, to.period, to.frames) / to.frames;
      return blendPhases(from.brightness, to.brightness, p, ta, tb);
    },
  };
}
