import { Skia, type SkCanvas, type SkRRect } from '@shopify/react-native-skia';
import type { PaintContext } from '../core';

/**
 * Adapts a Skia canvas to the {@link PaintContext} the core painter
 * draws through, so `paintFrame` works against Skia unchanged.
 *
 * The canvas-2d path/fill split maps onto Skia's immediate-mode drawing
 * by holding the rect built by `roundRect`/`rect` until `fill` commits
 * it — which is exactly the `beginPath -> shape -> fill` sequence
 * `paintFrame` emits, and the only sequence this supports.
 */
export function skiaPaintContext(canvas: SkCanvas): PaintContext {
  const paint = Skia.Paint();
  paint.setAntiAlias(true);

  let fillStyle: string | object = '#000';
  let pending: SkRRect | null = null;

  return {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | object) {
      fillStyle = value;
      // Gradients and patterns have no core-painter equivalent; the
      // painter only ever assigns the `fg`/`bg` color strings.
      if (typeof value === 'string') paint.setColor(Skia.Color(value));
    },
    fillRect(x, y, w, h) {
      canvas.drawRect(Skia.XYWHRect(x, y, w, h), paint);
    },
    beginPath() {
      pending = null;
    },
    roundRect(x, y, w, h, radius) {
      pending = Skia.RRectXY(Skia.XYWHRect(x, y, w, h), radius, radius);
    },
    rect(x, y, w, h) {
      pending = Skia.RRectXY(Skia.XYWHRect(x, y, w, h), 0, 0);
    },
    fill() {
      if (pending) canvas.drawRRect(pending, paint);
    },
  };
}
