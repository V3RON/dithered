# dithered

[Live demo →](https://v3ron.github.io/dithered/)

`dithered` renders an animated ordered (Bayer) dither pattern masked to an SVG silhouette: it samples a coarse grid of cells inside a shape and, each frame, draws or skips a rounded square per cell by comparing a caller-supplied brightness value against a 4x4 Bayer threshold. The project started as a generalization of the Rozenite loading spinner into a standalone animated-shape primitive.

The library is a platform-free core plus thin per-platform renderers, in three entry points:

| Entry                    | Renders with                 | Needs                                                                            |
| ------------------------ | ----------------------------- | --------------------------------------------------------------------------------- |
| `dithered`               | canvas 2D                    | nothing                                                                          |
| `dithered/react`         | canvas 2D, in a `<canvas>`   | `react`, `react-dom`                                                             |
| `dithered/react-native`  | `@shopify/react-native-skia` | `react`, `react-native`, `@shopify/react-native-skia`, `react-native-reanimated` |

`dithered/react` and `dithered/react-native` each re-export the entire `dithered` core (shapes, presets, `sampleCells`, etc.) alongside their `Dithered` component, so a React or React Native app never needs a second import from plain `dithered`.

## Install

```sh
pnpm add dithered
```

Every peer dependency is optional; you only need the ones your entry point uses. The plain `dithered` entry has none.

For React Native:

```sh
pnpm add dithered @shopify/react-native-skia react-native-reanimated
```

Reanimated needs its babel plugin in your `babel.config.js` (`plugins: ['react-native-reanimated/plugin']`) — that is what turns the playback worklet in `dithered/react-native` into a UI-thread function.

## Quick start

### React

```tsx
import { Dithered, shapes, presets } from 'dithered/react';

function LoadingIndicator() {
  return <Dithered shape={shapes.rozenite} brightness={presets.gem()} fg="#8232ff" size={48} />;
}
```

### React Native

```tsx
import { Dithered, shapes, presets } from 'dithered/react-native';

// Module scope: `<Dithered>` re-records every frame when `shape` or
// `brightness` changes identity, so keep those references stable.
const GEM = presets.gem();

function LoadingIndicator() {
  return <Dithered shape={shapes.rozenite} brightness={GEM} fg="#8232ff" size={48} />;
}
```

The props are the web component's, minus the DOM-only ones: `className` and `style: CSSProperties` become `style: StyleProp<ViewStyle>`, `label` maps to `accessibilityLabel` rather than `role="status"`, `cache` is gone (see [Performance notes](#performance-notes)), and `cells` is new. Everything else — `shape`, `brightness`, `size`, `cols`, `rows`, `frames`, `period`, `fg`, `bg`, `gap`, `radius`, `paused`, `progress`, `initialFrame`, `respectReducedMotion` — behaves identically, so a shared component can spread the same props object at both.

To draw into a Skia canvas you already own, `dithered/react-native` also exports the pieces: `useDitheredPictures(options)` returns one `SkPicture` per frame plus the canvas size, and `skiaPaintContext(canvas)` adapts an `SkCanvas` to the `PaintContext` that `paintFrame` draws through.

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
- `gameOfLife({ seed?, density?, frames?, boardSize? })` — Conway's Game of Life, simulated once and played back on loop. Pass your own `seed` to get a specific starting pattern (same seed = same result every time). The board wraps at its edges and quietly reseeds itself if the population ever crashes, so it won't fizzle out and leave the shape dark for the rest of the loop.

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

`shapeFromSvg` uses `DOMParser`, so it is web-only. `shapeFromSvgLite` is the same contract implemented by scanning the source text, and is exported from both `dithered` and `dithered/react-native`:

```ts
import { shapeFromSvgLite } from 'dithered/react-native';
```

It handles well-formed SVG as design tools emit it — comments and CDATA are skipped, attributes may be single- or double-quoted — but it is not an XML parser: entity references are not expanded, and a `>` inside an attribute value will confuse it. On the web, prefer `shapeFromSvg`.

A `Shape` is plain data (`{ path, viewBox }`), so the other option is to convert once at build time and commit the result — which is all `shapes.ts` is:

```ts
// scripts/shapes.mjs, run in Node
import { readFileSync, writeFileSync } from 'node:fs';
import { shapeFromSvgLite } from 'dithered';

const shape = shapeFromSvgLite(readFileSync('assets/logo.svg', 'utf8'));
writeFileSync(
  'src/shapes.generated.ts',
  `export const logo = ${JSON.stringify(shape)} as const;\n`,
);
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

### Web

- **Sprite-strip cache**: with `cache: 'auto'` (the default), instances at `size <= 120` pre-render every frame of the loop into an offscreen canvas once; steady-state playback then costs a single `drawImage` per frame instead of redrawing every cell.
- **Pauses automatically** when the tab is hidden (`document.visibilitychange`) or the canvas scrolls out of the viewport (`IntersectionObserver`), and resumes when either condition clears.
- **`prefers-reduced-motion`**: a single static frame is rendered and the animation loop never starts, unless `respectReducedMotion: false` is set.
- Frame index is quantized to `frames` steps per `period`, and a repeated frame index is never redrawn.

### React Native

- **Every frame is pre-recorded** as an `SkPicture`, and playback only swaps which recording the canvas draws — from a Reanimated frame callback, so the loop runs entirely on the UI thread with no per-frame JS work and no bridge traffic. `cache` is therefore ignored: pictures are display lists rather than bitmaps, so the memory trade-off that makes pre-rendering optional on the web does not apply.
- Recordings are in dp. Skia scales to the device pixel ratio itself and the output is vector, so there is nothing to re-record per device.
- **Pauses automatically** when the app leaves the foreground (`AppState`). There is no `IntersectionObserver` equivalent, so a scrolled-away instance keeps playing — cheaply, on the UI thread.
- **Reduced motion** comes from Reanimated's `useReducedMotion()`, honoured unless `respectReducedMotion: false` is set.
- Pass `cells` (from `sampleCells`) to skip the shape hit-test at mount if you are creating many instances of the same shape and grid.

## API

### `DitheredOptions`

| Option                 | Type                | Default                   | Description                                                                         |
| ---------------------- | ------------------- | ------------------------- | ----------------------------------------------------------------------------------- |
| `shape`                | `Shape`             | —                         | Required. Silhouette to sample cells inside.                                        |
| `brightness`           | `Brightness`        | —                         | Required. Per-cell, per-frame brightness function.                                  |
| `size`                 | `number`            | `48`                      | Height in CSS px (web) or dp (native); width follows the shape's aspect ratio.      |
| `cols`                 | `number`            | `16`                      | Grid columns.                                                                       |
| `rows`                 | `number`            | derived from aspect ratio | Grid rows.                                                                          |
| `frames`               | `number`            | `48`                      | Frames per loop.                                                                    |
| `period`               | `number`            | `2000`                    | Loop duration, ms.                                                                  |
| `fg`                   | `string`            | `'#000'`                  | Fill color for drawn cells.                                                         |
| `bg`                   | `string`            | `'transparent'`           | Background fill, or `'transparent'`.                                                |
| `cache`                | `boolean \| 'auto'` | `'auto'`                  | Web only. Pre-render the loop into a sprite strip. `'auto'` = on for `size <= 120`. |
| `paused`               | `boolean`           | `false`                   | Freeze the animation.                                                               |
| `gap`                  | `number`            | `0.09`                    | Gap between cells, as a fraction of cell size (min 0.6px).                          |
| `radius`               | `number`            | `0.14`                    | Corner radius, as a fraction of cell size.                                          |
| `respectReducedMotion` | `boolean`           | `true`                    | Render a single static frame under `prefers-reduced-motion`.                        |
| `initialFrame`         | `number`            | `0`                       | Frame drawn synchronously on create, so there is no blank flash.                    |

### `DitheredInstance`

| Method                                      | Description                                                                             |
| ------------------------------------------- | --------------------------------------------------------------------------------------- |
| `setPaused(paused: boolean)`                | Pause or resume the animation loop.                                                     |
| `update(options: Partial<DitheredOptions>)` | Re-configure the instance in place; may resample cells and/or rebuild the sprite cache. |
| `renderFrame(frame: number)`                | Draw a specific frame directly, bypassing the animation loop.                           |
| `destroy()`                                 | Stop the loop and release all listeners/observers.                                      |

`dithered/react`'s `Dithered` component accepts the same options as props (`shape`/`brightness` still required), plus `label` (accessible label, default `'Loading'`, `''` hides it from assistive tech), `className`, `style`, and `progress` — see [Determinate progress](#determinate-progress) and [React](#quick-start) above. `dithered/react-native`'s takes the same props with `style: StyleProp<ViewStyle>` in place of `className`/`style`, no `cache`, and an extra `cells` — see [React Native](#react-native) above.

### Sampling

`sampleCells(shape, cols, hitTest, rows?)` returns the cells inside a shape. The point-in-path test is injected because no platform provides one portably: use `domHitTester(shape, ctx?)` from `dithered` (backed by `Path2D`) or `skiaHitTester(shape)` from `dithered/react-native` (backed by `SkPath.contains`).

```ts
import { sampleCells, domHitTester, shapes } from 'dithered';

const cells = sampleCells(shapes.heart, 16, domHitTester(shapes.heart));
```

## Repository layout

This repo is a pnpm workspace:

| Package                    | What it is                                                              |
| -------------------------- | ----------------------------------------------------------------------- |
| `packages/dithered`        | the published library                                                   |
| `packages/playground-web`  | the Vite demo behind the [live demo](https://v3ron.github.io/dithered/) |
| `packages/playground-expo` | an Expo app exercising `dithered/react-native` on device                |

```sh
pnpm install
pnpm dev                              # web playground
pnpm test                             # library test suite
pnpm --filter playground-expo start   # Expo playground (builds the library first)
```

## License

MIT
