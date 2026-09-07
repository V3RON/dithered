import { beforeEach, describe, expect, it, vi } from 'vitest';

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

vi.mock('@shopify/react-native-skia', () => ({
  Skia: {
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
}));

const { skiaPaintContext } = await import('./paint-context');
const { computeGeometry, paintFrame, resolveOptions } = await import('../core');
const { SQUARE_SHAPE } = await import('../test-utils');
import type { Cell } from '../shape';
import type { SkCanvas } from '@shopify/react-native-skia';

interface FakePaint {
  color: string;
}

type Draw =
  { op: 'rect'; rect: FakeRect; color: string } | { op: 'rrect'; rrect: FakeRRect; color: string };

function fakeCanvas() {
  const draws: Draw[] = [];
  // Tracked separately from `draws` (rather than folded into it) so the
  // pre-existing draw-log assertions below don't need to change shape —
  // one paint is now cached per color rather than mutated in place, so
  // the paint reference itself is stable for a given color, letting
  // tests assert reuse independently of what got drawn.
  const paints: FakePaint[] = [];
  const canvas = {
    // The paint object is mutated in place, so snapshot its color at the
    // moment of the draw call rather than holding a reference.
    drawRect: vi.fn((rect: FakeRect, paint: FakePaint) => {
      draws.push({ op: 'rect', rect, color: paint.color });
      paints.push(paint);
    }),
    drawRRect: vi.fn((rrect: FakeRRect, paint: FakePaint) => {
      draws.push({ op: 'rrect', rrect, color: paint.color });
      paints.push(paint);
    }),
  };
  return { canvas: canvas as unknown as SkCanvas, draws, paints };
}

describe('skiaPaintContext', () => {
  let env: ReturnType<typeof fakeCanvas>;

  beforeEach(() => {
    env = fakeCanvas();
  });

  it('translates fillRect into drawRect with the current fill color', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.fillStyle = '#123456';
    ctx.fillRect(1, 2, 30, 40);

    expect(env.draws).toEqual([
      { op: 'rect', rect: { x: 1, y: 2, width: 30, height: 40 }, color: 'color:#123456' },
    ]);
  });

  it('commits a roundRect as a rounded drawRRect on fill', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.fillStyle = '#000';
    ctx.beginPath();
    ctx.roundRect?.(5, 6, 10, 10, 2);
    ctx.fill();

    expect(env.draws).toEqual([
      {
        op: 'rrect',
        rrect: { rect: { x: 5, y: 6, width: 10, height: 10 }, rx: 2, ry: 2 },
        color: 'color:#000',
      },
    ]);
  });

  it('commits a plain rect as a zero-radius drawRRect', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.beginPath();
    ctx.rect(0, 0, 4, 4);
    ctx.fill();

    expect(env.draws).toHaveLength(1);
    expect(env.draws[0]).toMatchObject({ op: 'rrect', rrect: { rx: 0, ry: 0 } });
  });

  it('draws nothing when fill() follows beginPath() with no shape', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.beginPath();
    ctx.fill();

    expect(env.draws).toHaveLength(0);
  });

  it('does not re-commit a shape that beginPath() has cleared', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.beginPath();
    ctx.rect(0, 0, 4, 4);
    ctx.fill();
    ctx.beginPath();
    ctx.fill();

    expect(env.draws).toHaveLength(1);
  });

  it('reports back the fill color it was given', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.fillStyle = 'rebeccapurple';
    expect(ctx.fillStyle).toBe('rebeccapurple');
  });

  it('ignores non-string fill styles rather than passing them to Skia.Color', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.fillStyle = '#abcdef';
    ctx.fillStyle = {}; // a gradient/pattern stand-in
    ctx.fillRect(0, 0, 1, 1);

    expect(env.draws[0].color).toBe('color:#abcdef');
  });

  it('creates one SkPaint per distinct color and reuses it on repeat assignments', () => {
    const ctx = skiaPaintContext(env.canvas);
    ctx.fillStyle = '#123456';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = '#abcdef';
    ctx.fillRect(0, 0, 1, 1);
    ctx.fillStyle = '#123456'; // switch back to a color already seen
    ctx.fillRect(0, 0, 1, 1);

    expect(env.paints[0]).not.toBe(env.paints[1]); // distinct colors
    expect(env.paints[0]).toBe(env.paints[2]); // same color -> same paint
  });
});

describe('paintFrame through skiaPaintContext', () => {
  const cells: Cell[] = [
    { i: 0, j: 0, u: -0.25, v: -0.25, threshold: 0.5 },
    { i: 1, j: 0, u: 0.25, v: -0.25, threshold: 0.5 },
  ];

  it('fills the background then one rounded rect per lit cell', () => {
    const { canvas, draws } = fakeCanvas();
    const opts = resolveOptions({
      shape: SQUARE_SHAPE,
      brightness: (cell) => cell.i === 0,
      cols: 2,
      bg: '#fff',
      fg: '#000',
    });
    const geometry = computeGeometry(opts, 20, 20);

    paintFrame(skiaPaintContext(canvas), cells, opts.brightness, 0, geometry);

    expect(draws).toHaveLength(2);
    expect(draws[0]).toMatchObject({
      op: 'rect',
      rect: { x: 0, y: 0, width: 20, height: 20 },
      color: 'color:#fff',
    });
    expect(draws[1]).toMatchObject({ op: 'rrect', color: 'color:#000' });
  });

  it('skips the background fill when bg is transparent', () => {
    const { canvas, draws } = fakeCanvas();
    const opts = resolveOptions({
      shape: SQUARE_SHAPE,
      brightness: () => true,
      cols: 2,
      bg: 'transparent',
    });

    paintFrame(skiaPaintContext(canvas), cells, opts.brightness, 0, computeGeometry(opts, 20, 20));

    expect(draws.every((d) => d.op === 'rrect')).toBe(true);
    expect(draws).toHaveLength(2);
  });

  it('paints a multi-tone palette, reusing one paint per tone across cells', () => {
    const { canvas, draws, paints } = fakeCanvas();
    const threeCells: Cell[] = [
      { i: 0, j: 0, u: -0.33, v: 0, threshold: 0.5 },
      { i: 1, j: 0, u: 0, v: 0, threshold: 0.5 },
      { i: 2, j: 0, u: 0.33, v: 0, threshold: 0.5 },
    ];
    const opts = resolveOptions({
      shape: SQUARE_SHAPE,
      // Cells 0 and 2 land on the brightest tone; cell 1 is skipped.
      brightness: (cell) => cell.i !== 1,
      cols: 3,
      bg: 'transparent',
      fg: ['#a00', '#0a0'],
    });

    paintFrame(
      skiaPaintContext(canvas),
      threeCells,
      opts.brightness,
      0,
      computeGeometry(opts, 30, 10),
    );

    expect(draws).toHaveLength(2);
    expect(draws[0].color).toBe('color:#0a0');
    expect(draws[1].color).toBe('color:#0a0');
    // Same color across both draws -> the cached paint was reused, not
    // re-created or mutated out from under the first draw.
    expect(paints[0]).toBe(paints[1]);
  });
});
