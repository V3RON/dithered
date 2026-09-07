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

/**
 * A real `<canvas>` inside a real `<div>` parent (both actual jsdom
 * elements, not plain-object stand-ins), for the fill-mode/`ResizeObserver`
 * tests that need `canvas.parentElement`, `getComputedStyle`, and
 * `clientWidth`/`clientHeight` to behave like the DOM. Pair with
 * `stubGetContext` for `getContext`, and `setClientBox` to control the
 * parent's measured size.
 */
export function makeCanvasWithParent() {
  const parent = document.createElement('div');
  const canvas = document.createElement('canvas');
  parent.appendChild(canvas);
  return { parent, canvas };
}

/**
 * Overrides `clientWidth`/`clientHeight` on a real DOM element — jsdom
 * never lays anything out, so these otherwise always read `0`.
 */
export function setClientBox(el: Element, box: { width: number; height: number }): void {
  Object.defineProperty(el, 'clientWidth', { value: box.width, configurable: true });
  Object.defineProperty(el, 'clientHeight', { value: box.height, configurable: true });
}

export interface IntersectionObserverInstance {
  callback: IntersectionObserverCallback;
  observe: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
}

export interface ResizeObserverInstance {
  callback: ResizeObserverCallback;
  observedTargets: Element[];
  observe: ReturnType<typeof vi.fn>;
  unobserve: ReturnType<typeof vi.fn>;
  disconnect: ReturnType<typeof vi.fn>;
  /**
   * Synchronously invokes the observer's callback with one entry for
   * `target` (defaulting to the first/only observed element), built from
   * `box`. Populates both `contentBoxSize` and `contentRect` so either
   * read path in the code under test works.
   */
  trigger(box: { width: number; height: number }, target?: Element): void;
}

/** Stubs the global `ResizeObserver` constructor, recording every instance created. */
export function stubResizeObserver() {
  const instances: ResizeObserverInstance[] = [];

  vi.stubGlobal(
    'ResizeObserver',
    vi.fn(function (this: unknown, callback: ResizeObserverCallback) {
      const observedTargets: Element[] = [];
      const instance: ResizeObserverInstance = {
        callback,
        observedTargets,
        observe: vi.fn((el: Element) => {
          if (!observedTargets.includes(el)) observedTargets.push(el);
        }),
        unobserve: vi.fn((el: Element) => {
          const i = observedTargets.indexOf(el);
          if (i >= 0) observedTargets.splice(i, 1);
        }),
        disconnect: vi.fn(() => {
          observedTargets.length = 0;
        }),
        trigger(box, target) {
          const el = target ?? observedTargets[0];
          if (!el) return;
          const entry = {
            target: el,
            contentRect: {
              width: box.width,
              height: box.height,
              x: 0,
              y: 0,
              top: 0,
              left: 0,
              right: box.width,
              bottom: box.height,
            },
            contentBoxSize: [{ inlineSize: box.width, blockSize: box.height }],
            borderBoxSize: [{ inlineSize: box.width, blockSize: box.height }],
            devicePixelContentBoxSize: [{ inlineSize: box.width, blockSize: box.height }],
          } as unknown as ResizeObserverEntry;
          callback([entry], instance as unknown as ResizeObserver);
        },
      };
      instances.push(instance);
      return instance;
    }),
  );

  return { instances };
}

function parseResolutionDpr(query: string): number | null {
  const match = /\(resolution:\s*([\d.]+)dppx\)/.exec(query);
  return match ? parseFloat(match[1]) : null;
}

type ChangeListener = (ev: { matches: boolean; media: string }) => void;

export interface MediaQueryListLike {
  media: string;
  matches: boolean;
  listeners: Set<ChangeListener>;
  addEventListener: ReturnType<typeof vi.fn>;
  removeEventListener: ReturnType<typeof vi.fn>;
  addListener: ReturnType<typeof vi.fn>;
  removeListener: ReturnType<typeof vi.fn>;
}

/**
 * Stubs `window.matchMedia` with something closer to the real thing than a
 * flat `{ matches: false }`: it tracks every `MediaQueryList` it hands
 * out, resolves `(resolution: Ndppx)` queries against the *current*
 * `devicePixelRatio`, and defaults every other query (notably
 * `prefers-reduced-motion`) to `matches: false`, matching the previous
 * stub's behaviour for existing tests. Supports both the modern
 * `addEventListener`/`removeEventListener` and the legacy Safari < 14
 * `addListener`/`removeListener` pair.
 */
export function stubMatchMedia() {
  const lists: MediaQueryListLike[] = [];

  const fn = vi.fn((query: string) => {
    const dprInQuery = parseResolutionDpr(query);
    const currentDpr =
      typeof window !== 'undefined' && typeof window.devicePixelRatio === 'number'
        ? window.devicePixelRatio
        : 1;
    const listeners = new Set<ChangeListener>();
    const mql: MediaQueryListLike = {
      media: query,
      matches: dprInQuery !== null ? dprInQuery === currentDpr : false,
      listeners,
      addEventListener: vi.fn((type: string, cb: ChangeListener) => {
        if (type === 'change') listeners.add(cb);
      }),
      removeEventListener: vi.fn((type: string, cb: ChangeListener) => {
        if (type === 'change') listeners.delete(cb);
      }),
      addListener: vi.fn((cb: ChangeListener) => listeners.add(cb)),
      removeListener: vi.fn((cb: ChangeListener) => listeners.delete(cb)),
    };
    lists.push(mql);
    return mql as unknown as MediaQueryList;
  });

  vi.stubGlobal('matchMedia', fn);

  return {
    lists,
    /**
     * Simulates `devicePixelRatio` becoming `newDpr`: updates every
     * tracked `(resolution: ...)` query's `.matches` and dispatches
     * `change` to whichever of its listeners are still attached — exactly
     * what the real browser does to a now-stale query.
     */
    changeDpr(newDpr: number) {
      vi.stubGlobal('devicePixelRatio', newDpr);
      // Snapshot the lists *before* dispatching: the code under test
      // re-arms (creates a fresh MediaQueryList) from inside the 'change'
      // listener itself, which would otherwise push new entries into
      // `lists` while this loop is still iterating it live.
      for (const mql of [...lists]) {
        const dprInQuery = parseResolutionDpr(mql.media);
        if (dprInQuery === null) continue;
        mql.matches = dprInQuery === newDpr;
        for (const cb of [...mql.listeners]) {
          cb({ matches: mql.matches, media: mql.media });
        }
      }
    },
  };
}

/**
 * Stubs the browser globals `createDithered`'s animation loop and
 * responsive-sizing code depend on
 * (`requestAnimationFrame`/`cancelAnimationFrame`, `matchMedia`,
 * `IntersectionObserver`, `ResizeObserver`). Call `restore()` in
 * `afterEach`.
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
  const media = stubMatchMedia();
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
  const resize = stubResizeObserver();

  return {
    rafCallbacks,
    ioInstances,
    resizeObserverInstances: resize.instances,
    mediaQueries: media.lists,
    changeDpr: media.changeDpr,
    restore: () => vi.unstubAllGlobals(),
  };
}
