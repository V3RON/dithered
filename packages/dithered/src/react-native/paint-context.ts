import { Skia, type SkCanvas, type SkPaint, type SkRRect } from '@shopify/react-native-skia';
import type { PaintContext } from '../core';

/**
 * Adapts a Skia canvas to the {@link PaintContext} the core painter
 * draws through, so `paintFrame` works against Skia unchanged.
 *
 * The canvas-2d path/fill split maps onto Skia's immediate-mode drawing
 * by holding the rect built by `roundRect`/`rect` until `fill` commits
 * it — which is exactly the `beginPath -> shape -> fill` sequence
 * `paintFrame` emits, and the only sequence this supports.
 *
 * One `SkPaint` is lazily created per distinct color string and cached in
 * a `Map`, rather than mutating a single paint's color on every
 * `fillStyle` assignment. A multi-tone palette makes `paintFrame` switch
 * `fillStyle` up to once per tone per frame, so this avoids re-parsing a
 * color on every switch — and, the real reason, it sidesteps any
 * dependence on whether `createPicture` snapshots paint state at record
 * time or holds a live reference to the paint object: with one paint per
 * tone, held for the lifetime of this context, that question cannot
 * arise.
 */
export function skiaPaintContext(canvas: SkCanvas): PaintContext {
  const paints = new Map<string, SkPaint>();

  function paintFor(color: string): SkPaint {
    let paint = paints.get(color);
    if (!paint) {
      paint = Skia.Paint();
      paint.setAntiAlias(true);
      paint.setColor(Skia.Color(color));
      paints.set(color, paint);
    }
    return paint;
  }

  let fillStyle: string | object = '#000';
  let currentPaint = paintFor(fillStyle);
  let pending: SkRRect | null = null;

  return {
    get fillStyle() {
      return fillStyle;
    },
    set fillStyle(value: string | object) {
      fillStyle = value;
      // Gradients and patterns have no core-painter equivalent; the
      // painter only ever assigns the `fg`/`bg` color strings.
      if (typeof value === 'string') currentPaint = paintFor(value);
    },
    fillRect(x, y, w, h) {
      canvas.drawRect(Skia.XYWHRect(x, y, w, h), currentPaint);
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
      if (pending) canvas.drawRRect(pending, currentPaint);
    },
  };
}
