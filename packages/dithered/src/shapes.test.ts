import { describe, expect, it } from 'vitest';
import { sampleCells } from './shape';
import { check, circle, cross, diamond, heart, rozenite, shapes, square } from './shapes';

const ACCEPT_ALL = () => true;

describe('shapes', () => {
  it('exposes all seven named shapes', () => {
    expect(Object.keys(shapes).sort()).toEqual(
      ['check', 'circle', 'cross', 'diamond', 'heart', 'rozenite', 'square'].sort(),
    );
  });

  it.each(Object.entries(shapes))(
    '%s has a non-empty path and a positive-area viewBox',
    (_name, shape) => {
      expect(shape.path.length).toBeGreaterThan(0);
      expect(shape.viewBox.width).toBeGreaterThan(0);
      expect(shape.viewBox.height).toBeGreaterThan(0);
    },
  );

  it.each(Object.entries(shapes))(
    '%s samples a non-empty grid with an accept-all hit tester',
    (_name, shape) => {
      const cells = sampleCells(shape, 12, ACCEPT_ALL);
      expect(cells.length).toBeGreaterThan(0);
    },
  );

  it('rozenite matches the reference PATH_D and viewBox verbatim', () => {
    expect(rozenite.path).toBe(
      'M17.333 5.333H20V10.667H22.667V16H25.333V24H22.667V26.667H20V29.333H12' +
        'V26.667H9.333V24H6.667V16H9.333V10.667H12V5.333H14.667V2.667H17.333V5.333Z',
    );
    expect(rozenite.viewBox).toEqual({ x: 6.67, y: 2.67, width: 18.67, height: 26.67 });
  });

  it('exports the same objects both individually and via the `shapes` map', () => {
    expect(shapes.circle).toBe(circle);
    expect(shapes.square).toBe(square);
    expect(shapes.diamond).toBe(diamond);
    expect(shapes.heart).toBe(heart);
    expect(shapes.rozenite).toBe(rozenite);
    expect(shapes.check).toBe(check);
    expect(shapes.cross).toBe(cross);
  });

  it('check and cross share a viewBox, so transitionTo between them never resizes the grid', () => {
    expect(check.viewBox).toEqual(cross.viewBox);
  });
});

// ---------------------------------------------------------------------------
// Finding 6: the `'%s samples a non-empty grid'` test above (and its
// `ACCEPT_ALL` hit tester) never looks at `shape.path` at all — it only
// proves `sampleCells` returns `cols * rows` entries for *any* tester, so
// even a degenerate, zero-area path like `'M0 0 Z'` sails through it
// unnoticed. The PRD's "ship check and cross so they sample to a
// non-empty cell set" acceptance criterion needs a hit tester that
// actually consults the path geometry.
//
// `domHitTester` (the real one, backed by `Path2D`/`isPointInPath`) isn't
// usable here: jsdom has no canvas backend in this repo's test setup, so
// `Path2D` is polyfilled as an inert stand-in (see `test-setup.ts`) and
// `isPointInPath` doesn't exist to call. `check` and `cross` are both
// authored in exactly the `M`/`L`/`Z` subset of path syntax, though (no
// curves or arcs), so a small nonzero-winding point-in-polygon test over
// that subset is enough to verify them for real.
// ---------------------------------------------------------------------------

type Point = readonly [number, number];

/**
 * Parses an `M`/`L`/`Z`-only SVG path `d` string into its subpaths, each
 * an ordered list of vertices. Throws on any other command (or a
 * malformed argument list) rather than silently treating it as "outside
 * everywhere" — a path this helper can't parse should fail the test
 * loudly, not report a false negative.
 */
function parseLinearSubpaths(d: string): Point[][] {
  const subpaths: Point[][] = [];
  let current: Point[] | null = null;
  const commandRe = /([MLZ])([^MLZ]*)/g;
  let match: RegExpExecArray | null;
  while ((match = commandRe.exec(d))) {
    const cmd = match[1];
    if (cmd === 'Z') {
      current = null;
      continue;
    }
    const args = match[2].trim();
    const nums = args.length ? args.split(/[\s,]+/).map(Number) : [];
    if (nums.length !== 2 || nums.some((n) => Number.isNaN(n))) {
      throw new Error(`parseLinearSubpaths: cannot parse "${cmd}${match[2]}" in "${d}"`);
    }
    const point: Point = [nums[0]!, nums[1]!];
    if (cmd === 'M') {
      current = [point];
      subpaths.push(current);
    } else {
      if (!current) throw new Error(`parseLinearSubpaths: "L" before any "M" in "${d}"`);
      current.push(point);
    }
  }
  return subpaths;
}

/** Signed winding contribution of one closed polygon around `(x, y)`. */
function windingNumber(polygon: readonly Point[], x: number, y: number): number {
  let winding = 0;
  for (let k = 0; k < polygon.length; k++) {
    const [x1, y1] = polygon[k]!;
    const [x2, y2] = polygon[(k + 1) % polygon.length]!;
    const isLeftOfEdge = (x2 - x1) * (y - y1) - (x - x1) * (y2 - y1);
    if (y1 <= y) {
      if (y2 > y && isLeftOfEdge > 0) winding += 1; // upward crossing
    } else if (y2 <= y && isLeftOfEdge < 0) {
      winding -= 1; // downward crossing
    }
  }
  return winding;
}

/**
 * A real `HitTester` (nonzero winding rule, combining every subpath) for
 * paths written in the `M`/`L`/`Z` subset of SVG syntax — the same rule
 * `fill-rule: nonzero` applies in a real renderer, which is what keeps
 * `cross`'s two overlapping bars reading as filled at their intersection
 * rather than cancelling out the way an even-odd rule would.
 */
function nonzeroWindingHitTester(d: string): (x: number, y: number) => boolean {
  const subpaths = parseLinearSubpaths(d);
  return (x, y) => {
    let total = 0;
    for (const polygon of subpaths) total += windingNumber(polygon, x, y);
    return total !== 0;
  };
}

describe('check and cross sample their real silhouette (finding 6)', () => {
  it('the winding-number helper above actually discriminates inside from outside', () => {
    // Self-check against a plain square before trusting it below.
    const square = nonzeroWindingHitTester('M0 0 L10 0 L10 10 L0 10 Z');
    expect(square(5, 5)).toBe(true);
    expect(square(-1, 5)).toBe(false);
    expect(square(11, 5)).toBe(false);
  });

  it('a degenerate (zero-area) path samples to an empty grid', () => {
    // Guards the helper itself: swapping in a degenerate path (as the
    // review's reproduction did to `check.path`) must sample to nothing,
    // proving a wrong/degenerate `check`/`cross` path would fail the
    // tests below rather than sailing through them.
    const degenerate = nonzeroWindingHitTester('M0 0 Z');
    const cells = sampleCells({ path: 'M0 0 Z', viewBox: check.viewBox }, 16, degenerate);
    expect(cells).toHaveLength(0);
  });

  it('check samples to its real silhouette', () => {
    const cells = sampleCells(check, 16, nonzeroWindingHitTester(check.path));
    // Exact count, not just "non-empty" — pins the checkmark ribbon's
    // actual shape on a 16x16 grid, hand-verified against the shipped
    // path (`ACCEPT_ALL` above cannot distinguish this from an empty or
    // fully-filled grid at all, since it never looks at the path).
    expect(cells).toHaveLength(18);
  });

  it('cross samples to its real silhouette', () => {
    const cells = sampleCells(cross, 16, nonzeroWindingHitTester(cross.path));
    // Two diagonal bars cover more of the grid than the checkmark's
    // single ribbon — hand-verified against the shipped path.
    expect(cells).toHaveLength(84);
  });
});
