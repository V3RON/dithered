import { vi } from 'vitest';
import type { Shape } from './shape';

/** A trivial square silhouette, useful whenever the exact shape doesn't matter. */
export const SQUARE_SHAPE: Shape = {
  path: 'M0 0 H10 V10 H0 Z',
  viewBox: { x: 0, y: 0, width: 10, height: 10 },
};

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
