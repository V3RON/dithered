import { describe, expect, it } from 'vitest';
import { parsePath, toAbsolute } from './core/path';
import { sampleCells } from './shape';
import { shapeFromSvg } from './svg';
import { shapeFromSvgLite } from './svg-lite';
import { jsHitTester } from './test-utils';

/**
 * The PRD's acceptance-criteria fixtures (issue #10): a Figma-style icon
 * with `<rect rx>` inside a `<g transform>`, a `<circle>`-only icon, and a
 * `<polygon>` star. Each is checked several ways:
 *
 * - Parity: `shapeFromSvg` and `shapeFromSvgLite` agree on the exact same
 *   `Shape`, on every fixture (the parity test from #3, extended here).
 * - Sampling against a hand path: `sampleCells` over the fixture selects
 *   exactly the same cells as `sampleCells` over a hand-converted `<path>`
 *   equivalent of the same icon.
 * - Sampling against an analytic test (circle and rounded-rect fixtures
 *   only): the hand path above is *also* flattened by `arcToCubics` — the
 *   very function under test — so a systematic error in it (a wrong
 *   Bézier bulge, say) would distort both sides identically and cancel.
 *   These extra checks instead compare against membership computed
 *   directly from the circle/rounded-rect equations, with no path
 *   parsing or arc flattening on either side of the comparison.
 */
const COLS = 24;

function expectSameCells(a: ReturnType<typeof shapeFromSvg>, b: ReturnType<typeof shapeFromSvg>) {
  expect(sampleCells(a, COLS, jsHitTester(a))).toEqual(sampleCells(b, COLS, jsHitTester(b)));
}

/** Whether (x,y) falls inside a rect with (possibly) rounded corners, in its own coordinate frame. */
function insideRoundedRect(
  x: number,
  y: number,
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  rx: number,
  ry: number,
): boolean {
  if (x < x0 || x > x1 || y < y0 || y > y1) return false;
  const nearLeft = x < x0 + rx;
  const nearRight = x > x1 - rx;
  const nearTop = y < y0 + ry;
  const nearBottom = y > y1 - ry;
  if ((nearLeft || nearRight) && (nearTop || nearBottom)) {
    const cx = nearLeft ? x0 + rx : x1 - rx;
    const cy = nearTop ? y0 + ry : y1 - ry;
    return ((x - cx) / rx) ** 2 + ((y - cy) / ry) ** 2 <= 1;
  }
  return true;
}

describe('fixture: rounded rect inside a transformed group', () => {
  // <rect x=10 y=10 width=40 height=20 rx=6 ry=6>, wrapped in
  // <g transform="translate(60 30) rotate(90)">.
  const SVG = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <g transform="translate(60 30) rotate(90)">
        <rect x="10" y="10" width="40" height="20" rx="6" ry="6" />
      </g>
    </svg>
  `;

  // Hand-transformed equivalent: rotate(90) then translate(60,30) applied
  // directly to each corner/arc of the SVG2 rounded-rect equivalent path,
  // computed independently of `basicShapeToPath`/`transformSegments` — a
  // 90 degree rotation is a similarity transform, so each arc keeps its
  // rx/ry and simply gains 90 degrees of x-axis-rotation; straight edges
  // are written as `L` since which of H/V they'd be swaps under rotation.
  const HAND_PATH =
    'M 50 46 L 50 74 A 6 6 90 0 1 44 80 L 36 80 A 6 6 90 0 1 30 74 ' +
    'L 30 46 A 6 6 90 0 1 36 40 L 44 40 A 6 6 90 0 1 50 46 Z';
  const HAND_SHAPE = { path: HAND_PATH, viewBox: { x: 0, y: 0, width: 100, height: 100 } };

  it('shapeFromSvg and shapeFromSvgLite agree', () => {
    expect(shapeFromSvg(SVG)).toEqual(shapeFromSvgLite(SVG));
  });

  it('bakes the transform, so the raw path data is not the untransformed rect', () => {
    const { path } = shapeFromSvg(SVG);
    expect(path).not.toContain('M 16 10'); // the untransformed rect's first point
  });

  it('samples the same cells as the hand-transformed <path> equivalent', () => {
    expectSameCells(shapeFromSvg(SVG), HAND_SHAPE);
    expectSameCells(shapeFromSvgLite(SVG), HAND_SHAPE);
  });

  it('samples the same cells as an independent analytic membership test', () => {
    // Inverse of translate(60 30) rotate(90) — derived once, by hand, from
    // the forward matrix (x'=60-y, y'=x+30) — mapping a sampled point back
    // into the original, untransformed <rect>'s own coordinate frame,
    // where membership is the plain rounded-rect equation. No path
    // parsing or arc flattening anywhere in this check, on either side.
    const analyticHitTest = (px: number, py: number) =>
      insideRoundedRect(py - 30, 60 - px, 10, 10, 50, 30, 6, 6);

    const domShape = shapeFromSvg(SVG);
    const liteShape = shapeFromSvgLite(SVG);
    expect(sampleCells(domShape, COLS, jsHitTester(domShape))).toEqual(
      sampleCells(domShape, COLS, analyticHitTest),
    );
    expect(sampleCells(liteShape, COLS, jsHitTester(liteShape))).toEqual(
      sampleCells(liteShape, COLS, analyticHitTest),
    );
  });

  it('the baked corner curves themselves stay on a radius-6 circle, not just the coarse cell grid', () => {
    // A ~24x24 cell grid is coarse next to a radius-6 rounded corner: a
    // bulge error well outside tolerance can still land every sample the
    // same way as the true corner, so cell-sampling alone under-tests the
    // curve. This checks the baked path's own corner curves directly, the
    // same way path.test.ts checks arcToCubics's raw output, but through
    // the full loader pipeline (parse, bake the transform, re-parse).
    const { x0, y0, x1, y1, rx, ry } = { x0: 10, y0: 10, x1: 50, y1: 30, rx: 6, ry: 6 };
    const cornerCenters: [number, number][] = [
      [x0 + rx, y0 + ry],
      [x1 - rx, y0 + ry],
      [x1 - rx, y1 - ry],
      [x0 + rx, y1 - ry],
    ];
    // Inverse of translate(60 30) rotate(90): x=py-30, y=60-px (see the
    // analytic test above for the derivation).
    const toLocal = (px: number, py: number): [number, number] => [py - 30, 60 - px];

    const evalCubic = (x0c: number, y0c: number, c: number[], t: number): [number, number] => {
      const [x1c, y1c, x2c, y2c, x3c, y3c] = c;
      const mt = 1 - t;
      return [
        mt * mt * mt * x0c + 3 * mt * mt * t * x1c + 3 * mt * t * t * x2c + t * t * t * x3c,
        mt * mt * mt * y0c + 3 * mt * mt * t * y1c + 3 * mt * t * t * y2c + t * t * t * y3c,
      ];
    };

    const segs = toAbsolute(parsePath(shapeFromSvg(SVG).path));
    let cornersChecked = 0;
    let x = 0;
    let y = 0;
    for (const seg of segs) {
      if (seg.command === 'C') {
        for (let t = 0.1; t < 1; t += 0.1) {
          const [px, py] = evalCubic(x, y, seg.values, t);
          const [lx, ly] = toLocal(px, py);
          const distances = cornerCenters.map(([cx, cy]) => Math.hypot(lx - cx, ly - cy));
          expect(Math.min(...distances)).toBeCloseTo(rx, 1); // within 0.05 of radius 6
        }
        x = seg.values[4];
        y = seg.values[5];
        cornersChecked++;
      } else if (seg.values.length >= 2) {
        x = seg.values[seg.values.length - 2];
        y = seg.values[seg.values.length - 1];
      }
    }
    expect(cornersChecked).toBe(4); // one cubic per rounded corner
  });
});

describe('fixture: circle-only icon', () => {
  const SVG = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <circle cx="50" cy="50" r="30" />
    </svg>
  `;
  const HAND_SHAPE = {
    path: 'M 80 50 A 30 30 0 0 1 20 50 A 30 30 0 0 1 80 50 Z',
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
  };

  it('shapeFromSvg and shapeFromSvgLite agree', () => {
    expect(shapeFromSvg(SVG)).toEqual(shapeFromSvgLite(SVG));
  });

  it('converts to the exact two-arc equivalent path (no transform to bake, so nothing to differ)', () => {
    expect(shapeFromSvg(SVG)).toEqual(HAND_SHAPE);
  });

  it('samples the same cells as the hand-written <path> equivalent', () => {
    expectSameCells(shapeFromSvg(SVG), HAND_SHAPE);
    expectSameCells(shapeFromSvgLite(SVG), HAND_SHAPE);
  });

  it('samples the same cells as an independent analytic membership test', () => {
    // The plain circle equation — no path parsing or arc flattening, so
    // this doesn't share arcToCubics (or anything else) with the loader.
    const analyticHitTest = (px: number, py: number) => (px - 50) ** 2 + (py - 50) ** 2 <= 30 * 30;

    const domShape = shapeFromSvg(SVG);
    const liteShape = shapeFromSvgLite(SVG);
    expect(sampleCells(domShape, COLS, jsHitTester(domShape))).toEqual(
      sampleCells(domShape, COLS, analyticHitTest),
    );
    expect(sampleCells(liteShape, COLS, jsHitTester(liteShape))).toEqual(
      sampleCells(liteShape, COLS, analyticHitTest),
    );
  });
});

describe('fixture: polygon star', () => {
  const POINTS = '50,5 61,35 95,35 68,57 79,91 50,70 21,91 32,57 5,35 39,35';
  const SVG = `
    <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
      <polygon points="${POINTS}" />
    </svg>
  `;
  const HAND_SHAPE = {
    path: 'M 50 5 L 61 35 L 95 35 L 68 57 L 79 91 L 50 70 L 21 91 L 32 57 L 5 35 L 39 35 Z',
    viewBox: { x: 0, y: 0, width: 100, height: 100 },
  };

  it('shapeFromSvg and shapeFromSvgLite agree', () => {
    expect(shapeFromSvg(SVG)).toEqual(shapeFromSvgLite(SVG));
  });

  it('converts to the exact M/L.../Z equivalent path', () => {
    expect(shapeFromSvg(SVG)).toEqual(HAND_SHAPE);
  });

  it('samples the same cells as the hand-written <path> equivalent', () => {
    expectSameCells(shapeFromSvg(SVG), HAND_SHAPE);
    expectSameCells(shapeFromSvgLite(SVG), HAND_SHAPE);
  });
});

/**
 * Characterization tests for a known, documented limitation (ADR 0010's
 * Consequences, and the README's "Known limitation" note) — NOT a
 * statement that this behavior is desirable. Concatenating every
 * element's geometry into one path string means overlapping regions of
 * *separately filled* elements cancel instead of union: SVG paints each
 * element's own area solid regardless of what else covers it, but the
 * merged path's winding (or, under evenodd, its crossing parity) does
 * not. These tests pin down today's actual output so a future change to
 * it is a deliberate decision, not a silent regression; they are not
 * something to "fix" as part of the findings above.
 */
describe('known limitation: concatenation is not a union of independently-filled elements', () => {
  it('nonzero: an opposite-winding element punches a hole where it overlaps a same-rule sibling', () => {
    // <rect> emits its path clockwise (right, down, left, back to start —
    // see svg-shapes.ts); this <path> traces the same kind of square
    // counter-clockwise (down, right, up, back to start). SVG renders
    // both solid; concatenated under nonzero, the overlap's winding
    // numbers cancel to 0.
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect x="10" y="10" width="60" height="60" />
        <path d="M40 40 L40 90 L90 90 L90 40 Z" />
      </svg>
    `;
    const shape = shapeFromSvg(svg);
    expect(shape.fillRule).toBeUndefined(); // both elements are (implicitly) nonzero
    const hit = jsHitTester(shape);
    expect(hit(20, 20)).toBe(true); // inside the rect only
    expect(hit(80, 80)).toBe(true); // inside the path only
    expect(hit(50, 50)).toBe(false); // inside both — a real renderer paints this solid
  });

  it('evenodd: any overlap between two elements becomes a hole, even with matching winding', () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <rect x="10" y="10" width="60" height="60" fill-rule="evenodd" />
        <rect x="40" y="40" width="50" height="50" fill-rule="evenodd" />
      </svg>
    `;
    const shape = shapeFromSvg(svg);
    expect(shape.fillRule).toBe('evenodd');
    const hit = jsHitTester(shape);
    expect(hit(20, 20)).toBe(true); // inside the first rect only
    expect(hit(80, 80)).toBe(true); // inside the second rect only
    expect(hit(50, 50)).toBe(false); // inside both — a real renderer paints this solid
  });
});
