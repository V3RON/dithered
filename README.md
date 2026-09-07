# dithered

[Live demo →](https://v3ron.github.io/dithered/)

`dithered` renders an animated ordered (Bayer) dither pattern masked to an SVG silhouette: it samples a coarse grid of cells inside a shape and, each frame, draws or skips a rounded square per cell by comparing a caller-supplied brightness value against a 4x4 Bayer threshold. The project started as a generalization of the Rozenite loading spinner into a standalone animated-shape primitive.

The library is a platform-free core plus thin per-platform renderers, in three entry points:

| Entry                   | Renders with                 | Needs                                                                            |
| ----------------------- | ---------------------------- | -------------------------------------------------------------------------------- |
| `dithered`              | canvas 2D                    | nothing                                                                          |
| `dithered/react`        | canvas 2D, in a `<canvas>`   | `react`, `react-dom`                                                             |
| `dithered/react-native` | `@shopify/react-native-skia` | `react`, `react-native`, `@shopify/react-native-skia`, `react-native-reanimated` |

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

## Composing presets

`compose` is a small set of pure helpers that take a `Brightness` and return a `Brightness`, so you can wrap or combine an existing preset instead of reimplementing it. Each helper is also a named export, following the `presets` pattern:

```ts
import { compose, presets } from 'dithered';
```

`compose` is equally available from `dithered/react-native` — it's a plain, platform-free module with no DOM or React Native imports of its own, so the two entries expose the identical set of helpers.

| Helper                      | Does                                                                         |
| --------------------------- | ---------------------------------------------------------------------------- |
| `blend(a, b, mix)`          | Linear mix of two brightnesses. `mix` is a number, or `(cell, t) => number`. |
| `mask(source, predicate)`   | Keeps `source` where `predicate(cell)` is true; skips it elsewhere.          |
| `timeScale(source, factor)` | Speeds up/slows down `source`'s loop by `factor`.                            |
| `reverse(source)`           | Plays `source`'s loop backwards.                                             |
| `offset(source, dt)`        | Shifts `source` in time by `dt` (looped).                                    |
| `invert(source)`            | `1 - b`, or `!b` for a boolean source.                                       |
| `clamp(source, min?, max?)` | Bounds `source` to `[min, max]` (default `0..1`).                            |

**Booleans**: a `Brightness` can return a boolean for a crisp, undithered edge (see `presets.fill`), and each helper has an explicit rule for what it does with one. `mask` and `invert` preserve booleans (a masked-in `true` stays `true`; an inverted `true` becomes `false`). `blend` and `clamp` always return a number — coercing `true`/`false` to `1`/`0` first — because a linear mix or a clamped bound isn't itself a crisp value. `timeScale`, `reverse` and `offset` only touch `t`, so whatever `source` returns (number or boolean) passes straight through.

**Compose order matters around `mask`**: a rejected cell from `mask` returns the boolean `false`, not the number `0` (see the table above) — and `invert`/`clamp` treat _any_ boolean, including that `false`, as a crisp value to coerce, not as "this cell was masked out". So `compose.invert(mask(source, predicate))` turns every masked-out cell into `true` (drawn solid), and `compose.clamp(mask(source, predicate), min, max)` turns every masked-out cell into `min` — likely not what you want if `min > 0`. Put `mask` _last_ in the chain (`mask(invert(source), predicate)`, `mask(clamp(source, min, max), predicate)`) so the masked-out cells stay `false` all the way out.

**`timeScale` and periodicity**: an **integer** `factor` keeps the loop seamless. A non-integer factor (e.g. `1.5`) breaks the `f(cell, 0) === f(cell, 1)` contract — the loop will visibly jump at the seam — so `compose.ts` warns once per distinct factor in development. The check does not fire in a production build (a bundler's `production` define makes it evaluate to `false` at runtime), but the code for it is not removed from the bundle — see ADR 0009's amendments for the measured trade-off.

**Example 1 — `sweep`, but slower and only on the left half:**

```ts
import { compose, presets } from 'dithered';

const brightness = compose.mask(presets.sweep(), (cell) => cell.u <= 0);
```

```tsx
import { Dithered } from 'dithered/react';
import { shapes } from 'dithered';

<Dithered shape={shapes.heart} brightness={brightness} period={4000} />;
```

For "slower", raise `period` on `Dithered` (or the core's frame timing) instead of reaching for `compose.timeScale` — `period` stretches the whole loop seamlessly, `compose` output included. `timeScale(source, factor)` scales a `Brightness`'s own loop instead, but a slowdown needs `factor < 1`, and the only integer in that range is the degenerate `0`, so slowing down through `timeScale` always means a non-integer factor and the seam described above. Concretely, `compose.timeScale(presets.sweep(), 0.5)` doesn't have a small, easy-to-miss seam — at `t → 1` the loop is at the exact centre of the sweep and snaps back to the sweep's start, the largest jump the shape can produce. `timeScale` is the right tool for _speeding up_ with an integer factor (`compose.timeScale(presets.sweep(), 2)` doubles the speed with no seam); for a seamless slowdown, use `period`.

**Example 2 — blending two presets with a time-varying mix:**

```ts
import { compose, presets } from 'dithered';

// Crossfades from `pulse` to `wave` and back, once per loop.
const brightness = compose.blend(
  presets.pulse(),
  presets.wave(),
  (_cell, t) => 0.5 - 0.5 * Math.cos(t * Math.PI * 2),
);
```

## Palettes

`fg` accepts an ordered palette of colors, darkest first, instead of a single color. A `Brightness` value then dithers between adjacent tones instead of just on/off, which is what makes larger, denser grids read as a "retro screen" rather than flat black-on-background:

```tsx
<Dithered
  shape={shapes.rozenite}
  brightness={presets.gem()}
  fg={['#2a1a4a', '#8232ff', '#d9c2ff']}
  size={120}
/>
```

**Quantization.** With a palette of `n` colors, brightness `b` maps to a level `L = b * n` in `0..n`: level `0` means the cell is skipped (background shows through), and level `k >= 1` means tone `k - 1`. A numeric `b` dithers between its two neighboring levels the same way single-color output dithers against `cell.threshold`, just spread across `n` bands instead of one — `b <= 0` (or `NaN`) always skips the cell, `b >= 1` always paints the brightest tone, and anything in between lands on the lower or higher of its two neighboring levels depending on where it falls within its band relative to `cell.threshold`. That includes the darkest band, `0 < b < 1/n`: its lower neighbor is level `0`, not a tone, so those cells dither _against the background_, not between two colors — only bands at `b >= 1/n` dither between two actual tones. A single color (a plain string, or a one-entry array) produces exactly the same result as this rule does at `n = 1` — that's what makes existing single-color output unaffected — but the shipped code takes a separate, hand-written fast path for it (`fg: string`, and the one-entry-array case) rather than routing single colors through the general palette/`toneLevel` machinery: same predicate (`b > cell.threshold`) written out inline, so there's no per-cell palette lookup, bucketing, or allocation when there's only one color to paint (see `toneLevel` in `dithered`'s exports for the general formula, and [ADR 0005](packages/dithered/docs/adrs/0005-multi-tone-palettes.md) for the equivalence proof between the two). Boolean brightness keeps its usual meaning regardless of palette size: `true` paints the brightest tone, `false` skips the cell. The result depends on `brightness` actually spanning its full `0..1` range — a preset whose output is effectively binary will show fewer tones than the palette has, however many colors you give it.

An empty palette (`fg: []`) has no sensible rendering and falls back to the default `'#000'` rather than throwing from inside the paint loop.

**`currentColor`**, anywhere in a palette, resolves to the canvas's own computed text color — handy for a spinner that should just match the surrounding text:

```tsx
<Dithered shape={shapes.circle} brightness={presets.pulse()} fg="currentColor" />
```

This is **web only** (`dithered/react` and plain `createDithered`; there is no computed style to resolve on native). It re-resolves whenever `createDithered`'s `update()` runs, and whenever `dithered/react`'s `<Dithered>` re-renders at all — so a `style={{ color: ... }}` swap on `<Dithered>` itself, or a theme class toggled on an _ancestor_ element (the common case, and the reason this isn't limited to `className`/`style`/`fg` changing on `<Dithered>` directly), both pick up the new color automatically as long as they cause `<Dithered>` to re-render. `refreshColors()` no-ops when the resolved color hasn't actually changed, so this costs nothing when there's nothing to do.

For a plain `createDithered` instance, or a theme change that doesn't cause `<Dithered>` to re-render at all (no state change reaches it), call `refreshColors()` yourself. From `dithered/react`, reach the instance with the `instanceRef` prop — an escape hatch alongside the regular `ref`, which keeps forwarding the canvas element unchanged:

```tsx
const instanceRef = useRef<DitheredInstance | null>(null);
// ...
<Dithered
  shape={shapes.circle}
  brightness={presets.pulse()}
  fg="currentColor"
  instanceRef={instanceRef}
/>;
// later, e.g. from a MutationObserver or an event that doesn't re-render this tree:
instanceRef.current?.refreshColors();
```

Passing `'currentColor'` to `dithered/react-native` throws:

```
dithered: 'currentColor' is not supported on native — pass an explicit color.
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

| Option                 | Type                          | Default                   | Description                                                                              |
| ---------------------- | ----------------------------- | ------------------------- | ---------------------------------------------------------------------------------------- |
| `shape`                | `Shape`                       | —                         | Required. Silhouette to sample cells inside.                                             |
| `brightness`           | `Brightness`                  | —                         | Required. Per-cell, per-frame brightness function.                                       |
| `size`                 | `number`                      | `48`                      | Height in CSS px (web) or dp (native); width follows the shape's aspect ratio.           |
| `cols`                 | `number`                      | `16`                      | Grid columns.                                                                            |
| `rows`                 | `number`                      | derived from aspect ratio | Grid rows.                                                                               |
| `frames`               | `number`                      | `48`                      | Frames per loop.                                                                         |
| `period`               | `number`                      | `2000`                    | Loop duration, ms.                                                                       |
| `fg`                   | `string \| readonly string[]` | `'#000'`                  | Fill color, or an ordered palette from darkest to brightest — see [Palettes](#palettes). |
| `bg`                   | `string`                      | `'transparent'`           | Background fill, or `'transparent'`.                                                     |
| `cache`                | `boolean \| 'auto'`           | `'auto'`                  | Web only. Pre-render the loop into a sprite strip. `'auto'` = on for `size <= 120`.      |
| `paused`               | `boolean`                     | `false`                   | Freeze the animation.                                                                    |
| `gap`                  | `number`                      | `0.09`                    | Gap between cells, as a fraction of cell size (min 0.6px).                               |
| `radius`               | `number`                      | `0.14`                    | Corner radius, as a fraction of cell size.                                               |
| `respectReducedMotion` | `boolean`                     | `true`                    | Render a single static frame under `prefers-reduced-motion`.                             |
| `initialFrame`         | `number`                      | `0`                       | Frame drawn synchronously on create, so there is no blank flash.                         |

### `DitheredInstance`

| Method                                      | Description                                                                                          |
| ------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `setPaused(paused: boolean)`                | Pause or resume the animation loop.                                                                  |
| `update(options: Partial<DitheredOptions>)` | Re-configure the instance in place; may resample cells and/or rebuild the sprite cache.              |
| `renderFrame(frame: number)`                | Draw a specific frame directly, bypassing the animation loop.                                        |
| `refreshColors()`                           | Re-resolve `'currentColor'` in `fg` and repaint if it changed. Web only — see [Palettes](#palettes). |
| `destroy()`                                 | Stop the loop and release all listeners/observers.                                                   |

`dithered/react`'s `Dithered` component accepts the same options as props (`shape`/`brightness` still required), plus `label` (accessible label, default `'Loading'`, `''` hides it from assistive tech), `className`, `style`, `progress`, and `instanceRef` (a `Ref<DitheredInstance | null>`, populated on mount and cleared on unmount — an escape hatch onto the instance, e.g. for calling `refreshColors()`; the regular `ref` keeps forwarding the canvas element, unchanged) — see [Determinate progress](#determinate-progress) and [React](#quick-start) above. `dithered/react-native`'s takes the same props with `style: StyleProp<ViewStyle>` in place of `className`/`style`, no `cache`, and an extra `cells` — see [React Native](#react-native) above.

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
