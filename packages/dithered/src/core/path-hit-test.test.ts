import { describe, expect, it } from 'vitest';
import { defaultRowsFor, type Shape } from '../shape';
import { shapes } from '../shapes';
import { jsHitTester, pointInPolygons } from './path-hit-test';
import type { Point } from './path-geometry';

// ---------------------------------------------------------------------
// pointInPolygons
// ---------------------------------------------------------------------

const SQUARE: Point[] = [
  { x: 0, y: 0 },
  { x: 10, y: 0 },
  { x: 10, y: 10 },
  { x: 0, y: 10 },
];

// Same winding direction as the outer square: under the nonzero rule this
// carves a hole (windings agree -> +2, not zero, wait -- see below).
const HOLE_SAME_WINDING: Point[] = [
  { x: 3, y: 3 },
  { x: 7, y: 3 },
  { x: 7, y: 7 },
  { x: 3, y: 7 },
];

// Reversed winding relative to the outer square: opposing windings cancel
// under the nonzero rule, carving a hole.
const HOLE_OPPOSITE_WINDING: Point[] = [
  { x: 3, y: 3 },
  { x: 3, y: 7 },
  { x: 7, y: 7 },
  { x: 7, y: 3 },
];

describe('pointInPolygons', () => {
  it('reports a point inside a single polygon', () => {
    expect(pointInPolygons([SQUARE], 5, 5)).toBe(true);
  });

  it('reports a point outside a single polygon', () => {
    expect(pointInPolygons([SQUARE], 15, 5)).toBe(false);
  });

  it('nonzero: a hole with opposing winding is empty', () => {
    expect(pointInPolygons([SQUARE, HOLE_OPPOSITE_WINDING], 5, 5, 'nonzero')).toBe(false);
    // Still inside the ring around the hole.
    expect(pointInPolygons([SQUARE, HOLE_OPPOSITE_WINDING], 1, 1, 'nonzero')).toBe(true);
  });

  it('nonzero: a hole with agreeing winding stays filled (windings add, not cancel)', () => {
    expect(pointInPolygons([SQUARE, HOLE_SAME_WINDING], 5, 5, 'nonzero')).toBe(true);
  });

  it('evenodd: the "hole" is always empty regardless of winding direction', () => {
    expect(pointInPolygons([SQUARE, HOLE_OPPOSITE_WINDING], 5, 5, 'evenodd')).toBe(false);
    expect(pointInPolygons([SQUARE, HOLE_SAME_WINDING], 5, 5, 'evenodd')).toBe(false);
    expect(pointInPolygons([SQUARE, HOLE_OPPOSITE_WINDING], 1, 1, 'evenodd')).toBe(true);
  });

  it('classifies a point on a left edge as inside and the matching point on a right edge as outside', () => {
    // The ADR's own example of the half-open-in-y rule's effect: a vertex
    // (or edge) is treated consistently, so the two vertical edges of the
    // same square do not classify symmetrically.
    expect(pointInPolygons([SQUARE], 0, 5)).toBe(true);
    expect(pointInPolygons([SQUARE], 10, 5)).toBe(false);
  });

  it('classifies a point aligned with a vertex deterministically, per the half-open rule', () => {
    // (0,0) is a "pass-through" vertex whose non-horizontal neighbour
    // (0,10) sits above the ray: exactly one of its two edges is counted
    // as a crossing under `p0.y > y !== p1.y > y`, so the corner reads as
    // inside. (10,10) is the same shape of vertex on the opposite corner
    // and reads as outside. Using `>=` on both sides (the classic
    // double-counting mistake) either cancels or duplicates these
    // crossings and flips both answers — this pins the exact rule, not
    // just that *some* boolean comes back.
    expect(pointInPolygons([SQUARE], 0, 0)).toBe(true);
    expect(pointInPolygons([SQUARE], 10, 10)).toBe(false);
  });

  it('classifies a point aligned with a horizontal edge per the half-open rule', () => {
    // y = 0 coincides with the top edge (0,0)-(10,0), which is horizontal
    // and therefore never counted as a crossing under the half-open rule;
    // containment at that y is decided entirely by the two vertical
    // edges, the same way it is for the bottom edge at y = 10.
    expect(pointInPolygons([SQUARE], 5, 0)).toBe(true);
    expect(pointInPolygons([SQUARE], 5, 10)).toBe(false);
  });

  it('classifies a point on an edge shared between two subpaths consistently with each polygon alone', () => {
    // Two squares sharing the edge x = 10 ([0,10]x[0,10] and
    // [10,20]x[0,10]), probed at (10, 5): a coincident-edge case the ADR
    // calls out explicitly. `SQUARE` alone treats x = 10 as its (outside)
    // right edge; `SQUARE_RIGHT` alone treats x = 10 as its (inside) left
    // edge. Testing them together must be consistent with each shape's
    // own boundary rule, not silently double-count or drop the shared edge.
    const SQUARE_RIGHT: Point[] = [
      { x: 10, y: 0 },
      { x: 20, y: 0 },
      { x: 20, y: 10 },
      { x: 10, y: 10 },
    ];
    expect(pointInPolygons([SQUARE], 10, 5)).toBe(false);
    expect(pointInPolygons([SQUARE_RIGHT], 10, 5)).toBe(true);
    expect(pointInPolygons([SQUARE, SQUARE_RIGHT], 10, 5, 'nonzero')).toBe(true);
    expect(pointInPolygons([SQUARE, SQUARE_RIGHT], 10, 5, 'evenodd')).toBe(true);
  });

  it('defaults to nonzero', () => {
    expect(pointInPolygons([SQUARE, HOLE_SAME_WINDING], 5, 5)).toBe(
      pointInPolygons([SQUARE, HOLE_SAME_WINDING], 5, 5, 'nonzero'),
    );
  });
});

// ---------------------------------------------------------------------
// jsHitTester parity against independent analytic oracles
//
// jsdom implements no Path2D/isPointInPath (see the ADR's Consequences),
// so a literal comparison against `domHitTester` cannot run under
// vitest. Parity is instead checked against oracles whose geometry is
// hard-coded here, independent of `core/path.ts`. Where a runtime *does*
// provide a working Path2D/isPointInPath, the `domHitTester agreement`
// block below additionally checks that.
// ---------------------------------------------------------------------

function circleOracle(x: number, y: number): boolean {
  return (x - 50) ** 2 + (y - 50) ** 2 <= 40 ** 2;
}

function squareOracle(x: number, y: number): boolean {
  return x >= 10 && x <= 90 && y >= 10 && y <= 90;
}

function diamondOracle(x: number, y: number): boolean {
  return Math.abs(x - 50) + Math.abs(y - 50) <= 45;
}

// `rozenite`'s path is built entirely from H/V segments (see
// src/shapes.ts), so its silhouette is exactly a stack of axis-aligned
// horizontal bands, read directly off the path's own coordinates rather
// than through any point-in-polygon algorithm.
const ROZENITE_BANDS: readonly [number, number, number, number][] = [
  [2.667, 5.333, 14.667, 17.333],
  [5.333, 10.667, 12, 20],
  [10.667, 16, 9.333, 22.667],
  [16, 24, 6.667, 25.333],
  [24, 26.667, 9.333, 22.667],
  [26.667, 29.333, 12, 20],
];

function rozeniteOracle(x: number, y: number): boolean {
  return ROZENITE_BANDS.some(([y0, y1, x0, x1]) => y >= y0 && y <= y1 && x >= x0 && x <= x1);
}

// `heart`'s path (src/shapes.ts) is six cubic Bezier segments. The oracle
// solves each segment's y(t) = py analytically (Cardano's method) for
// crossings, rather than flattening or scanning — no code in common with
// `core/path.ts`'s recursive-subdivision flattener.
const HEART_SEGMENTS: readonly [Point, Point, Point, Point][] = [
  [
    { x: 50, y: 88 },
    { x: 20, y: 65 },
    { x: 5, y: 40 },
    { x: 5, y: 25 },
  ],
  [
    { x: 5, y: 25 },
    { x: 5, y: 10 },
    { x: 15, y: 0 },
    { x: 30, y: 0 },
  ],
  [
    { x: 30, y: 0 },
    { x: 42, y: 0 },
    { x: 50, y: 10 },
    { x: 50, y: 20 },
  ],
  [
    { x: 50, y: 20 },
    { x: 50, y: 10 },
    { x: 58, y: 0 },
    { x: 70, y: 0 },
  ],
  [
    { x: 70, y: 0 },
    { x: 85, y: 0 },
    { x: 95, y: 10 },
    { x: 95, y: 25 },
  ],
  [
    { x: 95, y: 25 },
    { x: 95, y: 40 },
    { x: 80, y: 65 },
    { x: 50, y: 88 },
  ],
];

function bezierValue(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return mt * mt * mt * p0 + 3 * mt * mt * t * p1 + 3 * mt * t * t * p2 + t * t * t * p3;
}

function bezierDerivative(p0: number, p1: number, p2: number, p3: number, t: number): number {
  const mt = 1 - t;
  return 3 * mt * mt * (p1 - p0) + 6 * mt * t * (p2 - p1) + 3 * t * t * (p3 - p2);
}

function clamp(v: number, lo: number, hi: number): number {
  return Math.max(lo, Math.min(hi, v));
}

/** Real roots of `a*t^3 + b*t^2 + c*t + d = 0`, via Cardano's method. */
function cubicRoots(a: number, b: number, c: number, d: number): number[] {
  const EPS = 1e-9;
  if (Math.abs(a) < EPS) return quadraticRoots(b, c, d);

  const pb = b / a;
  const pc = c / a;
  const pd = d / a;
  const shift = pb / 3;
  const p = pc - (pb * pb) / 3;
  const q = (2 * pb * pb * pb) / 27 - (pb * pc) / 3 + pd;
  const discriminant = (q * q) / 4 + (p * p * p) / 27;

  if (discriminant > EPS) {
    const sqrtDisc = Math.sqrt(discriminant);
    const u = Math.cbrt(-q / 2 + sqrtDisc);
    const v = Math.cbrt(-q / 2 - sqrtDisc);
    return [u + v - shift];
  }
  if (discriminant >= -EPS) {
    if (Math.abs(p) < EPS && Math.abs(q) < EPS) return [-shift];
    const u = Math.cbrt(-q / 2);
    return [2 * u - shift, -u - shift];
  }
  // Three distinct real roots (trigonometric form).
  const r = Math.sqrt((-p * p * p) / 27);
  const phi = Math.acos(clamp(-q / (2 * r), -1, 1));
  const m = 2 * Math.sqrt(-p / 3);
  return [0, 1, 2].map((k) => m * Math.cos((phi + 2 * Math.PI * k) / 3) - shift);
}

function quadraticRoots(b: number, c: number, d: number): number[] {
  if (Math.abs(b) < 1e-9) {
    return Math.abs(c) < 1e-9 ? [] : [-d / c];
  }
  const disc = c * c - 4 * b * d;
  if (disc < 0) return [];
  const s = Math.sqrt(disc);
  return [(-c + s) / (2 * b), (-c - s) / (2 * b)];
}

function heartOracle(px: number, py: number): boolean {
  let winding = 0;
  for (const [p0, p1, p2, p3] of HEART_SEGMENTS) {
    const a = -p0.y + 3 * p1.y - 3 * p2.y + p3.y;
    const b = 3 * p0.y - 6 * p1.y + 3 * p2.y;
    const c = -3 * p0.y + 3 * p1.y;
    const d = p0.y - py;
    for (const t of cubicRoots(a, b, c, d)) {
      if (t < -1e-7 || t > 1 + 1e-7) continue;
      const tc = clamp(t, 0, 1);
      const deriv = bezierDerivative(p0.y, p1.y, p2.y, p3.y, tc);
      if (Math.abs(deriv) < 1e-9) continue; // tangency, not a crossing
      const x = bezierValue(p0.x, p1.x, p2.x, p3.x, tc);
      if (x > px) winding += deriv > 0 ? 1 : -1;
    }
  }
  return winding !== 0;
}

interface ShapeCase {
  name: string;
  shape: Shape;
  oracle: (x: number, y: number) => boolean;
}

const CASES: ShapeCase[] = [
  { name: 'rozenite', shape: shapes.rozenite, oracle: rozeniteOracle },
  { name: 'circle', shape: shapes.circle, oracle: circleOracle },
  { name: 'square', shape: shapes.square, oracle: squareOracle },
  { name: 'diamond', shape: shapes.diamond, oracle: diamondOracle },
  { name: 'heart', shape: shapes.heart, oracle: heartOracle },
];

describe('jsHitTester parity against independent analytic oracles', () => {
  for (const { name, shape, oracle } of CASES) {
    for (const cols of [16, 64]) {
      it(`${name} at cols=${cols} agrees with the oracle at every sampled cell centre`, () => {
        const hitTest = jsHitTester(shape);
        const rows = defaultRowsFor(shape, cols);
        const { x, y, width, height } = shape.viewBox;

        const mismatches: string[] = [];
        for (let j = 0; j < rows; j++) {
          for (let i = 0; i < cols; i++) {
            const px = x + ((i + 0.5) / cols) * width;
            const py = y + ((j + 0.5) / rows) * height;
            const expected = oracle(px, py);
            const actual = hitTest(px, py);
            if (expected !== actual) {
              mismatches.push(
                `(i=${i}, j=${j}) at (${px.toFixed(3)}, ${py.toFixed(3)}): oracle=${expected}, jsHitTester=${actual}`,
              );
            }
          }
        }

        expect(mismatches, `mismatched cells:\n${mismatches.join('\n')}`).toEqual([]);
      });
    }
  }
});

// ---------------------------------------------------------------------
// domHitTester agreement (only where the runtime actually supports it)
// ---------------------------------------------------------------------

function domHitTesterIsUsable(): boolean {
  try {
    if (typeof document === 'undefined' || typeof Path2D === 'undefined') return false;
    const canvas = document.createElement('canvas');
    const ctx = canvas.getContext('2d');
    if (!ctx || typeof ctx.isPointInPath !== 'function') return false;
    const path = new Path2D('M0 0 L10 0 L10 10 L0 10 Z');
    // jsdom (no "canvas" package installed) returns a context whose
    // isPointInPath either throws or is not backed by real rasterization;
    // a working implementation reports the centre of that square as inside.
    return ctx.isPointInPath(path, 5, 5) === true;
  } catch {
    return false;
  }
}

describe.runIf(domHitTesterIsUsable())('jsHitTester agrees with domHitTester', () => {
  it('agrees on every sampled cell centre, for every built-in shape', async () => {
    const { domHitTester } = await import('../hit-test');
    for (const { shape } of CASES) {
      const jsTest = jsHitTester(shape);
      const domTest = domHitTester(shape);
      const rows = defaultRowsFor(shape, 16);
      const { x, y, width, height } = shape.viewBox;
      for (let j = 0; j < rows; j++) {
        for (let i = 0; i < 16; i++) {
          const px = x + ((i + 0.5) / 16) * width;
          const py = y + ((j + 0.5) / rows) * height;
          expect(jsTest(px, py)).toBe(domTest(px, py));
        }
      }
    }
  });
});
