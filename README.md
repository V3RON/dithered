# dithered

`dithered` renders an animated ordered (Bayer) dither pattern masked to an SVG silhouette. It samples a coarse grid of cells inside a shape and, each frame, draws or skips a rounded square per cell by comparing an animated brightness field against a 4x4 Bayer threshold.

## Usage

```ts
import { createDithered } from 'dithered';

const canvas = document.querySelector('canvas')!;

const instance = createDithered(canvas, {
  shape: {
    // Any SVG path `d` string plus the viewBox it was authored in.
    path: 'M17.333 5.333H20V10.667H22.667V16H25.333V24H22.667V26.667H20V29.333H12V26.667H9.333V24H6.667V16H9.333V10.667H12V5.333H14.667V2.667H17.333V5.333Z',
    viewBox: { x: 6.67, y: 2.67, width: 18.67, height: 26.67 },
  },
  // Brightness per cell per frame: a number is ordered-dithered against the
  // cell's Bayer threshold, a boolean draws/skips the cell outright.
  brightness: (cell, t) => {
    const angle = t * Math.PI * 2;
    return 0.5 + 0.45 * (cell.u * Math.cos(angle) + cell.v * Math.sin(angle));
  },
  size: 48,
  fg: '#8232ff',
});

// Later:
instance.setPaused(true);
instance.update({ fg: '#22cc88' });
instance.destroy();
```

See `src/renderer.ts` for the full `DitheredOptions` reference (grid size, frame count/period, sprite-strip caching, gap/corner radius, reduced-motion handling, and more).
