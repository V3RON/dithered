import type { Cell } from '../shape';
import type { Brightness, ResolvedOptions } from './options';
import { toneLevel, toPalette, type Palette } from './palette';

/**
 * The tiny slice of `CanvasRenderingContext2D` that painting needs.
 *
 * Deliberately free of DOM types (`fillStyle` is widened to
 * `string | object` rather than naming `CanvasGradient`/`CanvasPattern`)
 * so the interface — and everything that consumes it — typechecks in a
 * React Native project whose `lib` has no DOM. A real
 * `CanvasRenderingContext2D` still satisfies it.
 */
export interface PaintContext {
  fillStyle: string | object;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  roundRect?(x: number, y: number, w: number, h: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
}

export interface PaintGeometry {
  /** Cell size in surface units (device px on web, dp on native). */
  cellSize: number;
  /** Gap on each side of a cell, in surface units (already floored to a minimum). */
  gap: number;
  /** Corner radius, in surface units. */
  radius: number;
  /**
   * A single color (unchanged), or an ordered palette from darkest to
   * brightest — see `toPalette`/`toneLevel` in `./palette`. Widened from
   * `string` rather than replaced so every existing hand-built geometry
   * literal (`{ fg: '#000', ... }`) stays valid.
   */
  fg: string | Palette;
  bg: string;
  /** Canvas (or sprite-strip frame) width/height in surface units. */
  width: number;
  height: number;
  /** Horizontal offset to draw at, used when painting into a sprite strip. */
  ox?: number;
}

/**
 * Quantizes wall-clock time to a frame index in `[0, frames)`, looping
 * every `period` ms.
 */
export function frameAt(nowMs: number, period: number, frames: number): number {
  const phase = ((nowMs % period) + period) % period; // guard negative nowMs
  return Math.floor((phase / period) * frames) % frames;
}

/**
 * Derives the per-cell drawing geometry for a surface of `width` x
 * `height`, in CSS pixels on web and dp on native — the one unit every
 * caller now passes. `createDithered` reaches this through a device
 * transform rather than by scaling its arguments, so a coordinate
 * computed here needs no further correction to match `renderToSvg`'s.
 * The 0.6 minimum gap is therefore unambiguously 0.6 of that unit,
 * meaning the same physical size on every display.
 */
export function computeGeometry(
  opts: ResolvedOptions,
  width: number,
  height: number,
  ox = 0,
): PaintGeometry {
  const cellSize = width / opts.cols;
  return {
    cellSize,
    gap: Math.max(0.6, cellSize * opts.gap),
    radius: cellSize * opts.radius,
    fg: opts.fg,
    bg: opts.bg,
    width,
    height,
    ox,
  };
}

/** Draws one cell's rounded (or plain, if `roundRect` is unsupported) square. */
function drawCell(
  ctx: PaintContext,
  cell: Cell,
  ox: number,
  s: number,
  gap: number,
  radius: number,
): void {
  const w = s - gap * 2;
  const x = ox + cell.i * s + gap;
  const y = cell.j * s + gap;
  ctx.beginPath();
  if (typeof ctx.roundRect === 'function') {
    ctx.roundRect(x, y, w, w, radius);
  } else {
    ctx.rect(x, y, w, w);
  }
  ctx.fill();
}

/**
 * Paints one frame's worth of cells: an optional background fill, then a
 * rounded square (or plain rect, if `roundRect` is unsupported) per cell
 * whose brightness clears its dither threshold (Bayer, blue noise, or a
 * custom matrix — see `matrix` in `DitheredOptions`) — or, for a
 * multi-tone `fg`, whose quantized {@link toneLevel} is non-zero, in the
 * color of that level's tone.
 *
 * `brightness` is called exactly once per cell per frame regardless of
 * palette size — `gameOfLife` is stateful, and re-invoking it per tone
 * would both corrupt it and cost `n` times the work. For `n > 1` this
 * means a single pass bucketing cell indices by level, then one drawing
 * pass per non-empty bucket, so `fillStyle` is assigned at most `n` times
 * (plus once for `bg`). Cells keep their original relative order within a
 * bucket; since cells tile a non-overlapping grid, that reordering across
 * buckets can never change a pixel.
 *
 * A single color (`fg: string`, or a one-entry palette) instead takes the
 * original inline loop verbatim — no `toPalette`/`toneLevel` call, no
 * bucket array, and (for `fg: string`) no allocation at all. That keeps
 * this case's context-call sequence byte-for-byte identical to before
 * multi-tone palettes existed, which is what makes `fg: string` output
 * provably unchanged (ADR 0005 §2).
 */
export function paintFrame(
  ctx: PaintContext,
  cells: readonly Cell[],
  brightness: Brightness,
  phase: number,
  geometry: PaintGeometry,
): void {
  const { cellSize: s, gap, radius, fg, bg, width, height, ox = 0 } = geometry;

  if (bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(ox, 0, width, height);
  }

  if (typeof fg === 'string') {
    ctx.fillStyle = fg;
    for (const cell of cells) {
      const b = brightness(cell, phase);
      const draw = typeof b === 'boolean' ? b : b > cell.threshold;
      if (draw) drawCell(ctx, cell, ox, s, gap, radius);
    }
    return;
  }

  const palette = toPalette(fg);
  const tones = palette.length;

  if (tones === 1) {
    ctx.fillStyle = palette[0];
    for (const cell of cells) {
      const b = brightness(cell, phase);
      const draw = typeof b === 'boolean' ? b : b > cell.threshold;
      if (draw) drawCell(ctx, cell, ox, s, gap, radius);
    }
    return;
  }

  const buckets: Cell[][] = Array.from({ length: tones }, () => []);
  for (const cell of cells) {
    const b = brightness(cell, phase);
    const level = typeof b === 'boolean' ? (b ? tones : 0) : toneLevel(b, cell.threshold, tones);
    if (level > 0) buckets[level - 1].push(cell);
  }

  for (let level = 1; level <= tones; level++) {
    const bucket = buckets[level - 1];
    if (bucket.length === 0) continue;
    ctx.fillStyle = palette[level - 1];
    for (const cell of bucket) drawCell(ctx, cell, ox, s, gap, radius);
  }
}
