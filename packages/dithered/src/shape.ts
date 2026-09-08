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

/**
 * Tests whether a point, in a shape's own viewBox units, falls inside its
 * silhouette. This is the one piece of shape sampling that no platform
 * can provide portably — the browser has `Path2D` + `isPointInPath`,
 * React Native has Skia's `SkPath.contains` — so it is injected rather
 * than assumed.
 *
 * @see `domHitTester` in `dithered` and `skiaHitTester` in `dithered/react-native`.
 */
export type HitTester = (x: number, y: number) => boolean;

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

/** The row count that keeps cells roughly square for `cols` columns. */
export function defaultRowsFor(shape: Shape, cols: number): number {
  return Math.max(1, Math.round(cols / aspectOf(shape)));
}

/**
 * Samples a `cols` x `rows` grid of cell centres over `shape`'s viewBox,
 * keeping only the cells whose centre `hitTest` accepts.
 *
 * `rows` defaults to a value that keeps cells roughly square given the
 * shape's aspect ratio.
 */
export function sampleCells(
  shape: Shape,
  cols: number,
  hitTest: HitTester,
  rows: number = defaultRowsFor(shape, cols),
): Cell[] {
  const { x, y, width, height } = shape.viewBox;

  const cells: Cell[] = [];
  for (let j = 0; j < rows; j++) {
    for (let i = 0; i < cols; i++) {
      const px = x + ((i + 0.5) / cols) * width;
      const py = y + ((j + 0.5) / rows) * height;
      if (hitTest(px, py)) {
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
