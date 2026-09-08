import { render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

interface FakeRect {
  x: number;
  y: number;
  width: number;
  height: number;
}
interface FakeRRect {
  rect: FakeRect;
  rx: number;
  ry: number;
}

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

vi.mock('react-native-reanimated', () => ({
  useFrameCallback: vi.fn(() => ({ setActive: vi.fn() })),
  useReducedMotion: vi.fn(() => false),
  useSharedValue: vi.fn(<T,>(initial: T) => ({ value: initial })),
}));

// The same recording-Skia recipe `pictures.test.ts` uses for the
// shape/paint side, plus minimal stand-ins for the two Skia *components*
// `Dithered` renders: `Canvas` just renders its children, and `Picture`
// draws the picture it is handed into a fake canvas immediately and
// renders the resulting draw count as text — so a test can read out how
// many cells a given recording drew straight from the rendered DOM,
// without a real `SkCanvas`.
vi.mock('@shopify/react-native-skia', () => ({
  Skia: {
    // Every point is inside the shape: these tests care about which
    // *threshold* a cell clears, not the silhouette.
    Path: { MakeFromSVGString: () => ({ contains: () => true }) },
    Paint: () => {
      const paint = {
        color: '',
        antiAlias: false,
        setAntiAlias(on: boolean) {
          paint.antiAlias = on;
        },
        setColor(color: string) {
          paint.color = color;
        },
      };
      return paint;
    },
    Color: (color: string) => `color:${color}`,
    XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    RRectXY: (rect: FakeRect, rx: number, ry: number) => ({ rect, rx, ry }),
  },
  createPicture: vi.fn((draw: (canvas: unknown) => void, bounds: FakeRect) => ({ draw, bounds })),
  Canvas: ({ children }: { children?: unknown }) => children,
  Picture: ({ picture }: { picture: { value: { draw: (canvas: unknown) => void } } }) => {
    const draws: unknown[] = [];
    const canvas = {
      drawRect: () => draws.push('rect'),
      drawRRect: () => draws.push('rrect'),
    };
    picture.value.draw(canvas);
    return draws.length;
  },
}));

const { Dithered } = await import('./Dithered');
const { SQUARE_SHAPE } = await import('../test-utils');

describe('Dithered (native)', () => {
  // Regression: `useDitheredPictures({ ..., matrix })` at pictures.ts:96
  // must actually receive the `matrix` prop `<Dithered>` was given —
  // `pictures.test.ts` exercises the hook directly and can't see the
  // component silently dropping it before forwarding.
  it('passes the matrix prop through to sampling: bayer8 clears a fixed brightness differently than bayer4', () => {
    const brightness = () => 0.53;

    // cols=8 on a square shape makes an 8x8 grid: bayer4 tiles 2x2,
    // bayer8 matches it exactly, so 0.53 (between quantization levels for
    // both, but different ones) draws a different cell count under each —
    // the same reasoning `pictures.test.ts` and `renderer.test.ts` use.
    const { container: bayer4 } = render(
      <Dithered shape={SQUARE_SHAPE} brightness={brightness} cols={8} frames={1} />,
    );
    const { container: bayer8 } = render(
      <Dithered shape={SQUARE_SHAPE} brightness={brightness} cols={8} frames={1} matrix="bayer8" />,
    );

    const bayer4Draws = Number(bayer4.textContent);
    const bayer8Draws = Number(bayer8.textContent);

    expect(bayer4Draws).toBeGreaterThan(0);
    expect(bayer8Draws).not.toBe(bayer4Draws);
  });
});
