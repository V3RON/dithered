import { resolveMatrix, thresholdFor, type DitherMatrix } from './matrix';

// Re-exported so existing deep imports of `BAYER_4` from `shape.ts` keep
// working now that the matrices live in `matrix.ts`.
export { BAYER_4 } from './matrix';
export type { DitherMatrix } from './matrix';

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
  /**
   * Ordered-dither threshold for this cell (see `matrix` in
   * `DitheredOptions`). In `(0, 1)` for every built-in matrix and for a
   * custom matrix in rank mode; a custom matrix in float mode may produce
   * exactly `0` (always drawn) or `1` (never drawn) — see `ResolvedMatrix`
   * in `matrix.ts`.
   */
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
 * shape's aspect ratio. `matrix` picks the ordered-dither threshold
 * pattern tiled across the grid (default `'bayer4'`) — resolved once up
 * front, so an invalid custom matrix throws here rather than per cell.
 */
export function sampleCells(
  shape: Shape,
  cols: number,
  hitTest: HitTester,
  rows: number = defaultRowsFor(shape, cols),
  matrix: DitherMatrix = 'bayer4',
): Cell[] {
  const { x, y, width, height } = shape.viewBox;
  const resolved = resolveMatrix(matrix);

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
          threshold: thresholdFor(resolved, i, j),
        });
      }
    }
  }
  return cells;
}
