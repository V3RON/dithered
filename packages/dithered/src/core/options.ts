import { aspectOf, defaultRowsFor, type Cell, type Shape } from '../shape';

/**
 * Per-cell, per-frame brightness. `t` is the loop phase in `[0, 1)`.
 *
 * A `number` is compared against `cell.threshold` (drawn when
 * `brightness > threshold`), giving an ordered-dither look. A `boolean`
 * draws or skips the cell outright, bypassing the dither entirely.
 */
export type Brightness = (cell: Cell, t: number) => number | boolean;

export interface DitheredOptions {
  shape: Shape;
  brightness: Brightness;
  /** CSS px (web) / dp (native) height; width follows the shape's aspect ratio. Default 48. */
  size?: number;
  /** Grid columns. Default 16. */
  cols?: number;
  /** Grid rows. Defaults to a value derived from the shape's aspect ratio. */
  rows?: number;
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
   */
  fg?: string | string[];
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
}

export type ResolvedOptions = Required<DitheredOptions>;

// `fg` is narrowed back to `string` here (`ResolvedOptions.fg` is `string |
// string[]`, to allow a palette) since the default is always a single
// color — `toPalette`/`resolvePalette` in `./palette` lean on `DEFAULTS.fg`
// being a plain `string` fallback, not a union.
export const DEFAULTS: Omit<ResolvedOptions, 'shape' | 'brightness'> & { fg: string } = {
  size: 48,
  cols: 16,
  rows: 0, // 0 means "derive from aspect ratio" (see resolveRows)
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

export function resolveOptions(options: DitheredOptions): ResolvedOptions {
  return assignDefined(DEFAULTS as ResolvedOptions, options);
}

/** The grid row count, deriving one from the shape's aspect ratio when unset. */
export function resolveRows(opts: ResolvedOptions): number {
  return opts.rows > 0 ? opts.rows : defaultRowsFor(opts.shape, opts.cols);
}

/**
 * Width/height, in the caller's units, for a shape rendered at `size`.
 * Left unrounded: the web driver rounds only when setting the backing
 * store's integer pixel dimensions, and keeps the CSS size exact.
 */
export function surfaceSize(opts: ResolvedOptions, scale = 1): { width: number; height: number } {
  return {
    width: opts.size * aspectOf(opts.shape) * scale,
    height: opts.size * scale,
  };
}
