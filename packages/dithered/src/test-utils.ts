import { vi } from 'vitest';
import { arcToCubics, parsePath, toAbsolute } from './core/path';
import type { HitTester, Shape } from './shape';

/** A trivial square silhouette, useful whenever the exact shape doesn't matter. */
export const SQUARE_SHAPE: Shape = {
  path: 'M0 0 H10 V10 H0 Z',
  viewBox: { x: 0, y: 0, width: 10, height: 10 },
};

/**
 * A pure-JS {@link HitTester}, for tests only. `domHitTester` needs a real
 * `CanvasRenderingContext2D` (jsdom's `getContext('2d')` returns `null`
 * without the native `canvas` package) and `skiaHitTester` needs Skia, so
 * neither is usable for the fixture-parity tests that check `shapeFromSvg`
 * and `shapeFromSvgLite` sample the *same cells* as a hand-written `<path>`
 * equivalent. This flattens curves to line segments and answers with the
 * standard ray-casting winding/crossing count, honoring `fillRule` exactly
 * like `domHitTester`/`skiaHitTester` do.
 */
export function jsHitTester(shape: Shape): HitTester {
  const polygons = pathToPolygons(shape.path);
  const fillRule = shape.fillRule ?? 'nonzero';
  return (px, py) => {
    let winding = 0;
    let crossings = 0;
    for (const poly of polygons) {
      for (let i = 0; i < poly.length; i++) {
        const [x1, y1] = poly[i];
        const [x2, y2] = poly[(i + 1) % poly.length];
        if (y1 <= py !== y2 <= py) {
          const xCross = x1 + ((py - y1) / (y2 - y1)) * (x2 - x1);
          if (xCross > px) {
            crossings++;
            winding += y2 > y1 ? 1 : -1;
          }
        }
      }
    }
    return fillRule === 'evenodd' ? crossings % 2 === 1 : winding !== 0;
  };
}

type Point = [number, number];

function flattenCubic(x0: number, y0: number, c: number[], segments = 24): Point[] {
  const [x1, y1, x2, y2, x3, y3] = c;
  const pts: Point[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    pts.push([
      mt * mt * mt * x0 + 3 * mt * mt * t * x1 + 3 * mt * t * t * x2 + t * t * t * x3,
      mt * mt * mt * y0 + 3 * mt * mt * t * y1 + 3 * mt * t * t * y2 + t * t * t * y3,
    ]);
  }
  return pts;
}

function flattenQuad(
  x0: number,
  y0: number,
  x1: number,
  y1: number,
  x2: number,
  y2: number,
  segments = 24,
): Point[] {
  const pts: Point[] = [];
  for (let i = 1; i <= segments; i++) {
    const t = i / segments;
    const mt = 1 - t;
    pts.push([
      mt * mt * x0 + 2 * mt * t * x1 + t * t * x2,
      mt * mt * y0 + 2 * mt * t * y1 + t * t * y2,
    ]);
  }
  return pts;
}

/** Absolutizes and flattens a `d` string into closed polygons, one per subpath. */
function pathToPolygons(d: string): Point[][] {
  const polygons: Point[][] = [];
  let current: Point[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  for (const seg of toAbsolute(parsePath(d))) {
    switch (seg.command) {
      case 'M':
        if (current.length) polygons.push(current);
        current = [[seg.values[0], seg.values[1]]];
        x = startX = seg.values[0];
        y = startY = seg.values[1];
        break;
      case 'L':
        current.push([seg.values[0], seg.values[1]]);
        x = seg.values[0];
        y = seg.values[1];
        break;
      case 'C':
        current.push(...flattenCubic(x, y, seg.values));
        x = seg.values[4];
        y = seg.values[5];
        break;
      case 'Q':
        current.push(
          ...flattenQuad(x, y, seg.values[0], seg.values[1], seg.values[2], seg.values[3]),
        );
        x = seg.values[2];
        y = seg.values[3];
        break;
      case 'A':
        for (const cubic of arcToCubics(
          x,
          y,
          ...(seg.values as [number, number, number, number, number, number, number]),
        )) {
          current.push(...flattenCubic(x, y, cubic));
          x = cubic[4];
          y = cubic[5];
        }
        break;
      case 'Z':
        x = startX;
        y = startY;
        break;
    }
  }
  if (current.length) polygons.push(current);
  return polygons;
}

/** A minimal recording 2D context: no canvas element required. */
export function make2dCtx() {
  return {
    fillStyle: '',
    fillRect: vi.fn(),
    beginPath: vi.fn(),
    rect: vi.fn(),
    fill: vi.fn(),
    clearRect: vi.fn(),
    drawImage: vi.fn(),
    setTransform: vi.fn(),
    isPointInPath: vi.fn(() => true),
  };
}

/** A fake `<canvas>` (plain object) whose `getContext` returns a recording ctx. */
export function makeFakeCanvas() {
  const ctx = make2dCtx();
  const canvas = {
    width: 0,
    height: 0,
    style: {} as Record<string, string>,
    getContext: vi.fn(() => ctx),
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, ctx };
}

/**
 * Replaces `HTMLCanvasElement.prototype.getContext` with a stub returning
 * `ctx`.
 *
 * Swapping the method out rather than `vi.spyOn(...).mockReturnValue(...)`
 * is deliberate: `getContext` is overloaded once per context type ('2d',
 * 'webgl', 'webgpu', ...), so a mocked return value has to satisfy
 * whichever overload TypeScript happens to resolve last — which changes
 * as ambient DOM/WebGPU types come and go with unrelated dependencies.
 */
export function stubGetContext(ctx: unknown) {
  const original = HTMLCanvasElement.prototype.getContext;
  const stub = vi.fn(() => ctx);
  HTMLCanvasElement.prototype.getContext = stub as unknown as typeof original;
  return {
    stub,
    restore: () => {
      HTMLCanvasElement.prototype.getContext = original;
    },
  };
}

export interface IntersectionObserverInstance {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

/**
 * Stubs the browser globals `createDithered`'s animation loop depends on
 * (`requestAnimationFrame`/`cancelAnimationFrame`, `matchMedia`,
 * `IntersectionObserver`). Call `restore()` in `afterEach`.
 */
export function stubAnimationGlobals() {
  const rafCallbacks: FrameRequestCallback[] = [];
  const ioInstances: IntersectionObserverInstance[] = [];
  let rafId = 0;

  vi.stubGlobal(
    'requestAnimationFrame',
    vi.fn((cb: FrameRequestCallback) => {
      rafCallbacks.push(cb);
      return ++rafId;
    }),
  );
  vi.stubGlobal('cancelAnimationFrame', vi.fn());
  vi.stubGlobal(
    'matchMedia',
    vi.fn(() => ({ matches: false })),
  );
  vi.stubGlobal(
    'IntersectionObserver',
    vi.fn(function (this: unknown, callback: IntersectionObserverCallback) {
      const instance: IntersectionObserverInstance = {
        callback,
        observe: vi.fn(),
        disconnect: vi.fn(),
      };
      ioInstances.push(instance);
      return instance;
    }),
  );

  return {
    rafCallbacks,
    ioInstances,
    restore: () => vi.unstubAllGlobals(),
  };
}
