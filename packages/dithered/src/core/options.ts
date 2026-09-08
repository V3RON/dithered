import { aspectOf, defaultRowsFor, type Cell, type HitTester, type Shape } from '../shape';
import type { DitherMatrix } from '../matrix';

/**
 * Per-cell, per-frame brightness. `t` is the loop phase in `[0, 1)`.
 *
 * A `number` is compared against `cell.threshold` (drawn when
 * `brightness > threshold`), giving an ordered-dither look. A `boolean`
 * draws or skips the cell outright, bypassing the dither entirely.
 */
export type Brightness = (cell: Cell, t: number) => number | boolean;

/** CSS px (web) / dp (native) height, or `'fill'` to track the canvas's parent box (web only). */
export type Size = number | 'fill';

export interface DitheredOptions {
  shape: Shape;
  brightness: Brightness;
  /**
   * CSS px (web) / dp (native) height; width follows the shape's aspect
   * ratio. `'fill'` tracks the canvas's parent content box (contain-fit) —
   * web only, throws on native. Default 48.
   */
  size?: Size;
  /** Upper bound on the backing-store device pixel ratio. Default 3. Web only; native ignores it. */
  maxDpr?: number;
  /** Grid columns. Default 16. */
  cols?: number;
  /** Grid rows. Defaults to a value derived from the shape's aspect ratio. */
  rows?: number;
  /**
   * Ordered-dither threshold pattern: `'bayer2'`, `'bayer4'`, `'bayer8'`,
   * `'blueNoise'`, or a custom 2D array of numbers (see `DitherMatrix`).
   * Reach for `'bayer8'` or `'blueNoise'` at high `cols`, where the 4x4
   * Bayer tile repeats often enough to read as a checkerboard rather than
   * grain. Default `'bayer4'`.
   */
  matrix?: DitherMatrix;
  /** Frames per loop. Default 48. */
  frames?: number;
  /** Loop duration in ms. Default 2000. */
  period?: number;
  /**
   * A single fill color, or an ordered palette of tones from darkest to
   * brightest — a brightness value then dithers between adjacent tones
   * instead of just on/off. See `toneLevel` for the quantization rule.
   * `'currentColor'`, anywhere in a palette, resolves to the canvas's
   * computed text color; web only (`dithered/react` and `createDithered`),
   * rejected on `dithered/native`. Default '#000'.
   *
   * `readonly string[]` (not just `string[]`) so the exported `Palette`
   * type — itself `readonly string[]` — can be passed straight back in,
   * e.g. `fg={somePalette}` or `fg={['#a00', '#0a0'] as const}`. Safe
   * because every entry point copies the array before storing it
   * (`clonePaletteOption`/`toPalette`), so nothing here ever mutates the
   * caller's array regardless of its mutability.
   */
  fg?: string | readonly string[];
  /** Background fill, or 'transparent'. Default 'transparent'. */
  bg?: string;
  /**
   * Pre-render the loop into a sprite strip. 'auto' = on for size <= 120.
   * Default 'auto'. Web only — the native renderer always pre-records, see
   * `dithered/react-native`.
   */
  cache?: boolean | 'auto';
  /** Freeze the animation. Default false. */
  paused?: boolean;
  /** Gap between cells, as a fraction of cell size (min 0.6px). Default 0.09. */
  gap?: number;
  /** Corner radius, as a fraction of cell size. Default 0.14. */
  radius?: number;
  /** Render a single static frame when the platform reports reduced motion. Default true. */
  respectReducedMotion?: boolean;
  /** Frame drawn synchronously on create, so there is no blank flash. Default 0. */
  initialFrame?: number;
  /**
   * Point-in-path test used to sample cells. Defaults to `jsHitTester`
   * (see `sampleCells`); pass `domHitTester`/`skiaHitTester` to opt into
   * canvas/Skia rasterization instead.
   */
  hitTest?: HitTester;
}

// `hitTest` is deliberately excluded from the `Required<...>` half: unlike
// every other option it has no single resolved default value to assign —
// `sampleCells`'s own default (`jsHitTester(shape)`) needs the *resolved*
// shape, so it stays optional here and is applied at the sampling call
// site instead.
export type ResolvedOptions = Required<Omit<DitheredOptions, 'hitTest'>> & {
  hitTest?: HitTester;
};

// `fg` is narrowed back to `string` here (`ResolvedOptions.fg` is `string |
// readonly string[]`, to allow a palette) since the default is always a
// single color — `toPalette`/`resolvePalette` in `./palette` lean on
// `DEFAULTS.fg` being a plain `string` fallback, not a union. `hitTest` is
// excluded too — see the comment on `ResolvedOptions` above.
export const DEFAULTS: Omit<ResolvedOptions, 'shape' | 'brightness' | 'hitTest'> & {
  fg: string;
} = {
  size: 48,
  maxDpr: 3,
  cols: 16,
  rows: 0, // 0 means "derive from aspect ratio" (see resolveRows)
  matrix: 'bayer4',
  frames: 48,
  period: 2000,
  fg: '#000',
  bg: 'transparent',
  cache: 'auto',
  paused: false,
  gap: 0.09,
  radius: 0.14,
  respectReducedMotion: true,
  initialFrame: 0,
};

/**
 * Merges `patch` onto `base`, skipping any key whose value is `undefined`.
 *
 * A plain `{ ...base, ...patch }` spread would let an explicitly-passed
 * `undefined` (e.g. `{ fg: undefined }` — common when a caller forwards
 * an options object built from optional props) clobber a real value with
 * `undefined`, silently breaking rendering (an `undefined` `fg`/`bg`
 * leaves canvas `fillStyle` unset, which paints black; an `undefined`
 * `cols` makes cell size `NaN`, drawing nothing). Only an *absent* key
 * should fall through to `base`.
 */
export function assignDefined<T extends object>(base: T, patch: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value as T[keyof T];
    }
  }
  return result;
}

/**
 * Copies a caller-supplied `fg` array so it is never retained by
 * reference. ADR 0005 §1 normalizes `fg` into a palette "once, at the
 * edge" — this is that edge for a mutable `string[]`. Without it,
 * `createDithered(canvas, { fg: callerArray, ... })` (or
 * `instance.update({ fg: callerArray })`) followed by a later
 * `callerArray[i] = ...` would silently change what gets painted on some
 * future frame, with no `update()` call in sight — and whether that
 * mutation is observed immediately, on the next reconfigure, or never
 * would depend on whether the instance caches its sprite strip, which is
 * exactly the kind of behavior-varies-by-unrelated-setting bug a public
 * API shouldn't have. A `string` needs no copy: strings are immutable, so
 * aliasing one is harmless.
 */
export function clonePaletteOption(
  fg: string | readonly string[] | undefined,
): string | string[] | undefined {
  // `typeof`/`undefined` checks rather than `Array.isArray`: narrowing a
  // `readonly string[]` union member through an `Array.isArray` guard
  // doesn't eliminate it from the non-array branch (a `readonly` array
  // isn't assignable to the mutable `any[]` the guard narrows against), so
  // the else branch would keep the widened, un-copied type. This narrows
  // cleanly either way.
  return typeof fg === 'string' || fg === undefined ? fg : [...fg];
}

export function resolveOptions(options: DitheredOptions): ResolvedOptions {
  return assignDefined(DEFAULTS as ResolvedOptions, {
    ...options,
    fg: clonePaletteOption(options.fg),
  });
}

/** The grid row count, deriving one from the shape's aspect ratio when unset. */
export function resolveRows(opts: ResolvedOptions): number {
  return opts.rows > 0 ? opts.rows : defaultRowsFor(opts.shape, opts.cols);
}

/**
 * Width/height, in the caller's units, for a shape rendered at a resolved
 * `sizePx` (a plain number — never `'fill'`; resolve that first with
 * {@link resolveSizePx} or the web renderer's fill-fitting). Left
 * unrounded: the web driver rounds only when setting the backing store's
 * integer pixel dimensions, and keeps the CSS size exact.
 */
export function surfaceSize(
  sizePx: number,
  shape: Shape,
  scale = 1,
): { width: number; height: number } {
  return {
    width: sizePx * aspectOf(shape) * scale,
    height: sizePx * scale,
  };
}

/**
 * Resolves a {@link Size} to a plain pixel number, throwing on `'fill'`.
 *
 * `'fill'` needs a DOM parent to measure and is web-only; the web renderer
 * handles it directly rather than calling this. Everywhere else that
 * consumes a resolved size — natively, or in the platform-free core —
 * goes through this guard so the failure is a clear, immediate error
 * rather than `NaN` propagating through the geometry math.
 */
export function resolveSizePx(size: Size): number {
  if (size === 'fill') {
    throw new Error(
      "dithered: size: 'fill' is web-only; on native, size the <Canvas> through the style prop.",
    );
  }
  return size;
}

/**
 * Contain-fits a box of aspect ratio `aspect` (width / height) inside a
 * `contentWidth` x `contentHeight` box, returning the fitted height (the
 * quantity `size` represents throughout this library). Returns `0` for a
 * degenerate content box (either axis `<= 0`) or a non-finite/non-positive
 * aspect ratio, signaling "nothing to fit" rather than `NaN` or `Infinity`.
 *
 * Pure and DOM-free so it is directly unit-testable; the web renderer
 * supplies the actual parent measurement.
 */
export function fitSize(contentWidth: number, contentHeight: number, aspect: number): number {
  if (!(contentWidth > 0) || !(contentHeight > 0) || !Number.isFinite(aspect) || !(aspect > 0)) {
    return 0;
  }
  return Math.min(contentHeight, contentWidth / aspect);
}

/**
 * The device pixel ratio actually used for the backing store: the raw
 * ratio clamped to `maxDpr` (itself clamped to at least `1`). `raw` is
 * likewise floored to `1` when non-finite or non-positive, so a `0` or
 * unreadable `devicePixelRatio` never collapses the backing store.
 */
export function effectiveDpr(raw: number, maxDpr: number): number {
  const safeRaw = Number.isFinite(raw) && raw > 0 ? raw : 1;
  const safeMax = Number.isFinite(maxDpr) && maxDpr >= 1 ? maxDpr : 1;
  return Math.min(safeRaw, safeMax);
}
