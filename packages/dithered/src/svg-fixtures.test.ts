import { describe, expect, it } from 'vitest';
import { sampleCells } from './shape';
import { shapeFromSvg } from './svg';
import { shapeFromSvgLite } from './svg-lite';
import { jsHitTester } from './test-utils';

/**
 * The PRD's acceptance-criteria fixtures (issue #10): a Figma-style icon
 * with `<rect rx>` inside a `<g transform>`, a `<circle>`-only icon, and a
 * `<polygon>` star. Each is checked two ways:
 *
 * - Parity: `shapeFromSvg` and `shapeFromSvgLite` agree on the exact same
 *   `Shape`, on every fixture (the parity test from #3, extended here).
 * - Sampling: `sampleCells` over the fixture selects exactly the same
 *   cells as `sampleCells` over a hand-converted `<path>` equivalent of
 *   the same icon. This — not a string comparison — is what survives an
 *   arc being baked as cubics under a transform.
 */
const COLS = 24;

function expectSameCells(a: ReturnType<typeof shapeFromSvg>, b: ReturnType<typeof shapeFromSvg>) {
  expect(sampleCells(a, COLS, jsHitTester(a))).toEqual(sampleCells(b, COLS, jsHitTester(b)));
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
