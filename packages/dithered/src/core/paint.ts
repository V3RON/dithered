import type { Cell } from '../shape';
import type { Brightness, ResolvedOptions } from './options';

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
  fg: string;
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

/** Derives the per-cell drawing geometry for a surface of `width` x `height`. */
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

/**
 * Paints one frame's worth of cells: an optional background fill, then a
 * rounded square (or plain rect, if `roundRect` is unsupported) per cell
 * whose brightness clears its Bayer threshold.
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

  ctx.fillStyle = fg;
  for (const cell of cells) {
    const b = brightness(cell, phase);
    const draw = typeof b === 'boolean' ? b : b > cell.threshold;
    if (!draw) continue;

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
}
