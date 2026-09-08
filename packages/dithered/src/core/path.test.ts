import { describe, expect, it } from 'vitest';
import { arcToCubics, parsePath, serializePath, toAbsolute, transformSegments } from './path';
import { IDENTITY } from './transform';

describe('parsePath', () => {
  it('tokenizes a simple absolute path', () => {
    expect(parsePath('M0 0 L10 0 L10 10 Z')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 0] },
      { command: 'L', values: [10, 10] },
      { command: 'Z', values: [] },
    ]);
  });

  it('accepts comma separators and no separators between signed numbers', () => {
    expect(parsePath('M0,0L10,0L-5-5Z')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 0] },
      { command: 'L', values: [-5, -5] },
      { command: 'Z', values: [] },
    ]);
  });

  it('expands implicit repeats of the current command', () => {
    expect(parsePath('L1 1 2 2 3 3')).toEqual([
      { command: 'L', values: [1, 1] },
      { command: 'L', values: [2, 2] },
      { command: 'L', values: [3, 3] },
    ]);
  });

  it('expands an implicit repeat of M into L, per spec', () => {
    expect(parsePath('M0 0 10 10 20 20')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 10] },
      { command: 'L', values: [20, 20] },
    ]);
    expect(parsePath('m0 0 10 10')).toEqual([
      { command: 'm', values: [0, 0] },
      { command: 'l', values: [10, 10] },
    ]);
  });

  it('preserves relative command case', () => {
    expect(parsePath('m1 1 l2 2')).toEqual([
      { command: 'm', values: [1, 1] },
      { command: 'l', values: [2, 2] },
    ]);
  });

  it('reads H and V with one argument', () => {
    expect(parsePath('M0 0 H10 V10')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'H', values: [10] },
      { command: 'V', values: [10] },
    ]);
  });

  it('reads arc flags packed with no separator', () => {
    // A common minifier/design-tool quirk: flags with no space before the next number.
    expect(parsePath('M0 0 A5 5 0 115 5')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'A', values: [5, 5, 0, 1, 1, 5, 5] },
    ]);
  });

  it('reads decimals and scientific notation', () => {
    expect(parsePath('M0.5 -1.25e2 L1e-2 .5')).toEqual([
      { command: 'M', values: [0.5, -125] },
      { command: 'L', values: [0.01, 0.5] },
    ]);
  });

  it('throws when the data does not start with a command', () => {
    expect(() => parsePath('10 10 L20 20')).toThrow();
  });

  it('throws on an unparseable number', () => {
    expect(() => parsePath('M0 x')).toThrow();
  });

  it('throws on a malformed arc flag', () => {
    expect(() => parsePath('M0 0 A5 5 0 2 0 5 5')).toThrow();
  });

  it('allows an explicit command right after Z', () => {
    expect(parsePath('M0 0 Z L1 1')).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'Z', values: [] },
      { command: 'L', values: [1, 1] },
    ]);
  });

  it('throws on an implicit repeat after Z (Z takes no arguments)', () => {
    expect(() => parsePath('M0 0 Z 1 1')).toThrow();
  });
});

describe('toAbsolute', () => {
  it('leaves already-absolute M/L unchanged', () => {
    expect(toAbsolute(parsePath('M0 0 L10 10'))).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 10] },
    ]);
  });

  it('converts relative commands using the running current point', () => {
    expect(toAbsolute(parsePath('m10 10 l5 5 l-2 3'))).toEqual([
      { command: 'M', values: [10, 10] },
      { command: 'L', values: [15, 15] },
      { command: 'L', values: [13, 18] },
    ]);
  });

  it('folds H and V into L using the current point', () => {
    expect(toAbsolute(parsePath('M0 0 H10 v5 h-3'))).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 0] },
      { command: 'L', values: [10, 5] },
      { command: 'L', values: [7, 5] },
    ]);
  });

  it('expands S into C, reflecting the previous C control point', () => {
    const segs = toAbsolute(parsePath('M0 0 C0 10 10 10 10 0 S20 -10 20 0'));
    expect(segs[2]).toEqual({ command: 'C', values: [10, -10, 20, -10, 20, 0] });
  });

  it('treats S after a non-cubic as a control point equal to the current point', () => {
    const segs = toAbsolute(parsePath('M0 0 L10 0 S20 10 20 0'));
    expect(segs[2]).toEqual({ command: 'C', values: [10, 0, 20, 10, 20, 0] });
  });

  it('expands T into Q, reflecting the previous Q control point', () => {
    const segs = toAbsolute(parsePath('M0 0 Q5 10 10 0 T20 0'));
    expect(segs[2]).toEqual({ command: 'Q', values: [15, -10, 20, 0] });
  });

  it('makes A absolute without altering its radii/flags', () => {
    expect(toAbsolute(parsePath('M0 0 a5 5 0 0 1 10 0'))).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'A', values: [5, 5, 0, 0, 1, 10, 0] },
    ]);
  });

  it('resets the current point to the subpath start on Z', () => {
    expect(toAbsolute(parsePath('M0 0 L10 10 Z l5 5'))).toEqual([
      { command: 'M', values: [0, 0] },
      { command: 'L', values: [10, 10] },
      { command: 'Z', values: [] },
      { command: 'L', values: [5, 5] },
    ]);
  });
});

describe('arcToCubics', () => {
  it('produces cubics whose endpoints trace the requested quarter-circle', () => {
    // A quarter circle of radius 10 from (10,0) to (0,10), sweeping through (~7.07, ~7.07).
    const cubics = arcToCubics(10, 0, 10, 10, 0, 0, 1, 0, 10);
    expect(cubics.length).toBeGreaterThanOrEqual(1);
    const last = cubics[cubics.length - 1];
    expect(last[4]).toBeCloseTo(0, 9);
    expect(last[5]).toBeCloseTo(10, 9);

    // Every on-curve point (start, joins, end) should sit on the circle of radius 10.
    let x = 10;
    let y = 0;
    for (const [, , , , ex, ey] of cubics) {
      expect(Math.hypot(ex, ey)).toBeCloseTo(10, 6);
      x = ex;
      y = ey;
    }
    expect(x).toBeCloseTo(0, 9);
    expect(y).toBeCloseTo(10, 9);
  });

  it('splits a large arc into multiple <=90deg cubics', () => {
    // A 270-degree sweep can't be a single cubic segment (>90deg).
    const cubics = arcToCubics(10, 0, 10, 10, 0, 1, 1, 0, -10);
    expect(cubics.length).toBeGreaterThan(1);
  });

  it('takes the short way (90deg, one segment) when the large-arc flag is 0, the long way (270deg, three segments) when it is 1', () => {
    const short = arcToCubics(10, 0, 10, 10, 0, 0, 1, 0, 10);
    const long = arcToCubics(10, 0, 10, 10, 0, 1, 1, 0, 10);
    expect(short.length).toBe(1);
    expect(long.length).toBe(3);
    // Both still end at the requested endpoint.
    expect(long[long.length - 1][4]).toBeCloseTo(0, 9);
    expect(long[long.length - 1][5]).toBeCloseTo(10, 9);
  });

  it('degenerates to a straight line when radii are zero', () => {
    expect(arcToCubics(0, 0, 0, 0, 0, 0, 1, 10, 10)).toEqual([
      [10 / 3, 10 / 3, 20 / 3, 20 / 3, 10, 10],
    ]);
  });

  it('degenerates to a straight line when start equals end', () => {
    expect(arcToCubics(5, 5, 10, 10, 0, 0, 1, 5, 5)).toEqual([[5, 5, 5, 5, 5, 5]]);
  });

  // The tests above only check that each cubic's *endpoints* land on the
  // ellipse — that passes even with a badly wrong Bézier bulge (e.g. the
  // `4/3*tan(delta/4)` control-point-length constant off by 30%), because
  // endpoints don't depend on the tangent-length construction at all.
  // These sample the curve *between* endpoints against the ellipse's own
  // parametric definition — independent of arcToCubics's own algorithm —
  // so a bad tangent length actually fails them. Verified by mutation:
  // scaling that constant by 1.3 pushes the max error from ~0.008 to
  // ~2.6 (circle) and from ~6e-5 to ~0.09 (rotated ellipse) — see the
  // finding-1 writeup in the PR/commit message for the full check.
  describe('midpoints trace the analytic ellipse, not just the endpoints', () => {
    function evalCubic(x0: number, y0: number, c: number[], t: number): [number, number] {
      const [x1, y1, x2, y2, x3, y3] = c;
      const mt = 1 - t;
      return [
        mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
        mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
      ];
    }

    it('stays on a circle of the requested radius along a 270deg (3-segment) sweep', () => {
      // Same arc as "splits a large arc into multiple <=90deg cubics" above,
      // but here every point *along* each cubic is checked, not just joins.
      const cubics = arcToCubics(10, 0, 10, 10, 0, 1, 1, 0, -10);
      let x = 10;
      let y = 0;
      for (const c of cubics) {
        for (let t = 0.1; t < 1; t += 0.1) {
          const [px, py] = evalCubic(x, y, c, t);
          expect(Math.hypot(px, py)).toBeCloseTo(10, 1); // within 0.05 of r=10
        }
        x = c[4];
        y = c[5];
      }
    });

    it('stays on a rotated, non-uniform ellipse (rx != ry, x-axis-rotation != 0)', () => {
      // Built from the ellipse's own parametric definition — a
      // *different* formula from arcToCubics's endpoint-to-center
      // construction — so this doesn't share any machinery with the
      // function under test beyond "what an ellipse point is".
      const cx = 5;
      const cy = -3;
      const rx = 20;
      const ry = 8;
      const phiDeg = 30;
      const phi = (phiDeg * Math.PI) / 180;
      const cosPhi = Math.cos(phi);
      const sinPhi = Math.sin(phi);
      const ellipsePoint = (theta: number): [number, number] => [
        cx + rx * Math.cos(theta) * cosPhi - ry * Math.sin(theta) * sinPhi,
        cy + rx * Math.cos(theta) * sinPhi + ry * Math.sin(theta) * cosPhi,
      ];
      const [x0, y0] = ellipsePoint(0.2);
      const [x1, y1] = ellipsePoint(3.5); // > 180deg away: exercises the large-arc split too

      const cubics = arcToCubics(x0, y0, rx, ry, phiDeg, 1, 1, x1, y1);
      let x = x0;
      let y = y0;
      for (const c of cubics) {
        for (let t = 0.1; t < 1; t += 0.1) {
          const [px, py] = evalCubic(x, y, c, t);
          // Undo the ellipse's rotation and normalize by its radii: a
          // point exactly on the ellipse lands at distance 1 from center.
          const dx = px - cx;
          const dy = py - cy;
          const lx = dx * cosPhi + dy * sinPhi;
          const ly = -dx * sinPhi + dy * cosPhi;
          const normalized = (lx / rx) ** 2 + (ly / ry) ** 2;
          expect(normalized).toBeCloseTo(1, 2); // within 0.005
        }
        x = c[4];
        y = c[5];
      }
    });
  });
});

describe('transformSegments', () => {
  it('is a no-op on M/L under the identity matrix', () => {
    const segs = toAbsolute(parsePath('M0 0 L10 10'));
    expect(transformSegments(segs, IDENTITY)).toEqual(segs);
  });

  it('translates M/L/C/Q points', () => {
    const segs = toAbsolute(parsePath('M0 0 L1 1 C1 2 3 4 5 6 Q1 1 2 2'));
    const t = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 100 };
    expect(transformSegments(segs, t)).toEqual([
      { command: 'M', values: [10, 100] },
      { command: 'L', values: [11, 101] },
      { command: 'C', values: [11, 102, 13, 104, 15, 106] },
      { command: 'Q', values: [11, 101, 12, 102] },
    ]);
  });

  it('leaves Z untouched', () => {
    const segs = toAbsolute(parsePath('M0 0 L1 1 Z'));
    const scaled = transformSegments(segs, { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 });
    expect(scaled[2]).toEqual({ command: 'Z', values: [] });
  });

  it('converts A to one or more C segments under any matrix, including identity', () => {
    const segs = toAbsolute(parsePath('M10 0 A10 10 0 0 1 0 10'));
    const out = transformSegments(segs, IDENTITY);
    expect(out.every((s) => s.command === 'M' || s.command === 'C')).toBe(true);
    expect(out[out.length - 1].values.slice(4)).toEqual([0, 10]);
  });

  it('scales a circular arc into an ellipse (exact under cubic conversion)', () => {
    const segs = toAbsolute(parsePath('M10 0 A10 10 0 0 1 0 10'));
    const scaled = transformSegments(segs, { a: 1, b: 0, c: 0, d: 2, e: 0, f: 0 });
    const last = scaled[scaled.length - 1];
    expect(last.values[4]).toBeCloseTo(0, 9);
    expect(last.values[5]).toBeCloseTo(20, 9);
  });

  it('restores the current point to the subpath start on Z, so a following A starts there', () => {
    // M 10 10, H/V to (20,20), Z back to (10,10), then a relative arc to (20,10).
    const segs = toAbsolute(parsePath('M 10 10 h 10 v 10 z a 5 5 0 0 1 10 0'));
    const out = transformSegments(segs, IDENTITY);
    const arcCubics = out.filter((s) => s.command === 'C');
    // Computed independently from the correct start point (10,10) — not
    // the pre-Z current point (20,20), which is the bug this guards.
    const expected = arcToCubics(10, 10, 5, 5, 0, 0, 1, 20, 10).map((values) => ({
      command: 'C',
      values,
    }));
    expect(arcCubics).toEqual(expected);
  });
});

describe('serializePath', () => {
  it('round-trips through parsePath -> serializePath -> parsePath to the same segments', () => {
    const d = 'M0 0 L10 0 L10 10 Z';
    expect(parsePath(serializePath(parsePath(d)))).toEqual(parsePath(d));
  });

  it('joins command letters and space-separated arguments, with no trailing space on Z', () => {
    expect(
      serializePath([
        { command: 'M', values: [1, 2] },
        { command: 'L', values: [3, 4] },
        { command: 'Z', values: [] },
      ]),
    ).toBe('M 1 2 L 3 4 Z');
  });

  it('rounds away floating-point noise', () => {
    expect(serializePath([{ command: 'L', values: [0.1 + 0.2] }])).toBe('L 0.3');
  });

  it('normalizes negative zero to 0', () => {
    expect(serializePath([{ command: 'L', values: [-0, 5] }])).toBe('L 0 5');
  });
});
