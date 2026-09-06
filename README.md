# dithered

[Live demo →](https://v3ron.github.io/dithered/)

`dithered` renders an animated ordered (Bayer) dither pattern masked to an SVG silhouette: it samples a coarse grid of cells inside a shape and, each frame, draws or skips a rounded square per cell by comparing a caller-supplied brightness value against a 4x4 Bayer threshold. The core is framework-agnostic canvas 2D; an optional React wrapper (`dithered/react`) is a separate entry point. The project started as a generalization of the Rozenite loading spinner into a standalone animated-shape primitive.

## Install

```sh
pnpm add dithered
```

React is optional — `react`/`react-dom` are peer dependencies marked optional, only needed if you import from `dithered/react`.

## Quick start

### React

```tsx
import { Dithered } from 'dithered/react';
import { shapes, presets } from 'dithered';

function LoadingIndicator() {
  return <Dithered shape={shapes.rozenite} brightness={presets.gem()} fg="#8232ff" size={48} />;
}
```

### Vanilla

```ts
import { createDithered, shapes, presets } from 'dithered';

const canvas = document.querySelector('canvas')!;
const instance = createDithered(canvas, {
  shape: shapes.rozenite,
  brightness: presets.gem(),
  fg: '#8232ff',
  size: 48,
});

// Later:
instance.setPaused(true);
instance.update({ fg: '#22cc88' });
instance.destroy();
```

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
- `fill({ direction? })` — a progress-style fill (`t=0` empty, `t=1` full); pair with `renderFrame`/`progress` for a determinate indicator rather than looping it.

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

## Custom animations

A `Brightness` is `(cell: Cell, t: number) => number | boolean`:

- `cell.u`, `cell.v` — the cell's centre, normalized to `-0.5..0.5` across the shape's width/height.
- `cell.i`, `cell.j` — the cell's column/row index in the sampled grid.
- `t` — the loop phase, `0..1` (exclusive of 1; wraps back to 0).
- Return a **number** to ordered-dither it against `cell.threshold` (drawn when `brightness > threshold`) — this is what gives the grainy, textured look.
- Return a **boolean** to draw or skip the cell outright, bypassing the dither for a crisp edge (see `presets.fill`).

Keep your function periodic in `t` (i.e. `f(cell, 0) === f(cell, 1)`) so the loop doesn't visibly jump — drive time-varying terms through `Math.sin`/`Math.cos` of `t * 2π`, or through a wrapped/modulo coordinate, rather than a raw linear function of `t`. `presets.ts` has worked examples of both approaches.

```ts
const brightness: Brightness = (cell, t) => 0.5 + 0.5 * Math.sin((cell.u + t) * Math.PI * 2);
```

## Determinate progress

For a progress indicator rather than a loop, pass `progress` (`0`–`1`) to `Dithered`, or call `instance.setPaused(true)` + `instance.renderFrame(frame)` directly with the core API — both pause the animation and render exactly one frame:

```tsx
<Dithered shape={shapes.square} brightness={presets.fill()} progress={downloadedFraction} />
```

## Performance notes

- **Sprite-strip cache**: with `cache: 'auto'` (the default), instances at `size <= 120` pre-render every frame of the loop into an offscreen canvas once; steady-state playback then costs a single `drawImage` per frame instead of redrawing every cell.
- **Pauses automatically** when the tab is hidden (`document.visibilitychange`) or the canvas scrolls out of the viewport (`IntersectionObserver`), and resumes when either condition clears.
- **`prefers-reduced-motion`**: a single static frame is rendered and the animation loop never starts, unless `respectReducedMotion: false` is set.
- Frame index is quantized to `frames` steps per `period`, and a repeated frame index is never redrawn.

## API

### `DitheredOptions`

| Option                 | Type                | Default                   | Description                                                               |
| ---------------------- | ------------------- | ------------------------- | ------------------------------------------------------------------------- |
| `shape`                | `Shape`             | —                         | Required. Silhouette to sample cells inside.                              |
| `brightness`           | `Brightness`        | —                         | Required. Per-cell, per-frame brightness function.                        |
| `size`                 | `number`            | `48`                      | CSS px height; width follows the shape's aspect ratio.                    |
| `cols`                 | `number`            | `16`                      | Grid columns.                                                             |
| `rows`                 | `number`            | derived from aspect ratio | Grid rows.                                                                |
| `frames`               | `number`            | `48`                      | Frames per loop.                                                          |
| `period`               | `number`            | `2000`                    | Loop duration, ms.                                                        |
| `fg`                   | `string`            | `'#000'`                  | Fill color for drawn cells.                                               |
| `bg`                   | `string`            | `'transparent'`           | Background fill, or `'transparent'`.                                      |
| `cache`                | `boolean \| 'auto'` | `'auto'`                  | Pre-render the loop into a sprite strip. `'auto'` = on for `size <= 120`. |
| `paused`               | `boolean`           | `false`                   | Freeze the animation.                                                     |
| `gap`                  | `number`            | `0.09`                    | Gap between cells, as a fraction of cell size (min 0.6px).                |
| `radius`               | `number`            | `0.14`                    | Corner radius, as a fraction of cell size.                                |
| `respectReducedMotion` | `boolean`           | `true`                    | Render a single static frame under `prefers-reduced-motion`.              |
| `initialFrame`         | `number`            | `0`                       | Frame drawn synchronously on create, so there is no blank flash.          |

### `DitheredInstance`

| Method                                      | Description                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `setPaused(paused: boolean)`                | Pause or resume the animation loop.                                                     |
| `update(options: Partial<DitheredOptions>)` | Re-configure the instance in place; may resample cells and/or rebuild the sprite cache. |
| `renderFrame(frame: number)`                | Draw a specific frame directly, bypassing the animation loop.                           |
| `destroy()`                                 | Stop the loop and release all listeners/observers.                                      |

`dithered/react`'s `Dithered` component accepts the same options as props (`shape`/`brightness` still required), plus `label` (accessible label, default `'Loading'`, `''` hides it from assistive tech), `className`, `style`, and `progress` — see [Determinate progress](#determinate-progress) and [React](#quick-start) above.

## License

MIT
