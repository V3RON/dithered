import type { HitTester, Shape } from './shape';

/**
 * A browser {@link HitTester} backed by `Path2D` and
 * `CanvasRenderingContext2D.isPointInPath`.
 *
 * Pass the context you are already rendering into when you have one;
 * otherwise a throwaway canvas is created, since point-in-path testing
 * touches no drawing state.
 */
export function domHitTester(shape: Shape, ctx?: CanvasRenderingContext2D): HitTester {
  const context = ctx ?? createScratchContext();
  const path = new Path2D(shape.path);
  const fillRule = shape.fillRule ?? 'nonzero';
  return (x, y) => context.isPointInPath(path, x, y, fillRule);
}

function createScratchContext(): CanvasRenderingContext2D {
  const canvas = document.createElement('canvas');
  const ctx = canvas.getContext('2d');
  if (!ctx) {
    throw new Error('dithered: unable to create a 2D canvas context for sampling.');
  }
  return ctx;
}
