# 0007 — Static rendering (`renderToSvg` / `renderToDataURL`) and a pure-JS hit tester

## Status

Proposed. Implements [#7](https://github.com/V3RON/dithered/issues/7). Builds on the
platform-free core and injected hit testers introduced in
[#3](https://github.com/V3RON/dithered/pull/3).

## Context

`dithered` paints every frame at runtime into a canvas (web) or an `SkPicture` (native).
Three gaps follow from that:

1. **SSR.** `dithered/react` renders a bare `<canvas>`. Server-rendered HTML shows
   nothing until hydration; `initialFrame` only removes the flash once the client
   has mounted.
2. **Non-canvas outputs.** A single frame is useful as a favicon, an OG image, an
   email asset or an inline SVG in documentation. None of those can run a canvas.
3. **Platform-free sampling.** `sampleCells` needs a `HitTester`, and both existing
   implementations need a platform: `domHitTester` uses `Path2D` +
   `CanvasRenderingContext2D.isPointInPath`, `skiaHitTester` uses
   `SkPath.contains`. Node, Web Workers and edge runtimes have neither, so cells
   cannot be sampled there at all.

A fourth, quieter problem motivates the same work: `Path2D` and Skia do not have to
agree. Both rasterize a path to decide containment, and for a cell centre that lands
within a fraction of a device pixel of the silhouette edge, the two can disagree.
The grid is coarse (16 columns by default), so one flipped cell is visible. Today the
web and native renderers can therefore produce visibly different frames from the same
`Shape`, and neither is reproducible on a server.

The unit of geometry the library needs is small: _is this point inside this path?_ —
answered identically everywhere, from the path `d` string alone.

Issue [#10](https://github.com/V3RON/dithered/issues/10) (wider SVG input: `<circle>`,
`<rect>`, `<polygon>`, transforms) needs the same SVG path-data parser. That work is
in flight in parallel, so the parser here must be a self-contained module with an API
that #10 can adopt rather than something welded to hit testing.

## Decision

Add a path-geometry module, a pure-JS hit tester built on it, an SVG `PaintContext`,
and two static-render entry points. Five decisions carry the design.

### 1. A self-contained path module: `core/path.ts`

One module, no imports from the rest of the library, three exported layers:

```ts
export type Point = { x: number; y: number };

/** Absolute, de-sugared path commands. */
export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' };

export function parsePath(d: string): PathCommand[];
export function flattenPath(commands: readonly PathCommand[], tolerance: number): Point[][];
export function pathToPolygons(d: string, tolerance: number): Point[][];
export function arcToCubics(/* endpoint-parameterized arc */): PathCommand[]; // exported for #10
```

`parsePath` **normalizes**: relative commands become absolute, `H`/`V` become `L`,
`S`/`T` resolve their reflected control point, `A` is converted to cubics, and every
implicit repeat (`M 0 0 10 10 20 20` → moveto + two linetos; note the moveto-repeat
special case) is expanded. Consumers therefore only ever see five command types.
Rationale: everything downstream — flattening here, and shape extraction in #10 —
wants absolute, de-sugared commands; making each consumer re-implement the sugar is
where path bugs live. `arcToCubics` is exported separately because #10 will need it
for `<ellipse>`/`<circle>` if it chooses to route those through path data.

Parser details fixed here:

- The number scanner accepts SVG's full number grammar: leading `+`/`-`, implicit
  leading/trailing decimal point (`.5`, `5.`), exponents (`1e-3`), and numbers run
  together where unambiguous (`1.5.5` = `1.5`, `0.5`; `1-2` = `1`, `-2`).
- Separators are any run of whitespace and commas.
- Arc flags are **single characters** (`a 5 5 0 11 10 10` is four args, not two) —
  the one place SVG's grammar is not "parse a number".
- `Z`/`z` closes the current subpath; a following drawing command without an
  intervening `M` starts a new subpath **at the closed subpath's start point**, per
  spec.
- A leading relative `m` is treated as absolute (its first coordinate pair is
  relative to the origin), per spec.
- Malformed input throws a `RangeError`-flavoured `Error` naming the offending
  offset, rather than silently truncating. (`shapeFromSvg*` already throws on bad
  input; consistency matters more than salvage here.)

`flattenPath` converts each subpath to a polygon of points by **adaptive recursive
subdivision** of cubics and quadratics, using the standard control-point-distance
flatness test against the chord, with a hard recursion depth cap of 24 so a
degenerate curve cannot hang. Subpaths are emitted as open point lists; the consumer
treats them as implicitly closed (a polygon's last point joins its first). Empty and
single-point subpaths are dropped.

### 2. Flattening tolerance: `max(viewBox.width, viewBox.height) / 4000`

Tolerance is a distance in the shape's own viewBox units, so it must scale with the
viewBox. The default is `max(vb.width, vb.height) / 4000`, floored at `1e-9`, and is
overridable per call.

Sizing: for a 100-unit viewBox that is a tolerance of 0.025 units. The relevant
comparison is against the cell pitch at the highest column count we promise parity
for (`cols = 64` → pitch 1.5625 units), so the flattening error is ~1/60th of a cell.
A cell centre is misclassified only if it lies within 0.025 units of the true edge,
which no built-in shape's grid does. The cost is trivial and paid once per
`jsHitTester` call: a full circle of radius 40 flattens to roughly 180 segments, and
flattening happens once, not per point.

Rejected: a fixed absolute tolerance (breaks on viewBoxes that aren't ~100 units) and
a tolerance derived from `cols` (couples the geometry layer to the sampling grid, and
#10 wants the parser without a grid).

### 3. Fill rule: nonzero by default, even-odd opt-in

`jsHitTester(shape, { fillRule })` defaults to `'nonzero'`. That matches SVG's default
`fill-rule`, `isPointInPath`'s default, and `SkPath.contains` (Skia's default winding
fill type), so the default agrees with both existing hit testers. `'evenodd'` is
accepted for shapes authored that way.

Both rules run over the flattened polygons with a single scanline pass:

- **nonzero** — accumulate the winding number from directed edge crossings of the
  ray `y = py, x > px`.
- **evenodd** — parity of the same crossings.

**Point-on-edge behaviour** is made deterministic rather than left to floating point:
edges are treated as **half-open in `y`** (`(y0 > py) !== (y1 > py)`), which is the
standard watertight rule — a vertex shared by two edges is counted exactly once, and a
horizontal edge is never counted. A point lying _exactly_ on a boundary is therefore
classified consistently (inside for a left edge, outside for a right edge) but that
classification is **explicitly not guaranteed to match `Path2D` or Skia**, both of
which leave the exact-boundary case to their rasterizers. This is documented in the
`jsHitTester` doc comment. The sampling grid makes it a non-issue in practice: cell
centres sit at `(i + 0.5) / cols` of the viewBox, which does not land on any built-in
shape's edge coordinates.

### 4. `jsHitTester` becomes the default for `sampleCells`, and for both renderers

`sampleCells`'s `hitTest` parameter becomes optional:

```ts
sampleCells(shape, cols, hitTest = jsHitTester(shape), rows?)
```

The parameter keeps its position, so #3's call sites and the documented
`sampleCells(shape, cols, domHitTester(shape, ctx), rows)` form still compile and
behave identically. `domHitTester` and `skiaHitTester` remain exported and supported
as opt-in.

`createDithered` (web) and `useDitheredPictures` / `<Dithered>` (native) stop reaching
for their platform tester and fall through to the default. This is the decision that
makes "static and live cannot drift" true rather than aspirational: server-rendered
SVG, canvas playback and Skia playback all sample the same cells from the same code.

To keep the platform testers reachable from the renderers, `DitheredOptions` gains an
optional `hitTest?: HitTester`. `ResolvedOptions` changes from
`Required<DitheredOptions>` to `Required<Omit<DitheredOptions, 'hitTest'>> & { hitTest?: HitTester }`
so the option can legitimately stay absent; `assignDefined` and `resolveOptions` are
otherwise unchanged.

Trade-off accepted: `jsHitTester` parses and flattens the path on every
`configure()`, where `domHitTester` handed the work to the browser. Measured against
what `configure()` already does (sampling `cols × rows` points and pre-painting
`frames` sprite-strip frames), the flatten is noise, and it buys determinism plus a
core that runs anywhere.

### 5. An SVG `PaintContext`, so `paintFrame` stays the single source of truth

No second painter. `svgPaintContext()` returns an object satisfying the existing
`PaintContext` interface that records elements instead of rasterizing:

```ts
export interface SvgPaintContext extends PaintContext {
  /** Serialized child elements, in paint order. */
  toMarkup(): string;
}
export function svgPaintContext(options?: { precision?: number }): SvgPaintContext;
```

- `fillRect` emits a `<rect>` immediately (this is how `paintFrame` paints `bg`).
- `beginPath` clears the pending shape; `rect`/`roundRect` record it; `fill` emits it
  with the current `fillStyle`. `roundRect` **is** implemented, so SVG output takes
  the same branch as a modern canvas.
- Consecutive elements sharing a fill are wrapped in one `<g fill="…">`, which both
  shrinks the output and is exactly the grouping the palette PRD will want ("one
  `<g fill>` per tone"). A run of one still gets a `fill` attribute on the `<rect>`
  rather than a wrapper.
- Numbers are rounded to `precision` decimals (default 3) with trailing zeros
  stripped, so output is compact and byte-stable across runs.
- Attribute values are XML-escaped (`&`, `<`, `>`, `"`), so a caller-supplied `fg`
  cannot break the document.

`renderToSvg` then does exactly what `createDithered` does, with a different context:

```ts
export interface RenderToSvgOptions extends DitheredOptions {
  /** Frame index to render. Default 0. */
  frame?: number;
  /** Decimal places in emitted coordinates. Default 3. */
  precision?: number;
  /** Emitted as <title>, for accessible inline SVG. Omitted when unset. */
  title?: string;
}
export function renderToSvg(options: RenderToSvgOptions): string;
export function renderToDataURL(options: RenderToSvgOptions): string;
```

**Coordinate system.** The `viewBox` is `0 0 W H` where `W`/`H` come from
`surfaceSize(resolveOptions(options))` — i.e. the CSS-pixel size the canvas renderer
uses at `devicePixelRatio` 1 — and `width`/`height` attributes are set to the same
numbers. Output stays resolution independent (it is vector). Rejected: a
`0 0 cols rows` viewBox, which looks tidier but silently breaks `computeGeometry`'s
`Math.max(0.6, cellSize * gap)` — that 0.6 is a pixel floor, and at `cellSize = 1` it
would swallow 60% of every cell.

**The gap floor must scale with the surface, or static and live drift on every retina
screen.** `computeGeometry`'s `Math.max(0.6, cellSize * gap)` is an _absolute_ floor
applied in whatever unit it is handed. The canvas hands it device pixels
(`surfaceSize(opts, dpr)`); the SVG hands it CSS pixels. At `dpr = 2` the canvas's
floor is 0.6 device px = 0.3 CSS px while the SVG's is 0.6 CSS px, so the canvas
draws visibly fatter cells than the SVG it replaces on mount — the fallback swap
_jumps_. That is also a pre-existing bug in its own right: today the canvas's
appearance changes with the display, because a floor denominated in device pixels
shrinks as pixels get smaller.

So `computeGeometry` gains a `scale` parameter (default 1) that applies to the floor
only:

```ts
gap = Math.max(0.6 * scale, cellSize * opts.gap);
```

`createDithered` passes `dpr`; the SVG and Skia paths pass the default 1. This
establishes the invariant the no-drift guarantee actually needs:

> **Geometry computed at scale `s` equals geometry computed at scale 1, multiplied by
> `s`** — cell size, gap, radius and every cell's x/y/width alike.

**The scale that matters is the backing store's, not `devicePixelRatio`.** A first
attempt at this drew from the _unrounded_ `surfaceSize(opts, dpr)` while still setting
`canvas.width = Math.round(...)`. That is wrong, and wrong in a way that is invisible
if you compare backing-store coordinates: the browser stretches a backing store of
`W` device px into a CSS box of `cssW` px, so a drawn coordinate is _displayed_
multiplied by `cssW / W`. Drawing at the unrounded size and rounding the store means
that factor is not `1 / dpr`, and the mount swap still shifts the right-hand cells
(0.25 CSS px for `rozenite` at `size: 48`, dpr 1) — the bug merely moves from the y
axis to the x axis.

So `createDithered` rounds the backing store **first**, then derives geometry from the
rounded integers, with the scale set to what the store actually is:

```ts
const W = Math.round(cssW * dpr); // the backing store, necessarily an integer
const H = Math.round(cssH * dpr);
computeGeometry(opts, W, H, ox, W / cssW); // not dpr
```

Then every displayed quantity matches the SVG's exactly. Cell size and radius cancel
on their own — displayed cell size is `(W / cols) · (cssW / W) = cssW / cols` either
way — and passing `W / cssW` rather than `dpr` is what makes the one term that does
_not_ cancel, the absolute gap floor, cancel too: `0.6 · (W / cssW) · (cssW / W) = 0.6`
displayed px, the same 0.6 the SVG floors at. Nothing is drawn outside the store
either.

This is exact whenever `cssH` (i.e. `size`) is an integer and `dpr` is an integer,
which covers essentially every real render; otherwise the residual is the aspect error
introduced by rounding `W` and `H` independently, bounded by half a device pixel over
the whole surface. That residual is inherent — `canvas.width` is an integer and the
CSS box is not — and the honest claim is therefore "identical displayed geometry, up
to the half-pixel the backing store must round to", not "byte-identical".

Because the mismatch lives in the mapping from backing store to CSS box, **the
no-drift test must compare displayed coordinates** — canvas rects multiplied by
`cssW / W` — against the SVG's. Comparing backing-store rects divided by `dpr`, as an
earlier version of that test did, is a unit system in which this whole class of bug
cannot appear.

`renderToDataURL` returns `data:image/svg+xml;utf8,<encoded>`, percent-encoding `%`
first, then `#`, `<`, `>`, `"`, `'`, `(`, `)`, `&`, and whitespace. Full
`encodeURIComponent` would also work but triples the length of a favicon; leaving `#`
unencoded breaks every call, since `fg` defaults to a hex colour and `#` starts a URL
fragment. The parentheses are not optional either: an unquoted CSS `url()` token ends
at the first `)`, so a `fg` of `rgb(130, 50, 255)` would truncate the declaration and
blank the very SSR fallback this exists to provide. `&` matters for the other
advertised use: pasted into an HTML `href`/`src`, an unescaped `&amp;` in the payload is
decoded by the HTML parser before the data URL is, leaving malformed XML and a
favicon that does not render.

### 6. React SSR: a `background-image` fallback, dropped on mount

`dithered/react` renders the frame-`initialFrame` SVG as a `background-image` data URL
in the `<canvas>`'s inline style, together with the CSS width/height that
`createDithered` will set anyway. On mount — after `createDithered` has painted — a
state flip removes it.

- `<canvas>` _fallback children_ were rejected: browsers only show them when canvas
  is unsupported, which is not the SSR case.
- Hydration is safe: the first client render produces the same markup as the server
  (the state starts `true` in both), and the removal happens in an effect, after
  hydration.
- The SVG is computed in a `useMemo` that is only entered while the fallback is live,
  so a mounted component never pays for it.
- The fallback renders the frame the component will actually paint on mount. When
  `progress` is set that is `Math.round(clamp(progress) * (frames - 1))`, not
  `initialFrame` — otherwise a determinate `<Dithered progress={0.9} />` server-renders
  an empty bar and snaps to 90% on hydration, which is worse than rendering nothing.
- Opt out with `ssrFallback={false}`.

## Alternatives considered

**Rasterize to PNG in Node.** Out of scope per the PRD, and it would mean either a
native dependency or a software rasterizer far larger than the whole library. SVG is
the right static format for a grid of rounded rects, and users can pipe it through
their own tooling.

**Ship a `Path2D` polyfill as a devDependency to get a parity oracle.** A polyfill is
another flattener with its own bugs; agreeing with it proves less than it appears to,
and it adds a supply-chain edge for a test. See _Consequences_ for what is done
instead.

**Keep `domHitTester`/`skiaHitTester` as the renderer defaults and use `jsHitTester`
only for static output.** Rejected: it preserves exactly the drift the PRD wants gone.
Static output would then be a third answer rather than the one answer.

**A dedicated SVG painter instead of a `PaintContext`.** Faster to write and
guaranteed to drift. The PRD is explicit that `paintFrame` stays the single source of
truth, and the `PaintContext` seam from #3 already exists for precisely this.

**Emit one `<path>` with many subpaths instead of one `<rect>` per cell.** Smaller
output, but it gives up per-cell `rx` handling to manual arc math and makes the
palette PRD's per-tone grouping harder. `<rect rx>` is what the PRD asks for.

## Consequences

- The core gains real geometry code (~400 lines of parser + flattener + scanline).
  It is dependency-free, DOM-free and covered by its own unit tests, and it is the
  piece #10 needs anyway.
- `dithered` runs end to end in Node, Workers and edge runtimes for the first time —
  `sampleCells`, `renderToSvg` and `renderToDataURL` touch no globals.
- Rendering becomes deterministic across web, native and server. The visible cost:
  a shape whose cells previously differed between `Path2D` and Skia will now render
  the same everywhere, which may change one or two edge cells versus today's web
  output. That is the intended fix, not a regression, but it is a behaviour change
  worth noting in the PR.
- `ResolvedOptions` is no longer `Required<DitheredOptions>`. Any external code
  relying on that identity breaks; nothing in the workspace does.
- `computeGeometry` gains a `scale` parameter, and the minimum cell gap is now 0.6
  **CSS** pixels rather than 0.6 device pixels. On a retina display the canvas
  therefore draws slightly narrower cells (larger gaps) than it does today. This is
  a deliberate fix — the old behaviour made the same options look different on
  different displays — but it is a visible change to existing web output, not only
  to the new static path.
- **Parity testing is bounded by the test environment.** jsdom implements no
  `Path2D` and no `isPointInPath` (`src/test-setup.ts` already stubs a constructible
  `Path2D` for other tests), so a literal `jsHitTester` vs `domHitTester` comparison
  cannot execute under `vitest`. Parity is therefore asserted against **independent
  analytic oracles** — one per built-in shape, with coordinates hard-coded in the
  test file rather than read through the parser, so the oracle shares no code with
  the implementation under test. Where a runtime _does_ provide a working `Path2D`
  and `isPointInPath`, the same suite additionally asserts agreement with
  `domHitTester`. This is called out in the PR body.

## Implementation plan

### Files to add

| File                                                   | Contents                                                                                                                                                            |
| ------------------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `packages/dithered/src/core/path.ts`                   | `Point`, `PathCommand`, `parsePath`, `flattenPath`, `pathToPolygons`, `arcToCubics`, `DEFAULT_TOLERANCE_DIVISOR`. Self-contained: imports nothing from the package. |
| `packages/dithered/src/core/path-hit-test.ts`          | `FillRule`, `pointInPolygons(polygons, x, y, fillRule)`, `jsHitTester(shape, options?)`. Imports only `core/path` and the `HitTester`/`Shape` types.                |
| `packages/dithered/src/core/svg-paint.ts`              | `SvgPaintContext`, `svgPaintContext(options?)`, number formatting and XML escaping helpers.                                                                         |
| `packages/dithered/src/core/static.ts`                 | `RenderToSvgOptions`, `renderToSvg`, `renderToDataURL`.                                                                                                             |
| `packages/dithered/src/core/path.test.ts`              | Parser + flattener unit tests.                                                                                                                                      |
| `packages/dithered/src/core/path-hit-test.test.ts`     | Analytic-oracle parity suite.                                                                                                                                       |
| `packages/dithered/src/core/svg-paint.test.ts`         | Recording-context unit tests.                                                                                                                                       |
| `packages/dithered/src/core/static.test.ts`            | `renderToSvg` / `renderToDataURL` tests (jsdom env).                                                                                                                |
| `packages/dithered/src/static.node.test.ts`            | `// @vitest-environment node` — asserts no DOM globals exist, then dynamically imports and exercises the static path.                                               |
| `packages/dithered/docs/adrs/0007-static-rendering.md` | This document.                                                                                                                                                      |

### Files to change

| File                                                                                                                  | Change                                                                                                                                                                                                                                                        |
| --------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `src/core/options.ts`                                                                                                 | Add `hitTest?: HitTester` to `DitheredOptions`; redefine `ResolvedOptions` as `Required<Omit<DitheredOptions, 'hitTest'>> & { hitTest?: HitTester }`. `DEFAULTS` is unchanged (typed as `Omit<ResolvedOptions, 'shape' \| 'brightness' \| 'hitTest'>`).       |
| `src/core/index.ts`                                                                                                   | Re-export the new path, hit-test, svg-paint and static surfaces.                                                                                                                                                                                              |
| `src/shape.ts`                                                                                                        | `sampleCells`'s `hitTest` parameter becomes optional, defaulting to `jsHitTester(shape)`. Doc comment updated.                                                                                                                                                |
| `src/core/paint.ts`                                                                                                   | `computeGeometry` gains a `scale` parameter (default 1) applied to the gap floor: `Math.max(0.6 * scale, cellSize * opts.gap)`.                                                                                                                               |
| `src/renderer.ts`                                                                                                     | Drop the `domHitTester` import; pass `opts.hitTest` through to `sampleCells` (falling back to the default). Round the backing store first, then derive geometry from the rounded `W`/`H` with `computeGeometry`'s `scale` set to `W / cssW` — not `dpr`.      |
| `src/native/pictures.ts`, `src/native/Dithered.tsx`                                                                   | Same: stop defaulting to `skiaHitTester`, honour `hitTest` when given.                                                                                                                                                                                        |
| `src/index.ts`                                                                                                        | Export `jsHitTester`, `renderToSvg`, `renderToDataURL`, `svgPaintContext`, `parsePath`, `flattenPath`, `pathToPolygons`, and the `PathCommand` / `Point` / `FillRule` / `RenderToSvgOptions` / `SvgPaintContext` types.                                       |
| `src/native.ts`                                                                                                       | Export the same additions (all DOM-free).                                                                                                                                                                                                                     |
| `src/react.tsx`                                                                                                       | Add `ssrFallback?: boolean` (default `true`); render the frame-`initialFrame` data URL as `backgroundImage` plus explicit CSS width/height until the mount effect clears it.                                                                                  |
| `src/test-setup.ts`                                                                                                   | Guard the `Path2D` stub and the Testing Library import so the file is a no-op without a DOM (the node-environment test must not trip over it).                                                                                                                |
| `README.md` (repo root — `packages/dithered` has no README of its own, and `files: ["dist"]` means none is published) | New "Static rendering" section: `renderToSvg` / `renderToDataURL` / `jsHitTester`, the determinism note, the SSR fallback, and the PRD-required **"Use a frame as a favicon"** example. Note `jsHitTester` as the new `sampleCells` default in the API table. |

### Tests to write

1. **`parsePath`** — absolute and relative forms of every command; implicit repeats
   (`L` chains, and the `M x y x y` → moveto-then-lineto rule); `H`/`V` expansion;
   `S`/`T` reflection both after a matching curve (reflect) and after a
   non-curve (control point = current point); number-grammar cases (`.5`, `5.`,
   `1e-3`, `1.5.5`, `1-2`); arc flags packed without separators (`a5 5 0 1110 10`);
   `Z` followed by a drawing command resuming from the subpath start; multiple
   subpaths; malformed input throwing.
2. **`arcToCubics`** — a quarter, half and full-ish arc against analytically known
   endpoints; `rx`/`ry` of 0 degenerating to a line; out-of-range radii being scaled
   up per SVG F.6.6; both `largeArc` and `sweep` flags in all four combinations,
   asserting the midpoint of the produced curve is on the correct side.
3. **`flattenPath`** — a flattened circle's points all within tolerance of radius 40;
   segment count is bounded (no runaway subdivision); a degenerate curve with
   coincident control points terminates; tolerance scales the point count monotonically.
4. **`pointInPolygons`** — inside, outside, and both fill rules over a
   square-with-a-square-hole (nonzero: hole filled when windings agree, empty when
   they oppose; evenodd: hole always empty); a point aligned with a vertex; a point
   aligned with a horizontal edge.
5. **`jsHitTester` parity** — the PRD's headline test. For every shape in `shapes`
   (`rozenite`, `circle`, `square`, `diamond`, `heart`), at `cols = 16` and
   `cols = 64`, compare `jsHitTester`'s verdict at every sampled cell centre against
   an independent oracle whose geometry is hard-coded in the test file:
   `circle` → `(x-50)² + (y-50)² ≤ 40²`; `square` → `10 ≤ x,y ≤ 90`;
   `diamond` → `|x-50| + |y-50| ≤ 45`; `rozenite` → an explicit list of its
   axis-aligned spans; `heart` → ray casting that solves each hard-coded cubic
   analytically (Cardano) for crossings, sharing no code with `core/path.ts`.
   The suite must report _which_ cells differ, not just that a count differs.
   In the same file, gated on a runtime that actually provides them, assert
   `domHitTester` agrees with `jsHitTester` on the same grids.
6. **`sampleCells` default** — `sampleCells(shape, 16)` equals
   `sampleCells(shape, 16, jsHitTester(shape))`, and an explicitly passed tester is
   still honoured (a tester returning `false` yields zero cells).
7. **`svgPaintContext`** — `fillRect` emits a background rect; `beginPath` + `rect` +
   `fill` emits one rect with the current fill; `roundRect` emits `rx`; consecutive
   same-fill rects share one `<g>` and a fill change opens a new one; numbers are
   rounded and trailing zeros stripped; a `fg` containing `"` or `&` is escaped.
8. **`renderToSvg`** — well-formed root with the expected `viewBox`/`width`/`height`;
   one `<rect>` per drawn cell, cross-checked against `paintFrame` driven into a
   recording context with the same options; `bg: 'transparent'` emits no background
   rect and a set `bg` does; different `frame` values produce different output and
   `frame` is taken modulo `frames`; `title` appears as `<title>` and is escaped;
   output is byte-identical across two calls with the same options.
9. **`renderToDataURL`** — prefix is `data:image/svg+xml;utf8,`; `#` from a hex `fg`
   is percent-encoded; decoding the payload reproduces `renderToSvg`'s string;
   the result survives interpolation into a CSS `url(...)` unquoted.
10. **Plain Node, no DOM** (`src/static.node.test.ts`, `// @vitest-environment node`)
    — assert `typeof document`, `typeof window`, `typeof Path2D`,
    `typeof HTMLCanvasElement` are all `'undefined'`, then `await import('../src/index')`
    (or the built entry) and run `sampleCells`, `renderToSvg` and `renderToDataURL`
    end to end on `shapes.rozenite`, asserting a non-empty result. This is the
    PRD's "runs under plain Node" criterion.
11. **React SSR** — `renderToString(<Dithered shape={shapes.rozenite} … />)` contains
    a `background-image:url(data:image/svg+xml…)` and is non-blank; `ssrFallback={false}`
    omits it; after `render()` + mount the background image is gone; hydrating the
    SSR markup logs no hydration mismatch warning (spy on `console.error`).
12. **Regression / no drift** — the existing `renderer.test.ts` / native suites keep
    passing with the hit tester swapped, and a test asserts `createDithered` paints
    the same cells and the same geometry that `renderToSvg` emits for identical
    options, by comparing the recording context's rect calls against the SVG's rects.
    This test must use the library's own defaults (`shapes.rozenite`, `size: 48`,
    `cols: 16` — a non-integer surface width and an aspect ratio that is not 1) and
    must run at `devicePixelRatio` 1, 2 and 3. It must compare **displayed**
    coordinates — canvas rects multiplied by `canvas.style.width / canvas.width` —
    against the SVG's, never backing-store rects divided by `dpr`, which is the one
    unit system in which backing-store rounding cannot show up. A fixture chosen so
    the gap floor and the rounding both happen to cancel (e.g. `shapes.square` at
    `size: 40, cols: 4, dpr: 1`) asserts a tautology and does not count. It must also
    use a frame-varying `brightness` and compare at more than one frame: with
    `brightness: () => true` every cell is drawn at every phase, so a uniform phase
    offset between `renderToSvg` and `createDithered` passes unnoticed. And it must
    cover the sprite-strip path (`cache: true`, with `stubGetContext`), not only the
    direct-paint path — `cache` defaults to `'auto'`, which is on at `size: 48`, so
    the strip is what a default web render actually uses.
13. **Geometry scale invariant** — `computeGeometry(opts, w * s, h * s, 0, s)` equals
    `computeGeometry(opts, w, h)` with `cellSize`, `gap` and `radius` each multiplied
    by `s`, for `s` in 1, 2, 3 and for a `cellSize` both above and below the 0.6px
    floor's crossover point.
14. **Degenerate input** — a `Shape` whose viewBox has zero width or height (making
    `aspectOf` non-finite) makes `renderToSvg` throw a named error rather than emit
    `viewBox="0 0 Infinity 40"`. `formatNumber` never emits `NaN` or `Infinity` into
    an attribute.
15. **Data-URL escaping** — a `fg` containing parentheses (`rgb(130, 50, 255)`) and a
    `title` containing `&` each round-trip: the payload contains no raw `(`, `)`, `&`,
    `#`, quote or whitespace, and decoding it reproduces `renderToSvg`'s output. The
    negative character class in this test must include `(`, `)` and `&` — a fixture
    whose only colour is a hex literal cannot fail on any of them.
16. **SSR fallback honours `progress`** — `renderToString(<Dithered progress={0.9} …/>)`
    emits the same frame the mount effect paints, not frame `initialFrame`.

### Checks

`pnpm install`, `pnpm format` (or `pnpm format:check`), `pnpm build`, `pnpm typecheck`,
`pnpm test` at the workspace root. All must pass before the branch is pushed.
