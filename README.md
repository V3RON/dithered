# dithered

[Live demo →](https://v3ron.github.io/dithered/)

`dithered` renders an animated ordered dither pattern masked to an SVG silhouette: it samples a coarse grid of cells inside a shape and, each frame, draws or skips a rounded square per cell by comparing a caller-supplied brightness value against a threshold from the configured dither matrix (a 4x4 Bayer threshold by default). The project started as a generalization of the Rozenite loading spinner into a standalone animated-shape primitive.

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

The props are the web component's, minus the DOM-only ones: `className` and `style: CSSProperties` become `style: StyleProp<ViewStyle>`, `label` maps to `accessibilityLabel` rather than `role="status"`, `cache` is gone (see [Performance notes](#performance-notes)), and `cells` is new. Everything else — `shape`, `brightness`, `size`, `cols`, `rows`, `matrix`, `frames`, `period`, `speed`, `fg`, `bg`, `gap`, `radius`, `paused`, `progress`, `time`, `onFrame`, `onLoop`, `initialFrame`, `respectReducedMotion`, `transition` — behaves identically, so a shared component can spread the same props object at both. (`matrix` is ignored when you also pass pre-sampled `cells` — see [Performance notes](#performance-notes).) One difference: `time` also accepts a Reanimated `SharedValue<number>` on native — see [Playback controls](#playback-controls).

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
instance.setTime(0.42); // drive playback externally — see Playback controls
instance.clearTime(); // ...and hand it back to the internal clock
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

Ready-made `Shape` objects, importable individually or via `shapes`: `rozenite` (the Rozenite gem mark), `circle`, `square`, `diamond`, `heart`, `check`, `cross`. `check` and `cross` share a `0 0 100 100` viewBox on purpose — see [Transitions](#transitions).

```ts
import { shapes } from 'dithered';

createDithered(canvas, { shape: shapes.heart, brightness: presets.pulse() });
```

Build a `Shape` from your own SVG with `shapeFromSvg`, which reads the root `viewBox` and walks the document collecting geometry in document order:

```ts
import { shapeFromSvg } from 'dithered';

const shape = shapeFromSvg(`
  <svg viewBox="0 0 100 100">
    <g transform="translate(50 50) rotate(15)">
      <rect x="-30" y="-30" width="60" height="60" rx="8" />
    </g>
  </svg>
`);
```

Supported geometry: `<path>` (its `d` verbatim), `<rect>` (including `rx`/`ry`), `<circle>`, `<ellipse>`, `<polygon>` and `<polyline>` — each converted to path data and concatenated, exactly as `<path>` values are today. `<line>` is accepted but contributes nothing (zero area). `transform` on an element or an ancestor `<g>` (`translate`, `scale`, `rotate`, `matrix`, `skewX`/`skewY`, composed left to right as SVG specifies) is baked into that element's coordinates, so nested groups from Figma/Illustrator exports work as expected.

A few things are skipped rather than drawn: `<defs>`, `<clipPath>`, `<mask>`, `<symbol>`, `<pattern>`, `<marker>` and similar non-rendered containers; anything under `display="none"`; and any geometry whose resolved `fill` is `none` with no `stroke` (Figma's `<svg fill="none">` + per-path `fill` is handled correctly — the root's `fill="none"` doesn't shadow a path that sets its own). A shape with `fill="none"` and a `stroke` still contributes its _fill_ area, since stroke outlines are out of scope — see the ADR below for the reasoning.

`fill-rule="evenodd"` is honored: `shape.fillRule` is set to `'evenodd'` when every contributing element agrees on it, and left `undefined` for the (default) `nonzero` case, so existing `Shape` values are unaffected. A document that mixes both rules throws, since one `Shape` can't represent both — split the file or normalize `fill-rule` in your editor.

`<use>`, `<text>` and `<image>` are not supported; a document containing only those throws a specific error telling you to expand symbols and convert text to outlines before re-exporting. See [ADR 0010](packages/dithered/docs/adrs/0010-wider-svg-input.md) for the full design.

**Known limitation:** every element's geometry is concatenated into one path string, so elements that overlap and rely on being filled _independently_ — a real SVG renderer always paints each element's own area solid, regardless of what's under it — will instead show a hole where they overlap, because the merged path's winding cancels there. If your SVG relies on this (two shapes touching or overlapping, each meant to render solid), union them into one shape in your editor before exporting.

`shapeFromSvg` uses `DOMParser`, so it is web-only. `shapeFromSvgLite` is the same contract implemented by scanning the source text into a tree rather than parsing it, and is exported from both `dithered` and `dithered/react-native`:

```ts
import { shapeFromSvgLite } from 'dithered/react-native';
```

It handles well-formed SVG as design tools emit it — comments and CDATA are skipped, attributes may be single- or double-quoted, tag names are matched case-insensitively, numeric and predefined character references are expanded — but it is not an XML parser: an undefined named entity is left as written, there's no DTD or validation, and a `>` inside an attribute value will confuse it. On the web, prefer `shapeFromSvg`.

A `Shape` is plain data (`{ path, viewBox, fillRule? }`), so the other option is to convert once at build time and commit the result — which is all `shapes.ts` is:

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

## Responsive sizing

Pass `size="fill"` to have the instance track its parent element instead of a fixed CSS-px height — useful for a hero or empty-state illustration that should fill its container:

```tsx
<div style={{ width: '100%', height: 240 }}>
  <Dithered shape={shapes.rozenite} brightness={presets.gem()} size="fill" fg={ACCENT} />
</div>
```

- The parent's **content box** is contain-fitted to the shape's aspect ratio: width still follows from height and the shape, exactly as with a numeric `size` — `'fill'` only changes where the height comes from. Give the parent an actual size (a fixed height, `flex: 1` in a sized flex column, `height: 100%` under a sized ancestor, ...); a parent that shrink-wraps its own content around the canvas has nothing to fit against.
- Resizing is cheap: a resize only resamples cells if `shape`/`cols`/`rows` change (never for a plain resize), and the sprite-strip cache is only rebuilt once the size has moved by about one grid cell — smaller moves just rescale the existing sprite. A parent that collapses to zero size (`display: none`, a collapsed flex item, before layout) pauses the instance rather than erroring; it picks back up the moment the parent has real size again. If the canvas isn't mounted in the document yet, no observer is created at all; a `console.warn` fires once and the instance falls back to the numeric default until an `update()` call finds it attached.
- The size an active `ResizeObserver` delivers is treated as the source of truth: an `update()` call that changes some other option (as `<Dithered>` does on every prop change, since it always resends `size: 'fill'` alongside whatever changed) re-measures the parent only if that same `update()` call finds the canvas reparented or its `shape` changed — never on an unrelated option, so a live, sub-pixel-accurate observed size is never overwritten by a coarser synchronous `clientWidth`-based re-measurement. Without a native `ResizeObserver` at all (very old browsers, or a bare non-browser environment), there's no live delivery to protect, so any `update()` that explicitly resends `size: 'fill'` re-measures synchronously instead. Reparenting is only detected this way — by an `update()` call running afterwards — so a framework that moves the canvas to a new parent without ever calling `update()` again keeps being driven by the old parent's box; call `update({ size: 'fill' })` (or any other prop change) once after a manual reparent to pick up the new one.
- **Web only.** `size: 'fill'` needs a DOM parent to measure, so `dithered/native` narrows `size` to `number` at the type level and throws a clear error at runtime if it ever gets `'fill'` — size the Skia `<Canvas>` through its `style` prop instead.

`maxDpr` (default `3`) caps how high the backing store's resolution follows `devicePixelRatio` — the instance also re-checks `devicePixelRatio` itself, so dragging the window to a different-scale monitor or zooming the browser keeps the canvas crisp without any caller code, and `cache: 'auto'`'s `size <= 120` threshold is evaluated against the _resolved_ size, so a filled 400px hero correctly skips the sprite-strip cache while a filled 60px box still uses it. An explicit `cache: true` at a large resolved size (most reachable via `size: 'fill'`) is checked against the canvas dimension limit browsers silently clamp to; if the sprite strip would exceed it, a `console.warn` fires once and the instance falls back to painting each frame directly instead of blitting a blank strip.

## Determinate progress

For a progress indicator rather than a loop, pass `progress` (`0`–`1`) to `Dithered`. It's sugar over `time` (below) with playback paused: the frame index `Math.floor(progress * (frames - 1))` is selected, then mapped to the exact phase that quantizes back to that frame — not the naive `setTime(progress * (frames - 1) / frames)`, which loses a bit in the round trip through the frame grid for most frame counts (`frames: 48`, the default, among them). `progress` and `time` are mutually exclusive: if both are passed, `time` wins.

```tsx
<Dithered shape={shapes.square} brightness={presets.fill()} progress={downloadedFraction} />
```

> `progress`'s frame mapping now floors instead of rounds (`progress={0.5}` at the default `frames: 48` selects frame 23, not 24), so it agrees with how free-running playback quantizes phase to a frame. Only interior values shift by at most one frame; the endpoints (`0` and `1`) are exact — `progress={1}` always selects frame `frames - 1`, at every frame count.

## Playback controls

Time is an input, not just an internal detail. By default an instance drives itself off a self-contained clock (a phase accumulator in loop units — `phase += (dt / period) * speed`, see `packages/dithered/docs/adrs/0006-playback-controls.md`), but every part of that clock can be taken over from outside:

- **`speed`** (default `1`) scales the playback rate. Negative values play the loop backwards. Changing `speed` mid-loop is continuous — it scales the _increment_, not the accumulated phase, so there's never a jump.
- **`onFrame(frame, t)`** fires after a frame is painted, with the frame index and the loop phase `t` in `[0, 1)`. It fires at most once per painted frame — never for a redraw that lands back on the same index — including the very first paint at `initialFrame`. On native it crosses to the JS thread via `runOnJS`; it's not meant for per-frame work.
- **`onLoop(loops)`** fires each time the internal clock's loop wraps, with the signed cumulative loop count (negative once a backwards-playing loop wraps past 0). It's coalesced: a single stall that crosses several loop boundaries at once still fires only one call, with the final count. It does **not** fire for `time`/`progress` — a jump isn't a wrap.
- **`time`** drives playback externally, in loop units (`1` = one full loop — fractional values scrub within a loop, values past `1` or below `0` are just more loops). Setting it pauses the internal clock; clearing it back to `undefined` (or `null`, which behaves exactly like an absent prop — handy for `time={someOptionalTime ?? null}`) hands playback back, continuing from wherever `time` left the phase rather than snapping back to where the clock was interrupted. A non-finite value (`NaN`, `Infinity`) — e.g. `time={scrollY / contentHeight}` before layout has produced a real ratio — is ignored: passing `time` at all still hands the clock over, so the displayed frame literally holds until a finite value arrives, rather than flashing to frame `0` or running on underneath. Two instances driven by the same `time` always render the same frame, since the frame is a pure function of `(phase, frames)` with no hidden origin — useful for keeping independent indicators in lockstep. On `dithered/native`, `time` also accepts a Reanimated `SharedValue<number>`; a gesture or scroll handler writing straight into it reaches the picture swap without a JS round trip.

```tsx
// React: scrub-driven, two instances in lockstep
<Dithered shape={shapes.rozenite} brightness={presets.gem()} time={scrollProgress} />
<Dithered shape={shapes.heart} brightness={presets.pulse()} time={scrollProgress} />

// React Native: driven by a shared value, no JS round trip
<Dithered shape={shapes.rozenite} brightness={presets.gem()} time={sharedProgress} />
```

On the core API, the equivalent is `instance.setTime(t)` / `instance.clearTime()` (see [Vanilla](#vanilla) above), plus `speed`, `onFrame` and `onLoop` in the options object passed to `createDithered`.

The playground's [live demo](https://v3ron.github.io/dithered/) has a "Scrub playback" example built on `time`, next to a free-running instance for comparison.

## Static rendering

`renderToSvg` and `renderToDataURL` render a single frame to an SVG string (or a `data:image/svg+xml` URL) with no DOM, canvas or Skia — they run under plain Node, in a Web Worker, or on an edge runtime. They draw through the same `paintFrame` the live canvas/Skia renderers use, so static output cannot drift from what a mounted `<Dithered>` shows:

```ts
import { renderToSvg, renderToDataURL, shapes, presets } from 'dithered';

const svg = renderToSvg({
  shape: shapes.rozenite,
  brightness: presets.gem(),
  fg: '#8232ff',
  cols: 16,
});

const dataUrl = renderToDataURL({ shape: shapes.heart, brightness: presets.pulse(), frame: 12 });
```

Both take the same `DitheredOptions` as `createDithered`/`<Dithered>`, plus:

| Option      | Type     | Default | Description                                                          |
| ----------- | -------- | ------- | -------------------------------------------------------------------- |
| `frame`     | `number` | `0`     | Frame index to render, taken modulo `frames`.                        |
| `precision` | `number` | `3`     | Decimal places in emitted coordinates.                               |
| `title`     | `string` | —       | Emitted as `<title>`, for accessible inline SVG. Omitted when unset. |

The `viewBox` is `0 0 W H`, where `W`/`H` are the same CSS-pixel size (`surfaceSize`) `createDithered` paints under its device transform — output is resolution independent, and matches the live canvas's displayed geometry **exactly**, on both axes, for every `size` and `devicePixelRatio`. The canvas's rounded, integer backing store still introduces a sub-device-pixel rasterization difference, but that is pixel snapping, not a geometry mismatch.

### Use a frame as a favicon

```ts
import { renderToDataURL, shapes, presets } from 'dithered';

const link = document.createElement('link');
link.rel = 'icon';
link.href = renderToDataURL({
  shape: shapes.rozenite,
  brightness: presets.pulse(),
  size: 32,
  cols: 12,
});
document.head.appendChild(link);
```

### Determinism: `jsHitTester`

Sampling which cells fall inside a shape needs a point-in-path test, and `Path2D`/Skia don't have to agree with each other at a cell centre that lands within a fraction of a pixel of the silhouette edge. `jsHitTester(shape, options?)` is a pure-JS, dependency-free point-in-path test (parses the path's `d` string, flattens curves adaptively, then does scanline point-in-polygon) that answers identically everywhere, so it is the **default** hit tester for `sampleCells`, `createDithered`, `<Dithered>` (web and native) and static rendering alike — canvas playback, Skia playback and server-rendered SVG all sample the same cells from the same code. `domHitTester`/`skiaHitTester` remain available as an explicit `hitTest` option for callers who specifically want canvas/Skia rasterization instead. `jsHitTester` defaults to the `'nonzero'` fill rule (matching `Path2D`/Skia's own default); pass `{ fillRule: 'evenodd' }` for shapes authored that way.

### SSR fallback

`dithered/react`'s `<Dithered>` renders, as a `background-image` data URL (with matching CSS width/height) on the `<canvas>`, an SVG of the frame the component is about to paint on mount — `initialFrame`, or, when `progress` is set, `Math.round(clamp(progress) * (frames - 1))`, the same frame the determinate-progress effect renders — until the component has mounted and painted for real, so server-rendered HTML shows the shape instead of a blank canvas. A determinate `<Dithered progress={0.9} />` therefore server-renders frame 42 of a 48-frame loop directly, rather than flashing frame 0 first. Opt out with `ssrFallback={false}`.

## Transitions

A loading indicator almost always ends in a state change — success, error, done — and `update()`/a plain prop change cuts straight to it, mid-loop. `transitionTo`/`transition` morph into the change instead: both shapes are sampled onto the same grid, cells that leave and cells that arrive dissolve on complementary Bayer schedules (so the canvas is never empty), and brightness crossfades between the two, each side still ticking on its own loop phase so neither jumps.

```tsx
<Dithered
  shape={done ? shapes.check : shapes.rozenite}
  brightness={done ? presets.fill() : presets.gem()}
  transition={{ duration: 400 }}
  fg="#8232ff"
/>
```

The snippet above inlines `presets.fill()`/`presets.gem()` for brevity, but `brightness` (like `shape`) is diffed by identity — give it a stable reference (a module-level preset, as `LOADING_DONE_FILL`/`LOADING_DONE_GEM` do in the playground, or `useMemo`/`useCallback`), or an unrelated re-render creates a new closure each time and, with `transition` set, cuts a running morph short to start a pointless one from the shape to itself on every render.

Setting `transition` (an object; `{}` is enough to opt in) is what makes a `shape`/`brightness` prop change morph instead of cut — on both `dithered/react` and `dithered/native`, with identical props. With the vanilla/core API, call `instance.transitionTo(patch)` instead of `instance.update(patch)`:

```ts
await instance.transitionTo({ shape: shapes.check, brightness: presets.fill() });
```

`transitionTo` computes its target exactly like `update()` would, and resolves once that target is the new steady state — it never rejects, even if the transition is interrupted (see below). `transition.duration` (default `400`) sets how long the morph takes; `transition.onLoopEnd` (default `false`) waits for the current loop to reach phase 0 before starting it, so a morph never begins mid-cycle either.

```ts
await instance.finishLoop(); // resolves the next time playback wraps to phase 0
```

`finishLoop()` is what `onLoopEnd` is built on, and it is also safe to call directly. It resolves early — rather than hanging — if the loop stops advancing before it would otherwise wrap: `setPaused(true)`, the tab going hidden, the canvas leaving the viewport, reduced motion, or `destroy()`. Resolution means "the loop is not mid-cycle any more", not "a full cycle played". The same rule applies to a transition itself: one already in flight when playback halts (or when a second `transitionTo` starts) completes immediately, landing on its target rather than freezing half-morphed.

A shape's `cols`/`rows` grid comes from its aspect ratio, and the morph always runs on the _target's_ grid — so pairing shapes with a shared viewBox aspect (like the built-in `check`/`cross`, both `0 0 100 100`) keeps a transition from resizing the canvas mid-morph. A mismatched pair still works; the canvas just resizes to the target at the start of the morph instead.

`prefers-reduced-motion` (web) / `useReducedMotion()` (native) skips the morph entirely when `respectReducedMotion` is set (the default) — `transitionTo` cuts straight to the target and resolves immediately, same as `update()`.

`blend(a, b, mix)` is the brightness crossfade `transitionTo` itself uses, also useful on its own — `mix` is clamped to `[0, 1]`, and `mix = 0`/`mix = 1` reproduce `a`/`b`'s draw decisions exactly (a boolean brightness is coerced to a level — `true → 1`, `false → 0` — before blending):

```ts
import { blend, presets } from 'dithered';

const brightness = blend(presets.gem(), presets.pulse(), 0.5);
```

## Performance notes

### Web

- **Sprite-strip cache**: with `cache: 'auto'` (the default), instances at `size <= 120` pre-render every frame of the loop into an offscreen canvas once; steady-state playback then costs a single `drawImage` per frame instead of redrawing every cell. The threshold is checked against the _resolved_ size, so `size="fill"` opts in or out correctly depending on how big it ends up.
- **Responsive resizing** (`size="fill"`, and `devicePixelRatio` changes) never re-samples cells, and only rebuilds the sprite-strip cache once the backing-store size has moved by about one grid cell — see [Responsive sizing](#responsive-sizing).
- **Pauses automatically** when the tab is hidden (`document.visibilitychange`) or the canvas scrolls out of the viewport (`IntersectionObserver`), and resumes when either condition clears.
- **`prefers-reduced-motion`**: a single static frame is rendered and the animation loop never starts, unless `respectReducedMotion: false` is set.
- Frame index is quantized to `frames` steps per `period`, and a repeated frame index is never redrawn.

### React Native

- **Every frame is pre-recorded** as an `SkPicture`, and playback only swaps which recording the canvas draws — from a Reanimated frame callback, so the loop runs entirely on the UI thread with no per-frame JS work and no bridge traffic. `cache` is therefore ignored: pictures are display lists rather than bitmaps, so the memory trade-off that makes pre-rendering optional on the web does not apply.
- Recordings are in dp. Skia scales to the device pixel ratio itself and the output is vector, so there is nothing to re-record per device.
- **Pauses automatically** when the app leaves the foreground (`AppState`). There is no `IntersectionObserver` equivalent, so a scrolled-away instance keeps playing — cheaply, on the UI thread.
- **Reduced motion** comes from Reanimated's `useReducedMotion()`, honoured unless `respectReducedMotion: false` is set.
- Pass `cells` (from `sampleCells`) to skip the shape hit-test at mount if you are creating many instances of the same shape and grid. `matrix` is ignored when `cells` is supplied — the thresholds are already baked into those cells, the same way `cols`/`rows` already behave alongside `cells`.

## API

### `DitheredOptions`

| Option                 | Type                                 | Default                   | Description                                                                                                                                                                      |
| ---------------------- | ------------------------------------ | ------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shape`                | `Shape`                              | —                         | Required. Silhouette to sample cells inside.                                                                                                                                     |
| `brightness`           | `Brightness`                         | —                         | Required. Per-cell, per-frame brightness function.                                                                                                                               |
| `size`                 | `number \| 'fill'`                   | `48`                      | Height in CSS px (web) or dp (native); width follows the shape's aspect ratio. `'fill'` tracks the parent's content box — web only, see [Responsive sizing](#responsive-sizing). |
| `maxDpr`               | `number`                             | `3`                       | Web only. Upper bound on the backing-store device pixel ratio.                                                                                                                   |
| `cols`                 | `number`                             | `16`                      | Grid columns.                                                                                                                                                                    |
| `rows`                 | `number`                             | derived from aspect ratio | Grid rows.                                                                                                                                                                       |
| `matrix`               | `DitherMatrix`                       | `'bayer4'`                | Ordered-dither threshold pattern — see [Dither matrices](#dither-matrices).                                                                                                      |
| `frames`               | `number`                             | `48`                      | Frames per loop.                                                                                                                                                                 |
| `period`               | `number`                             | `2000`                    | Loop duration, ms.                                                                                                                                                               |
| `fg`                   | `string \| readonly string[]`        | `'#000'`                  | Fill color, or an ordered palette from darkest to brightest — see [Palettes](#palettes).                                                                                         |
| `bg`                   | `string`                             | `'transparent'`           | Background fill, or `'transparent'`.                                                                                                                                             |
| `cache`                | `boolean \| 'auto'`                  | `'auto'`                  | Web only. Pre-render the loop into a sprite strip. `'auto'` = on for `size <= 120`.                                                                                              |
| `paused`               | `boolean`                            | `false`                   | Freeze the animation.                                                                                                                                                            |
| `gap`                  | `number`                             | `0.09`                    | Gap between cells, as a fraction of cell size (min 0.6px).                                                                                                                       |
| `radius`               | `number`                             | `0.14`                    | Corner radius, as a fraction of cell size.                                                                                                                                       |
| `respectReducedMotion` | `boolean`                            | `true`                    | Render a single static frame under `prefers-reduced-motion`.                                                                                                                     |
| `initialFrame`         | `number`                             | `0`                       | Frame drawn synchronously on create, so there is no blank flash.                                                                                                                 |
| `hitTest`              | `HitTester`                          | `jsHitTester(shape)`      | Point-in-path test used to sample cells. See [Determinism](#determinism-jshittester).                                                                                            |
| `speed`                | `number`                             | `1`                       | Playback rate multiplier. Negative values play backwards. See [Playback controls](#playback-controls).                                                                           |
| `onFrame`              | `(frame: number, t: number) => void` | —                         | Called after a frame is painted. See [Playback controls](#playback-controls).                                                                                                    |
| `onLoop`               | `(loops: number) => void`            | —                         | Called each time the internal clock's loop wraps. See [Playback controls](#playback-controls).                                                                                   |
| `transition`           | `TransitionOptions`                  | unset                     | Morph into a `shape`/`brightness` change instead of cutting — see [Transitions](#transitions).                                                                                   |

### `TransitionOptions`

| Option      | Type      | Default | Description                                                 |
| ----------- | --------- | ------- | ----------------------------------------------------------- |
| `duration`  | `number`  | `400`   | Duration of the morph in ms.                                |
| `onLoopEnd` | `boolean` | `false` | Wait for the current loop to reach phase 0 before starting. |

### `DitheredInstance`

| Method                                          | Description                                                                                                                                                      |
| ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `setPaused(paused: boolean)`                    | Pause or resume the animation loop.                                                                                                                              |
| `update(options: Partial<DitheredOptions>)`     | Re-configure the instance in place; may resample cells and/or rebuild the sprite cache.                                                                          |
| `transitionTo(patch: Partial<DitheredOptions>)` | Like `update()`, but morphs into the change over `transition.duration` — see [Transitions](#transitions). Returns a `Promise<void>` that never rejects.          |
| `finishLoop()`                                  | Returns a `Promise<void>` that resolves the next time playback wraps to phase 0 (or early, if the loop stops advancing first) — see [Transitions](#transitions). |
| `renderFrame(frame: number)`                    | Draw a specific frame directly, bypassing the animation loop.                                                                                                    |
| `refreshColors()`                               | Re-resolve `'currentColor'` in `fg` and repaint if it changed. Web only — see [Palettes](#palettes).                                                             |
| `setTime(t: number)`                            | Drive playback externally, in loop units. Halts the internal clock.                                                                                              |
| `clearTime()`                                   | Hand playback back to the internal clock, resuming from the current phase.                                                                                       |
| `destroy()`                                     | Stop the loop and release all listeners/observers.                                                                                                               |

`dithered/react`'s `Dithered` component accepts the same options as props (`shape`/`brightness` still required, `hitTest` not exposed as a prop), plus `label` (accessible label, default `'Loading'`, `''` hides it from assistive tech), `className`, `style`, `progress`, `time`, `ssrFallback` (default `true`), and `instanceRef` (a `Ref<DitheredInstance | null>`, populated on mount and cleared on unmount — an escape hatch onto the instance, e.g. for calling `refreshColors()`; the regular `ref` keeps forwarding the canvas element, unchanged) — see [Determinate progress](#determinate-progress), [Playback controls](#playback-controls), [SSR fallback](#ssr-fallback) and [React](#quick-start) above. `dithered/react-native`'s takes the same props with `style: StyleProp<ViewStyle>` in place of `className`/`style`, no `cache`, a `time` that also accepts a `SharedValue<number>`, and an extra `cells` — see [React Native](#react-native) above. On both, setting `transition` routes a `shape`/`brightness` prop change through the morph described in [Transitions](#transitions) instead of cutting.

### Sampling

`sampleCells(shape, cols, hitTest?, rows?, matrix?)` returns the cells inside a shape. `hitTest` defaults to `jsHitTester(shape)` (pure JS, no DOM or Skia — see [Determinism](#determinism-jshittester) above); pass `domHitTester(shape, ctx?)` from `dithered` (backed by `Path2D`) or `skiaHitTester(shape)` from `dithered/react-native` (backed by `SkPath.contains`) to sample against canvas/Skia rasterization instead. `matrix` defaults to `'bayer4'` and picks the dither threshold pattern — see [Dither matrices](#dither-matrices).

```ts
import { sampleCells, jsHitTester, shapes } from 'dithered';

const cells = sampleCells(shapes.heart, 16); // same as sampleCells(shapes.heart, 16, jsHitTester(shapes.heart))
```

## Dither matrices

Every cell's `threshold` comes from a tiled **dither matrix**, picked with the `matrix` option (default `'bayer4'`, the classic 4x4 ordered-dither table):

```tsx
<Dithered shape={shapes.heart} brightness={presets.pulse()} matrix="bayer8" />
```

| `matrix`      | What it is                                                                |
| ------------- | ------------------------------------------------------------------------- |
| `'bayer2'`    | 2x2 Bayer matrix. Very coarse; mostly useful as a building block.         |
| `'bayer4'`    | 4x4 Bayer matrix. The default — matches every release before this option. |
| `'bayer8'`    | 8x8 Bayer matrix, generated from `'bayer4'` by the same recurrence.       |
| `'blueNoise'` | A precomputed 16x16 blue-noise table (void-and-cluster).                  |
| a 2D array    | Your own threshold pattern — see below.                                   |

At the default `cols = 16`, the 4x4 `'bayer4'` tile repeats four times across the grid and reads as fine grain. At `cols >= 32` it repeats often enough that the eye resolves the tile itself, and the output starts looking like a checkerboard rather than a dither. Reach for `'bayer8'` (repeats less often, still has Bayer's crisp geometric look) or `'blueNoise'` (no repeating axis-aligned structure at all, so it hides tiling best) once you turn `cols` up.

### Custom matrices

A custom matrix is any rectangular 2D array of numbers, tiled across the grid the same way the built-ins are. How its entries are read is decided once, from the whole array:

- **Every entry an integer** → the array is read as **ranks**: entry `v` becomes threshold `(v + 0.5) / n`, where `n` is the array's entry count (width × height) — the same formula the library has always used for `BAYER_4`. Ranks don't need to be a permutation; ties and gaps are fine.
- **Any entry non-integer** → every entry is read as a **threshold** directly, and must lie in `0..1`. No `+0.5` shift is applied — you've already said exactly where the threshold is.

This means an all-integer matrix like `[[0, 1], [1, 0]]` is read as **ranks** (giving thresholds `0.125`/`0.375`), not as ready-made 0/1 thresholds — because the rule is "are these integers", not "do these look like a 0..1 range". Write `[[0.25, 0.75], [0.75, 0.25]]` (a non-integer array) if you want exactly those two thresholds.

A ragged array (rows of different lengths), a non-finite entry, or a rank/threshold outside its valid range throws a clear `dithered: ` error naming the offending row or cell — validation happens once when the matrix is resolved, not per cell.

A custom `matrix` array (or a hand-built `ResolvedMatrix`) is resolved and cached **by identity, not content**, so once you've handed one to the library it must be treated as immutable. Mutating it in place afterwards is invisible: the stale thresholds keep being returned forever, and — the sharper edge — a matrix mutated into an invalid one (ragged, or entries out of range) is never re-validated, silently bypassing the guarantees above. Build a new array and pass that instead of mutating an existing one.

As with `shape` and `brightness`, a custom `matrix` array is compared by identity in the React wrapper's reconfigure effect: hoist it to module scope (or memoize it) rather than passing a fresh array literal as a prop, or every render triggers a resample. The same applies to `dithered/native`'s `useDitheredPictures`/`<Dithered>` — there an inline `matrix={[[0, 1], [2, 3]]}` is worse than a wasted resample, since it re-records every `SkPicture` in the frame strip on each render.

`dithered`'s `bayer2`/`bayer4`/`bayer8`/`blueNoise` tables, plus `bayerMatrix(order)` (which generates any power-of-two Bayer matrix) and the lower-level `resolveMatrix`/`thresholdFor` helpers `sampleCells` is built on, are all exported if you want to build on them directly. The blue-noise table is generated offline by `packages/dithered/scripts/blue-noise.mjs` (`pnpm --filter dithered generate:blue-noise`) and committed as source — regenerate it only if you're changing the generator itself.

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
