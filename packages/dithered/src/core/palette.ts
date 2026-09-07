import { DEFAULTS } from './options';

/**
 * A single fill color, or an ordered set of tones from darkest to
 * brightest. See {@link toPalette} for how `DitheredOptions['fg']` is
 * normalized into this shape before painting.
 */
export type Palette = readonly string[];

/**
 * The CSS token that stands for the surrounding element's computed text
 * color, the way SVG's `currentColor` does. Recognized (case-insensitively,
 * as CSS keywords are) anywhere a palette entry can appear.
 *
 * Resolved by the web renderer — `createDithered`'s `configure()` and
 * `refreshColors()` — against `getComputedStyle(canvas).color`. There is no
 * cascade on `dithered/native`, so the native path rejects it outright
 * rather than silently painting black; see `useDitheredPictures`.
 */
export const CURRENT_COLOR = 'currentColor';

function isCurrentColorToken(color: string): boolean {
  return color.toLowerCase() === CURRENT_COLOR.toLowerCase();
}

/**
 * Normalizes `DitheredOptions['fg']` into an ordered palette of at least
 * one color, darkest first:
 *
 * - a single string becomes a one-element palette (`n === 1`, today's
 *   single-color behavior, byte-identical after this normalization — see
 *   {@link toneLevel});
 * - an array is copied as given, darkest first;
 * - an empty array has no sensible rendering, and throwing from inside a
 *   paint loop is worse than a documented fallback, so it becomes
 *   `[DEFAULTS.fg]`.
 */
export function toPalette(fg: string | Palette): Palette {
  if (typeof fg === 'string') return [fg];
  if (fg.length === 0) return [DEFAULTS.fg];
  return [...fg];
}

/** True if any entry of `palette` is the {@link CURRENT_COLOR} token. */
export function hasCurrentColor(palette: Palette): boolean {
  return palette.some(isCurrentColorToken);
}

/**
 * Replaces every {@link CURRENT_COLOR} entry in `palette` with `resolved`;
 * every other entry passes through unchanged.
 *
 * An empty `resolved` (a failed or unavailable `getComputedStyle` lookup)
 * falls back to `DEFAULTS.fg` rather than leaving the token unresolved,
 * which would reach the canvas as the literal string `'currentcolor'` and
 * paint opaque black.
 */
export function resolvePalette(palette: Palette, resolved: string): Palette {
  const fallback = resolved || DEFAULTS.fg;
  return palette.map((color) => (isCurrentColorToken(color) ? fallback : color));
}

/**
 * The palette level for a brightness value `b`, given a cell's Bayer
 * `threshold` and a palette of `tones` colors: `0` means skip the cell,
 * `k >= 1` means paint `palette[k - 1]`.
 *
 * The range is `0..tones` inclusive — not `0..tones - 1`, as a naive
 * reading of "draw tone `floor(b * tones)`" would suggest. "Not drawn" has
 * to be a level of its own for this to reduce to today's behavior at
 * `tones === 1`: both branches of the naive formula clamp to tone `0`, so
 * every cell would paint. With the `0..tones` range instead, `toneLevel(b,
 * t, 1)` is `1` (paint `palette[0]`) exactly when today's `b > t` is
 * `true`, and `0` (skip) exactly when it's `false` — see ADR 0005 §2 for
 * the full case-by-case proof, including `NaN`/negative/saturating `b`.
 *
 * Boolean brightness bypasses this formula entirely and is handled by the
 * caller (`paintFrame`): `true` is level `tones` (the brightest tone),
 * `false` is level `0`.
 */
export function toneLevel(b: number, threshold: number, tones: number): number {
  if (!(b > 0)) return 0; // 0, negatives and NaN skip, matching `b > threshold`
  if (b >= 1) return tones; // saturate at the brightest tone
  const level = b * tones;
  const base = Math.floor(level);
  return level - base <= threshold ? base : base + 1;
}
