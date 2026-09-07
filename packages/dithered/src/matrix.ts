import { BLUE_NOISE_16 } from './blue-noise.generated';

/**
 * Threshold pattern for the ordered dither: one of the built-in names, or
 * a caller-supplied 2D array of numbers.
 *
 * A custom array is normalized once, from the whole array: if every entry
 * is an integer it is read as **ranks** (divided by the entry count, the
 * `sampleCells`/today formula), otherwise every entry is read as a
 * **threshold** directly and must lie in `0..1`. This means an
 * all-integer 0/1 array like `[[0, 1], [1, 0]]` is read as ranks — not as
 * ready-made thresholds — because the rule is "are these integers", not
 * "do these look like a 0..1 range". Write `[[0.25, 0.75], [0.75, 0.25]]`
 * (a non-integer, and therefore unambiguous) if you want those two exact
 * thresholds.
 *
 * `'bayer2'`/`'bayer4'`/`'bayer8'` are the classic ordered-dither Bayer
 * matrices of the matching size; `'blueNoise'` is a precomputed 16x16
 * void-and-cluster table that removes the visible tiling Bayer matrices
 * show at high `cols`. Default `'bayer4'`.
 */
export type DitherMatrix =
  'bayer2' | 'bayer4' | 'bayer8' | 'blueNoise' | readonly (readonly number[])[];

/** A `DitherMatrix`, normalized to thresholds ready for `thresholdFor`. */
export interface ResolvedMatrix {
  readonly width: number;
  readonly height: number;
  /** Row-major, `height` rows of `width` thresholds, each in `(0, 1)` (rank mode) or `[0, 1]` (float mode). */
  readonly thresholds: readonly (readonly number[])[];
}

// Non-enumerable brand so `resolveMatrix` can recognize (and pass through)
// an already-resolved input without the marker showing up in `for...in`,
// `JSON.stringify`, or a deep-equal test against a plain object literal.
const RESOLVED = Symbol('dithered.resolvedMatrix');

interface BrandedResolvedMatrix extends ResolvedMatrix {
  readonly [RESOLVED]: true;
}

function isResolvedMatrix(value: unknown): value is BrandedResolvedMatrix {
  return typeof value === 'object' && value !== null && RESOLVED in value;
}

function brand(matrix: ResolvedMatrix): BrandedResolvedMatrix {
  return Object.defineProperty(matrix, RESOLVED, { value: true }) as BrandedResolvedMatrix;
}

/**
 * Recognizes a hand-built object that structurally matches `ResolvedMatrix`
 * (a plain `{ width, height, thresholds }`, not one of this module's own
 * branded values) so it can be validated on its own terms rather than
 * falling through to the "2D array of numbers" error. Only distinguishes
 * shape from a raw `DitherMatrix` array — `validateResolvedMatrixShape`
 * does the actual field validation.
 */
function looksLikeResolvedMatrix(value: unknown): value is ResolvedMatrix {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    'width' in value &&
    'height' in value &&
    'thresholds' in value
  );
}

/** Classic 2x2 Bayer ordered-dither matrix — the seed every other size is generated from. */
export const BAYER_2: readonly (readonly number[])[] = [
  [0, 2],
  [3, 1],
];

/**
 * Generates the `order x order` Bayer matrix by the standard
 * quadrant-block recurrence: each quadrant of `M_2n` is the previous
 * matrix `M_n` scaled by 4, offset by the matching `BAYER_2` corner.
 *
 * `M_2n[b*n + j][a*n + i] = 4 * M_n[j][i] + BAYER_2[b][a]` for
 * `a, b ∈ {0, 1}`. This is *not* the bit-interleaved recurrence
 * (`M_2n[2j+b][2i+a] = ...`) — that produces a different matrix that
 * does not match the classic tables.
 *
 * `order` must be a power of two, at least 2.
 */
export function bayerMatrix(order: number): readonly (readonly number[])[] {
  if (!Number.isInteger(order) || order < 2 || (order & (order - 1)) !== 0) {
    throw new Error(`dithered: bayerMatrix(order) requires a power of two >= 2, got ${order}.`);
  }
  if (order === 2) return BAYER_2;

  const half = order / 2;
  const smaller = bayerMatrix(half);
  const rows: number[][] = Array.from({ length: order }, () => new Array<number>(order));
  for (let b = 0; b < 2; b++) {
    for (let a = 0; a < 2; a++) {
      const offset = BAYER_2[b][a];
      for (let j = 0; j < half; j++) {
        for (let i = 0; i < half; i++) {
          rows[b * half + j][a * half + i] = 4 * smaller[j][i] + offset;
        }
      }
    }
  }
  return rows;
}

/** Classic 4x4 Bayer ordered-dither matrix, generated from {@link BAYER_2}. */
export const BAYER_4: readonly (readonly number[])[] = bayerMatrix(4);

/** Classic 8x8 Bayer ordered-dither matrix, generated from {@link BAYER_2}. */
export const BAYER_8: readonly (readonly number[])[] = bayerMatrix(8);

export { BLUE_NOISE_16 };

// ---------------------------------------------------------------------------
// resolution + validation
// ---------------------------------------------------------------------------

function isFiniteNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

/** Validates and normalizes a raw (name or array) matrix into a {@link ResolvedMatrix}. */
function validateAndResolve(matrix: readonly (readonly number[])[]): ResolvedMatrix {
  if (!Array.isArray(matrix) || !matrix.every((row) => Array.isArray(row))) {
    throw new Error(
      'dithered: matrix must be a 2D array of numbers or one of the built-in matrix names.',
    );
  }
  const height = matrix.length;
  if (height === 0) {
    throw new Error('dithered: matrix must have at least one row.');
  }
  const width = matrix[0].length;
  if (width === 0) {
    throw new Error('dithered: matrix must have at least one column.');
  }
  for (let j = 1; j < height; j++) {
    if (matrix[j].length !== width) {
      throw new Error(
        `dithered: matrix is ragged: row ${j} has ${matrix[j].length} entries, but row 0 has ${width}.`,
      );
    }
  }
  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      if (!isFiniteNumber(matrix[j][i])) {
        throw new Error(`dithered: matrix[${j}][${i}] is not a finite number.`);
      }
    }
  }

  // The integer/float decision is made once for the whole matrix, never
  // per entry — a mix of scales inside one table would be silently wrong
  // in a way no single-entry check could catch. See the `DitherMatrix` jsdoc.
  const allIntegers = matrix.every((row) => row.every((v) => Number.isInteger(v)));

  if (allIntegers) {
    const n = width * height;
    for (let j = 0; j < height; j++) {
      for (let i = 0; i < width; i++) {
        const v = matrix[j][i];
        if (v < 0 || v > n - 1) {
          throw new Error(
            `dithered: matrix[${j}][${i}] is ${v}, outside the rank range 0..${n - 1} for a ${width}x${height} matrix.`,
          );
        }
      }
    }
    const thresholds = matrix.map((row) => row.map((v) => (v + 0.5) / n));
    return { width, height, thresholds };
  }

  for (let j = 0; j < height; j++) {
    for (let i = 0; i < width; i++) {
      const v = matrix[j][i];
      if (v < 0 || v > 1) {
        throw new Error(
          `dithered: matrix[${j}][${i}] is ${v}, outside the range 0..1 for a matrix with fractional entries.`,
        );
      }
    }
  }
  const thresholds = matrix.map((row) => row.slice());
  return { width, height, thresholds };
}

/**
 * Validates a hand-built `ResolvedMatrix` object (as opposed to one this
 * module already branded) and returns a branded, defensively-copied
 * equivalent. `ResolvedMatrix` is a public, exported type, so a caller who
 * assembles one directly and hands it to `resolveMatrix`/`thresholdFor`
 * gets it checked and diagnosed as a resolved matrix — not misread as a
 * malformed 2D array, and not accepted unchecked just because it typechecks.
 */
function validateResolvedMatrixShape(input: ResolvedMatrix): BrandedResolvedMatrix {
  const { width, height, thresholds } = input;
  if (!Number.isInteger(width) || width < 1) {
    throw new Error(`dithered: resolved matrix width must be a positive integer, got ${width}.`);
  }
  if (!Number.isInteger(height) || height < 1) {
    throw new Error(`dithered: resolved matrix height must be a positive integer, got ${height}.`);
  }
  if (!Array.isArray(thresholds) || thresholds.length !== height) {
    const got = Array.isArray(thresholds) ? thresholds.length : typeof thresholds;
    throw new Error(
      `dithered: resolved matrix declares height ${height} but thresholds has ${got} rows.`,
    );
  }
  for (let j = 0; j < height; j++) {
    const row = thresholds[j];
    if (!Array.isArray(row) || row.length !== width) {
      const got = Array.isArray(row) ? row.length : typeof row;
      throw new Error(
        `dithered: resolved matrix declares width ${width} but thresholds[${j}] has ${got} entries.`,
      );
    }
    for (let i = 0; i < width; i++) {
      if (!isFiniteNumber(row[i])) {
        throw new Error(`dithered: resolved matrix thresholds[${j}][${i}] is not a finite number.`);
      }
    }
  }
  return brand({ width, height, thresholds: thresholds.map((row) => row.slice()) });
}

const BUILTIN_NAMES = ['bayer2', 'bayer4', 'bayer8', 'blueNoise'] as const;

function builtinMatrix(name: (typeof BUILTIN_NAMES)[number]): readonly (readonly number[])[] {
  switch (name) {
    case 'bayer2':
      return BAYER_2;
    case 'bayer4':
      return BAYER_4;
    case 'bayer8':
      return BAYER_8;
    case 'blueNoise':
      return BLUE_NOISE_16;
  }
}

// Memoized twice over, per the ADR: a `Map` keyed by name for the four
// built-ins (populated lazily, so validating one doesn't validate them
// all), and a `WeakMap` keyed by array identity for custom matrices, so
// `update({ matrix })` with a stable reference re-validates only once and
// holding the cache entry cannot leak the caller's array (it is garbage
// collected along with the array itself).
const namedCache = new Map<string, BrandedResolvedMatrix>();
const customCache = new WeakMap<readonly (readonly number[])[], BrandedResolvedMatrix>();
// Same identity-keyed memoization for a hand-built `ResolvedMatrix` object
// passed in unbranded (see `looksLikeResolvedMatrix`) — validating it is a
// cost worth paying once, not on every `thresholdFor` call.
const resolvedShapeCache = new WeakMap<object, BrandedResolvedMatrix>();

/**
 * Resolves a {@link DitherMatrix} — a built-in name, a raw array, or an
 * already-resolved {@link ResolvedMatrix} — into a `ResolvedMatrix` of
 * thresholds. Validates a raw array eagerly, throwing a `dithered: `
 * error naming the offending row/entry rather than failing per cell.
 *
 * Resolution is memoized (see the module-level caches above), so a caller
 * that resolves once up front and calls {@link thresholdFor} per cell —
 * as `sampleCells` does — pays a cache hit, not a revalidation. Passing
 * an already-resolved matrix back in (as `thresholdFor` does internally)
 * is recognized by a non-enumerable brand and returned unchanged, with no
 * cache lookup at all.
 */
export function resolveMatrix(input: DitherMatrix | ResolvedMatrix): ResolvedMatrix {
  if (isResolvedMatrix(input)) return input;
  // A hand-built object that structurally matches `ResolvedMatrix` but was
  // never returned by this module (so it lacks the brand) — `ResolvedMatrix`
  // is exported, so this is a real, typechecking way to call `resolveMatrix`.
  if (looksLikeResolvedMatrix(input)) {
    const cached = resolvedShapeCache.get(input);
    if (cached) return cached;
    const resolved = validateResolvedMatrixShape(input);
    resolvedShapeCache.set(input, resolved);
    return resolved;
  }
  // Only a plain `DitherMatrix` (string | array) survives past the checks
  // above — a `ResolvedMatrix` reaching this function is always branded or
  // structurally recognized, since `brand()` is the only place a branded
  // one is constructed.
  const matrix = input as DitherMatrix;

  if (typeof matrix === 'string') {
    if (!(BUILTIN_NAMES as readonly string[]).includes(matrix)) {
      throw new Error(
        `dithered: unknown matrix '${matrix}'. Expected 'bayer2', 'bayer4', 'bayer8', 'blueNoise', or a 2D array of numbers.`,
      );
    }
    const cached = namedCache.get(matrix);
    if (cached) return cached;
    const resolved = brand(
      validateAndResolve(builtinMatrix(matrix as (typeof BUILTIN_NAMES)[number])),
    );
    namedCache.set(matrix, resolved);
    return resolved;
  }

  const cachedCustom = customCache.get(matrix);
  if (cachedCustom) return cachedCustom;
  const resolved = brand(validateAndResolve(matrix));
  customCache.set(matrix, resolved);
  return resolved;
}

/**
 * Floored modulo: unlike `%`, always returns a value in `[0, n)` for a
 * negative `k`. Grid indices are never negative in this codebase, but
 * this keeps a negative index wrapping into a real cell rather than
 * indexing `undefined`.
 */
function wrap(k: number, n: number): number {
  return ((k % n) + n) % n;
}

/**
 * Looks up the dither threshold for grid cell `(i, j)`, tiling `matrix`
 * across the grid exactly like `BAYER_4` was tiled before this module
 * existed. `matrix` may be a name, a raw array, or an already-resolved
 * matrix (accepted so a caller who resolved once, e.g. `sampleCells`, can
 * pass the resolved value straight through).
 *
 * Note the axes: `j` (row) indexes into `height`, `i` (column) into
 * `width` — easy to get backwards on a non-square custom matrix.
 */
export function thresholdFor(matrix: DitherMatrix | ResolvedMatrix, i: number, j: number): number {
  const { width, height, thresholds } = resolveMatrix(matrix);
  return thresholds[wrap(j, height)][wrap(i, width)];
}
