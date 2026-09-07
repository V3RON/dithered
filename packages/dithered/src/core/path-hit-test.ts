import type { FillRule, HitTester, Shape } from '../shape';
import { DEFAULT_TOLERANCE_DIVISOR, pathToPolygons, type Point } from './path-geometry';

export interface JsHitTesterOptions {
  /** Default `'nonzero'`, matching SVG's default `fill-rule`, `isPointInPath` and Skia's default winding fill. */
  fillRule?: FillRule;
  /** Flattening tolerance, in the shape's viewBox units. Defaults to `max(vb.width, vb.height) / DEFAULT_TOLERANCE_DIVISOR`. */
  tolerance?: number;
}

/**
 * Tests whether `(x, y)` is inside the polygons under the given fill
 * rule, by casting a ray along `y = py, x > px` and either accumulating
 * the winding number (`'nonzero'`) or counting crossing parity
 * (`'evenodd'`) across all polygons together — so a later polygon can
 * carve a hole out of an earlier one.
 *
 * Edges are treated as half-open in `y` (`(y0 > py) !== (y1 > py)`),
 * the standard watertight rule: a vertex shared by two edges is counted
 * exactly once, and a horizontal edge is never counted.
 */
export function pointInPolygons(
  polygons: readonly (readonly Point[])[],
  x: number,
  y: number,
  fillRule: FillRule = 'nonzero',
): boolean {
  let winding = 0;
  let crossings = 0;

  for (const poly of polygons) {
    const n = poly.length;
    if (n < 2) continue;
    for (let i = 0; i < n; i++) {
      const p0 = poly[i];
      const p1 = poly[(i + 1) % n];
      if (p0.y > y !== p1.y > y) {
        const t = (y - p0.y) / (p1.y - p0.y);
        const xIntersect = p0.x + t * (p1.x - p0.x);
        if (xIntersect > x) {
          crossings++;
          winding += p1.y > p0.y ? 1 : -1;
        }
      }
    }
  }

  return fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
}

/** `max(vb.width, vb.height) / DEFAULT_TOLERANCE_DIVISOR`, floored at `1e-9`. */
function defaultTolerance(viewBox: Shape['viewBox']): number {
  return Math.max(Math.max(viewBox.width, viewBox.height) / DEFAULT_TOLERANCE_DIVISOR, 1e-9);
}

/**
 * A pure-JS {@link HitTester}: flattens `shape.path` to polygons once
 * (via {@link pathToPolygons}) and tests each point against them with
 * {@link pointInPolygons}. Touches no DOM or platform API, so it runs in
 * Node, Web Workers and edge runtimes as well as the browser — and,
 * because both `domHitTester` and `skiaHitTester` rasterize to decide
 * containment while this computes it analytically, it is also what makes
 * `sampleCells` deterministic across platforms. This is why it is the
 * default hit tester for `sampleCells`, `renderToSvg` and
 * `renderToDataURL`; `domHitTester`/`skiaHitTester` remain available for
 * callers who specifically want canvas/Skia parity instead.
 *
 * A point that lies *exactly* on the silhouette boundary is classified
 * deterministically (see {@link pointInPolygons}) but that classification
 * is not guaranteed to match `Path2D` or Skia, both of which leave the
 * exact-boundary case to their rasterizers. In practice this never
 * matters for sampling: cell centres sit at `(i + 0.5) / cols` of the
 * viewBox, which does not land on any built-in shape's edge coordinates.
 */
export function jsHitTester(shape: Shape, options: JsHitTesterOptions = {}): HitTester {
  const fillRule = options.fillRule ?? 'nonzero';
  const tolerance = options.tolerance ?? defaultTolerance(shape.viewBox);
  const polygons = pathToPolygons(shape.path, tolerance);
  return (x, y) => pointInPolygons(polygons, x, y, fillRule);
}
