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

## Presets

Built-in `Brightness` factories, importable individually or via `presets`:

```ts
import { presets, gem } from 'dithered';

createDithered(canvas, { shape, brightness: presets.gem({ noise: 0.8 }) });
createDithered(canvas, { shape, brightness: gem() }); // same thing
```

- `gem({ noise? })` — the Rozenite loader's light field: a rotating sweep plus a travelling highlight blob and grain, ported line-for-line from the reference loader.
- `sweep({ angle?, width? })` — a soft band of light travelling across the shape once per loop.
- `pulse({ min?, max? })` — radial breathing: brightest at the centre, oscillating once per loop.
- `rain({ density?, seed? })` — vertical drops falling per column, wrapping cleanly at the loop boundary.
- `wave({ amplitude?, frequency? })` — a horizontal sine wave moving through the shape.
- `fill({ direction? })` — a progress-style fill (`t=0` empty, `t=1` full); pair with `renderFrame` for a determinate progress indicator rather than looping it.

## Shapes

Ready-made `Shape` objects, importable individually or via `shapes`: `rozenite` (the Rozenite gem mark), `circle`, `square`, `diamond`, `heart`.

```ts
import { shapes } from 'dithered';

createDithered(canvas, { shape: shapes.heart, brightness: presets.pulse() });
```

Build a `Shape` from your own SVG with `shapeFromSvg`, which reads the root `viewBox` and concatenates every `<path>` descendant's `d` attribute (only `<path>` elements are supported):

```ts
import { shapeFromSvg } from 'dithered';

const shape = shapeFromSvg(`
  <svg viewBox="0 0 100 100">
    <path d="M10 10 H90 V90 H10 Z" />
  </svg>
`);
```

## React

`dithered/react` is a separate entry point (`react`/`react-dom` are optional peer dependencies, not required by core `dithered`):

```tsx
import { Dithered } from 'dithered/react';
import { shapes, presets } from 'dithered';

function LoadingIndicator() {
  return <Dithered shape={shapes.rozenite} brightness={presets.gem()} fg="#8232ff" size={48} />;
}
```

One `createDithered` instance is created on mount and destroyed on unmount; every other prop change reconfigures that same instance instead of recreating it. `brightness` (and `shape`) participate in that reconfigure **by identity** — pass a stable reference, either a module-level preset call like `presets.gem()` above, or your own function hoisted outside the component or wrapped in `useMemo`/`useCallback`. An inline arrow function passed as `brightness` will trigger a reconfigure on every render.

For a determinate progress indicator, pass `progress` (`0`–`1`) instead of letting it loop — this pauses the instance and renders the matching frame directly:

```tsx
<Dithered shape={shapes.square} brightness={presets.fill()} progress={downloadedFraction} />
```

`ref` forwards to the underlying `<canvas>` element.
