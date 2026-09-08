import { describe, expect, it } from 'vitest';
import {
  arcToCubics,
  flattenPath,
  parsePath,
  pathToPolygons,
  type PathCommand,
  type Point,
} from './path-geometry';

describe('parsePath', () => {
  it('parses an absolute moveto + lineto', () => {
    expect(parsePath('M0 0 L10 20')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 20 },
    ]);
  });

  it('resolves relative commands against the running current point', () => {
    expect(parsePath('m10 10 l5 5 l-2 3')).toEqual([
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 15, y: 15 },
      { type: 'L', x: 13, y: 18 },
    ]);
  });

  it('treats a leading relative moveto as absolute', () => {
    expect(parsePath('m10 20 l1 1')).toEqual([
      { type: 'M', x: 10, y: 20 },
      { type: 'L', x: 11, y: 21 },
    ]);
  });

  it('expands the moveto-repeat special case into an initial moveto plus implicit linetos', () => {
    expect(parsePath('M0 0 10 10 20 20')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 20, y: 20 },
    ]);
  });

  it('expands a relative moveto repeat into relative implicit linetos', () => {
    expect(parsePath('m0 0 10 10 10 10')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'L', x: 20, y: 20 },
    ]);
  });

  it('expands implicit repeats of a plain lineto', () => {
    expect(parsePath('M0 0 L10 0 20 0 30 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 20, y: 0 },
      { type: 'L', x: 30, y: 0 },
    ]);
  });

  it('expands H and V into L, absolute and relative', () => {
    expect(parsePath('M5 5 H15 V25 h-5 v-5')).toEqual([
      { type: 'M', x: 5, y: 5 },
      { type: 'L', x: 15, y: 5 },
      { type: 'L', x: 15, y: 25 },
      { type: 'L', x: 10, y: 25 },
      { type: 'L', x: 10, y: 20 },
    ]);
  });

  it('parses an absolute cubic', () => {
    expect(parsePath('M0 0 C1 2 3 4 5 6')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'C', x1: 1, y1: 2, x2: 3, y2: 4, x: 5, y: 6 },
    ]);
  });

  it('resolves S by reflecting the previous C control point', () => {
    // Previous C ends at (10,0) with second control point (8,0); the
    // reflection of (8,0) across (10,0) is (12,0).
    expect(parsePath('M0 0 C2 0 8 0 10 0 S18 0 20 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'C', x1: 2, y1: 0, x2: 8, y2: 0, x: 10, y: 0 },
      { type: 'C', x1: 12, y1: 0, x2: 18, y2: 0, x: 20, y: 0 },
    ]);
  });

  it('uses the current point as the reflected control when S does not follow a curve', () => {
    expect(parsePath('M0 0 L10 0 S18 0 20 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'C', x1: 10, y1: 0, x2: 18, y2: 0, x: 20, y: 0 },
    ]);
  });

  it('parses an absolute quadratic', () => {
    expect(parsePath('M0 0 Q5 10 10 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 5, y1: 10, x: 10, y: 0 },
    ]);
  });

  it('resolves T by reflecting the previous Q control point', () => {
    // Previous Q ends at (10,0) with control (5,10); reflection is (15,-10).
    expect(parsePath('M0 0 Q5 10 10 0 T20 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'Q', x1: 5, y1: 10, x: 10, y: 0 },
      { type: 'Q', x1: 15, y1: -10, x: 20, y: 0 },
    ]);
  });

  it('uses the current point as the reflected control when T does not follow a curve', () => {
    expect(parsePath('M0 0 L10 0 T20 0')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'Q', x1: 10, y1: 0, x: 20, y: 0 },
    ]);
  });

  it('chains T reflections off the previously reflected control point', () => {
    const commands = parsePath('M0 0 Q10 10 20 0 T40 0 T60 0');
    expect(commands).toHaveLength(4); // M, Q, then one Q per T
    // Second T (control reflects the first T's control, not the original Q's).
    expect(commands[3]).toMatchObject({ type: 'Q', x: 60, y: 0 });
  });

  it('parses number-grammar edge cases: leading/trailing decimal points', () => {
    expect(parsePath('M.5 5. L1 1')).toEqual([
      { type: 'M', x: 0.5, y: 5 },
      { type: 'L', x: 1, y: 1 },
    ]);
  });

  it('parses exponents', () => {
    expect(parsePath('M1e-3 2E2')).toEqual([{ type: 'M', x: 0.001, y: 200 }]);
  });

  it('splits numbers run together via a decimal point boundary (1.5.5 -> 1.5, 0.5)', () => {
    expect(parsePath('M1.5.5')).toEqual([{ type: 'M', x: 1.5, y: 0.5 }]);
  });

  it('splits numbers run together via a sign boundary (1-2 -> 1, -2)', () => {
    expect(parsePath('M0 0 L1-2')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 1, y: -2 },
    ]);
  });

  it('parses arc flags as single characters packed against adjacent numbers', () => {
    // "a5 5 0 1110 10" = rx5 ry5 rot0 large=1 sweep=1 x=10 y=10.
    const commands = parsePath('M0 0 a5 5 0 1110 10');
    expect(commands[0]).toEqual({ type: 'M', x: 0, y: 0 });
    expect(commands.length).toBeGreaterThan(1);
    const last = commands[commands.length - 1] as Extract<PathCommand, { type: 'C' }>;
    expect(last.type).toBe('C');
    expect(last.x).toBeCloseTo(10);
    expect(last.y).toBeCloseTo(10);
  });

  it('resumes a new subpath at the closed subpath start after Z', () => {
    expect(parsePath('M0 0 L10 0 L10 10 Z L5 5')).toEqual([
      { type: 'M', x: 0, y: 0 },
      { type: 'L', x: 10, y: 0 },
      { type: 'L', x: 10, y: 10 },
      { type: 'Z' },
      { type: 'L', x: 5, y: 5 },
    ]);
  });

  it('parses multiple subpaths', () => {
    const commands = parsePath('M0 0 L10 0 L10 10 Z M20 20 L30 20 Z');
    expect(commands.filter((c) => c.type === 'M')).toHaveLength(2);
    expect(commands.filter((c) => c.type === 'Z')).toHaveLength(2);
  });

  it('throws on empty input', () => {
    expect(() => parsePath('')).toThrow();
  });

  it('throws when the path does not start with a moveto', () => {
    expect(() => parsePath('L10 10')).toThrow(/moveto/);
  });

  it('throws naming the offset on malformed input', () => {
    try {
      parsePath('M0 0 X10 10');
      expect.unreachable();
    } catch (err) {
      expect(String(err)).toMatch(/offset \d+/);
    }
  });

  it('throws on an unterminated command missing operands', () => {
    expect(() => parsePath('M0 0 L10')).toThrow();
  });

  it('throws on an invalid arc flag', () => {
    expect(() => parsePath('M0 0 A5 5 0 2 0 10 10')).toThrow(/flag/);
  });
});

describe('arcToCubics', () => {
  it('produces a curve approximating a quarter circle', () => {
    // Quarter circle, radius 10, centred at origin: (10,0) -> (0,10).
    const commands = arcToCubics(10, 0, 10, 10, 0, false, true, 0, 10);
    expect(commands).toHaveLength(1);
    const c = commands[0] as Extract<PathCommand, { type: 'C' }>;
    expect(c.x).toBeCloseTo(0);
    expect(c.y).toBeCloseTo(10);
    // The curve should bow outward from the chord, roughly toward (10,10).
    expect(c.x1).toBeGreaterThan(5);
    expect(c.y2).toBeGreaterThan(5);
  });

  it('produces multiple segments for a half circle', () => {
    const commands = arcToCubics(10, 0, 10, 10, 0, false, true, -10, 0);
    expect(commands.length).toBeGreaterThanOrEqual(2);
    const last = commands[commands.length - 1] as Extract<PathCommand, { type: 'C' }>;
    expect(last.x).toBeCloseTo(-10);
    expect(last.y).toBeCloseTo(0);
  });

  it('produces multiple segments for a large near-full arc', () => {
    const commands = arcToCubics(10, 0, 10, 10, 0, true, true, 9.9, -1.41);
    expect(commands.length).toBeGreaterThanOrEqual(3);
  });

  it('degenerates to a line when rx or ry is 0', () => {
    expect(arcToCubics(0, 0, 0, 10, 0, false, true, 10, 10)).toEqual([{ type: 'L', x: 10, y: 10 }]);
    expect(arcToCubics(0, 0, 10, 0, 0, false, true, 10, 10)).toEqual([{ type: 'L', x: 10, y: 10 }]);
  });

  it('produces nothing when the endpoints coincide', () => {
    expect(arcToCubics(5, 5, 10, 10, 0, false, true, 5, 5)).toEqual([]);
  });

  it('scales up out-of-range radii per SVG F.6.6, reshaping the curve rather than only its snapped endpoint', () => {
    // Endpoints 20 apart on the x-axis; radius 1 is far too small to span
    // them, so F.6.6 must scale rx/ry up to 10 (exactly half the chord)
    // before building the arc — the resulting curve is a radius-10
    // semicircle bulging ~10 units off the chord. `arcToCubics` always
    // snaps its *final* endpoint onto the requested (x, y) regardless of
    // radius, so asserting only that endpoint (as this test used to)
    // passes even with the scaling step deleted; an unscaled radius-1 arc
    // would stay within ~1 unit of the chord everywhere else. Assert on
    // the curve's shape instead, via its flattened points.
    const start = { x: -10, y: 0 };
    const commands = arcToCubics(start.x, start.y, 1, 1, 0, false, true, 10, 0);
    const last = commands[commands.length - 1] as Extract<PathCommand, { type: 'C' }>;
    expect(last.x).toBeCloseTo(10);
    expect(last.y).toBeCloseTo(0);

    const polygon = flattenPath([{ type: 'M', x: start.x, y: start.y }, ...commands], 0.01)[0];
    const maxDistFromChord = Math.max(...polygon.map((p) => Math.abs(p.y)));
    expect(maxDistFromChord).toBeGreaterThan(8);
  });

  describe('largeArc/sweep flag combinations', () => {
    // rx=60, ry=45, rotated 40°, from (10,20) to (60,40) — chosen so the
    // four flag combinations produce genuinely different curves, unlike
    // the `(8,8,0,·,·,-10,0)` fixture this replaces, whose F.6.6 scaling
    // collapsed to the same semicircle for every `largeArc`/`sweep` pair
    // (only the endpoint snap made those four calls look distinct). Two
    // properties distinguish the four here: `largeArc` picks the major
    // vs. minor arc of the ellipse (very different arc length), and
    // `sweep` picks which side of the chord the arc bulges to (opposite
    // sign of the cross product of chord-vector and chord-to-midpoint).
    const start = { x: 10, y: 20 };
    const end = { x: 60, y: 40 };

    function flattenArc(largeArc: boolean, sweep: boolean): Point[] {
      const commands = arcToCubics(start.x, start.y, 60, 45, 40, largeArc, sweep, end.x, end.y);
      return flattenPath([{ type: 'M', x: start.x, y: start.y }, ...commands], 0.01)[0];
    }

    function arcLength(polygon: Point[]): number {
      let length = 0;
      for (let i = 1; i < polygon.length; i++) {
        length += Math.hypot(polygon[i].x - polygon[i - 1].x, polygon[i].y - polygon[i - 1].y);
      }
      return length;
    }

    it.each([
      [false, false, 1],
      [false, true, -1],
      [true, false, 1],
      [true, true, -1],
    ])(
      'largeArc=%s sweep=%s selects the correct arc and bulges to the correct side of the chord',
      (largeArc, sweep, expectedCrossSign) => {
        const polygon = flattenArc(largeArc, sweep);
        const last = polygon[polygon.length - 1];
        expect(last.x).toBeCloseTo(end.x);
        expect(last.y).toBeCloseTo(end.y);

        // The endpoint alone proves nothing: `arcToCubics` unconditionally
        // overwrites the last cubic's endpoint regardless of these flags.
        // Assert the two properties the flags actually control instead —
        // `largeArc` picks the major vs. minor arc (very different arc
        // length), `sweep` picks which side of the chord the curve bulges
        // to (the sign of the cross product of the chord vector and the
        // chord-to-midpoint vector).
        if (largeArc) {
          expect(arcLength(polygon)).toBeGreaterThan(200);
        } else {
          expect(arcLength(polygon)).toBeLessThan(100);
        }

        const mid = polygon[Math.floor(polygon.length / 2)];
        const chordX = end.x - start.x;
        const chordY = end.y - start.y;
        const cross = chordX * (mid.y - start.y) - chordY * (mid.x - start.x);
        expect(Math.sign(cross)).toBe(expectedCrossSign);
      },
    );

    it('largeArc selects the major arc, not the minor one', () => {
      for (const sweep of [false, true]) {
        expect(arcLength(flattenArc(true, sweep))).toBeGreaterThan(200);
        expect(arcLength(flattenArc(false, sweep))).toBeLessThan(100);
      }
    });

    it('sweep selects which side of the chord the arc bulges to', () => {
      const cross = (largeArc: boolean, sweep: boolean): number => {
        const polygon = flattenArc(largeArc, sweep);
        const mid = polygon[Math.floor(polygon.length / 2)];
        const chordX = end.x - start.x;
        const chordY = end.y - start.y;
        const midX = mid.x - start.x;
        const midY = mid.y - start.y;
        return chordX * midY - chordY * midX;
      };
      for (const largeArc of [false, true]) {
        expect(Math.sign(cross(largeArc, false))).not.toBe(Math.sign(cross(largeArc, true)));
      }
    });
  });

  it('sweep flag controls which side of the chord the arc bulges toward', () => {
    const sweepTrue = arcToCubics(10, 0, 8, 8, 0, false, true, -10, 0)[0] as Extract<
      PathCommand,
      { type: 'C' }
    >;
    const sweepFalse = arcToCubics(10, 0, 8, 8, 0, false, false, -10, 0)[0] as Extract<
      PathCommand,
      { type: 'C' }
    >;
    // Opposite sweep flags bulge to opposite sides of the x-axis.
    expect(Math.sign(sweepTrue.y1)).not.toBe(Math.sign(sweepFalse.y1));
  });
});

describe('flattenPath', () => {
  function circlePath(cx: number, cy: number, r: number): string {
    return `M${cx - r} ${cy} A${r} ${r} 0 1 0 ${cx + r} ${cy} A${r} ${r} 0 1 0 ${cx - r} ${cy} Z`;
  }

  it('flattens a circle to points all within tolerance of the true radius', () => {
    const tolerance = 0.05;
    const subpaths = flattenPath(parsePath(circlePath(50, 50, 40)), tolerance);
    expect(subpaths).toHaveLength(1);
    for (const p of subpaths[0]) {
      const dist = Math.hypot(p.x - 50, p.y - 50);
      expect(Math.abs(dist - 40)).toBeLessThan(tolerance * 4);
    }
  });

  it('bounds segment count rather than subdividing without limit', () => {
    const subpaths = flattenPath(parsePath(circlePath(50, 50, 40)), 0.025);
    expect(subpaths[0].length).toBeLessThan(2000);
    expect(subpaths[0].length).toBeGreaterThan(8);
  });

  it('terminates on a degenerate curve with coincident control points', () => {
    const commands: PathCommand[] = [
      { type: 'M', x: 5, y: 5 },
      { type: 'C', x1: 5, y1: 5, x2: 5, y2: 5, x: 5, y: 5 },
    ];
    // Single-point result is dropped as a degenerate subpath.
    expect(flattenPath(commands, 0.01)).toEqual([]);
  });

  it('increases point count as tolerance shrinks (monotonic)', () => {
    const commands = parsePath(circlePath(50, 50, 40));
    const coarse = flattenPath(commands, 2).flat().length;
    const fine = flattenPath(commands, 0.05).flat().length;
    expect(fine).toBeGreaterThan(coarse);
  });

  it('drops empty and single-point subpaths', () => {
    const commands: PathCommand[] = [
      { type: 'M', x: 0, y: 0 },
      { type: 'M', x: 10, y: 10 },
      { type: 'L', x: 20, y: 20 },
    ];
    const subpaths = flattenPath(commands, 0.1);
    expect(subpaths).toHaveLength(1);
    expect(subpaths[0]).toEqual([
      { x: 10, y: 10 },
      { x: 20, y: 20 },
    ]);
  });

  it('closes the current polygon at Z, so a drawing command with no intervening M starts a new subpath at the closed start point', () => {
    // Regression for a bug where `flattenPath`'s `Z` case reset the
    // current point but never closed off `current`, so `L5 -20` after the
    // `Z` was appended to the square's polygon instead of starting a new
    // one — producing a single five-point polygon with a bogus spike
    // above the square rather than two separate polygons.
    const subpaths = flattenPath(parsePath('M0 0 L10 0 L10 10 L0 10 Z L5 -20'), 0.01);
    expect(subpaths).toEqual([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
      [
        { x: 0, y: 0 },
        { x: 5, y: -20 },
      ],
    ]);
  });

  it('flattens straight lines without adding extra points', () => {
    const subpaths = flattenPath(parsePath('M0 0 L10 0 L10 10 L0 10 Z'), 0.1);
    expect(subpaths).toEqual([
      [
        { x: 0, y: 0 },
        { x: 10, y: 0 },
        { x: 10, y: 10 },
        { x: 0, y: 10 },
      ],
    ]);
  });
});

describe('pathToPolygons', () => {
  it('is equivalent to flattenPath(parsePath(d), tolerance)', () => {
    const d = 'M0 0 L10 0 L10 10 Z';
    expect(pathToPolygons(d, 0.1)).toEqual(flattenPath(parsePath(d), 0.1));
  });
});
