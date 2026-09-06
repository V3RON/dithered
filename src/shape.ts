/**
 * A silhouette shape: an SVG path `d` string plus the viewBox it was
 * authored in. Cells are sampled in viewBox units, then interpreted in
 * normalized (-0.5..0.5) space for rendering.
 */
export interface Shape {
  path: string;
  viewBox: { x: number; y: number; width: number; height: number };
}

/** One sampled grid cell inside a shape's silhouette. */
export interface Cell {
  /** Column index (0-based, left to right). */
  i: number;
  /** Row index (0-based, top to bottom). */
  j: number;
  /** Cell centre, normalized across the shape's width, -0.5..0.5. */
  u: number;
  /** Cell centre, normalized down the shape's height, -0.5..0.5. */
  v: number;
  /** Bayer 4x4 ordered-dither threshold for this cell, in (0, 1). */
  threshold: number;
}

/** Classic 4x4 Bayer ordered-dither matrix. */
export const BAYER_4: readonly (readonly number[])[] = [
  [0, 8, 2, 10],
  [12, 4, 14, 6],
  [3, 11, 1, 9],
  [15, 7, 13, 5],
];

/** Aspect ratio (width / height) of a shape's viewBox. */
export function aspectOf(shape: Shape): number {
  return shape.viewBox.width / shape.viewBox.height;
}

/**
 * Samples a `cols` x `rows` grid of cell centres over `shape`'s viewBox,
 * keeping only the cells whose centre falls inside the shape's path.
 *
 * `rows` defaults to a value that keeps cells roughly square given the
 * shape's aspect ratio. A `CanvasRenderingContext2D` is used to test
 * point-in-path; if none is supplied, a throwaway canvas is created.
 */
export function sampleCells(
  shape: Shape,
  cols: number,
  rows: number = Math.max(1, Math.round(cols / aspectOf(shape))),
  ctx?: CanvasRenderingContext2D,
): Cell[] {
  const context = ctx ?? createScratchContext();
  const path = new Path2D(shape.path);
  const { x, y, width, height } = shape.viewBox;

  const cells: Cell[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const px = x + ((i + 0.5) / cols) * width;
      const py = y + ((j + 0.5) / rows) * height;
      if (context.isPointInPath(path, px, py)) {
        cells.push({
          i,
          j,
          u: (i + 0.5) / cols - 0.5,
          v: (j + 0.5) / rows - 0.5,
          threshold: (BAYER_4[j % 4][i % 4] + 0.5) / 16,
        });
      }
    }
  }
  return cells;
}

function createScratchContext(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('dithered: unable to create a 2D canvas context for sampling.');
  }
  return ctx;
}
