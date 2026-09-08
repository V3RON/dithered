# 0010 — Wider SVG input in `shapeFromSvg` (basic shapes and `transform`)

## Status

Proposed

## Context

`shapeFromSvg` (DOM, `DOMParser`-backed) and `shapeFromSvgLite` (DOM-free, text-scanning) both
implement the same narrow contract: read the root `viewBox`, concatenate the `d` attribute of every
`<path>` descendant, throw if there are none. Everything else in the document is silently dropped.

Icons exported from Figma, Illustrator or an icon pack routinely contain none of that. They contain
`<rect rx>`, `<circle>`, `<polygon>`, and they wrap geometry in `<g transform="…">`. Such a file
parses without error today and produces either an empty shape (throwing the misleading "no `<path>`
elements" message) or — worse — a silhouette in the wrong place, because the `<path>` children of a
translated `<g>` are read with the group transform discarded. This is the most likely first-run
failure for a new user pasting their own logo into the playground.

Issue #10 asks for the SVG basic shapes and `transform` support in both loaders, hidden geometry
skipped rather than silently contributing cells, `fill-rule="evenodd"` honoured, and a specific
error when a document contains only genuinely unsupported constructs (`<use>`, `<text>`).

Three constraints shape the design:

1. **`Shape` is one path string plus a viewBox.** It has no element list, no per-element style and no
   nesting. Anything the loader learns about individual elements has to be baked into path data or
   collapsed into a single document-level value.
2. **The two loaders must not drift.** PR #3 added `shapeFromSvgLite` with a parity test asserting it
   agrees with `shapeFromSvg` on the same input. Basic shapes, transform composition, skip rules and
   error messages multiply the surface where those two implementations could disagree.
3. **`shapeFromSvgLite` is exported from `dithered/native`.** Every module it reaches must be
   DOM-free, so all of the new logic has to live in `src/core/` alongside the rest of the
   platform-free half of the library.

There is also an overlap: issue #7 (static rendering) needs an SVG path-data parser of its own and is
being implemented in parallel. The path-data work here should be a standalone module with an API #7
can adopt, rather than something entangled with SVG element traversal.

## Decision

### 1. Split the work into four platform-free core modules

| Module                   | Responsibility                                                                                                       |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------- |
| `src/core/path.ts`       | Path data: tokenize `d`, normalize to absolute, arc → cubic, transform, serialize. Knows nothing about SVG elements. |
| `src/core/transform.ts`  | 2×3 affine matrices: `parseTransform`, `multiply`, `apply`, `isIdentity`.                                            |
| `src/core/svg-shapes.ts` | One basic-shape element (as a plain attribute lookup) → path data.                                                   |
| `src/core/svg-tree.ts`   | The shared traversal: skip rules, transform composition, `fill-rule` resolution, concatenation, error messages.      |

`src/core/path.ts` is the module issue #7 can reuse. Its API is deliberately free of any SVG-document
concepts:

```ts
export interface PathSegment {
  command: string;
  values: number[];
} // command letter as written
export function parsePath(d: string): PathSegment[]; // implicit repeats expanded
export function toAbsolute(segments: PathSegment[]): PathSegment[]; // H/V→L, S→C, T→Q, all absolute
export function transformSegments(segments: PathSegment[], m: Matrix): PathSegment[];
export function arcToCubics(x0, y0, rx, ry, xAxisRotationDeg, largeArc, sweep, x, y): number[][];
export function serializePath(segments: PathSegment[]): string;
```

`parsePath` throws on malformed data (unknown command letter, wrong argument count, unparseable
number) rather than silently truncating, so a bad `d` surfaces as a loader error instead of a
half-shape.

### 2. The two loaders share everything but tokenization

Both loaders adapt their input to one minimal read-only node interface and hand it to the same
traversal:

```ts
export interface SvgNode {
  /** Lower-cased local name, namespace prefix stripped. */
  tag: string;
  /** Attribute lookup; names are case-sensitive, as in SVG. */
  attr(name: string): string | null;
  children: readonly SvgNode[];
}

export function collectGeometry(
  root: SvgNode,
  label: string,
): { path: string; fillRule?: FillRule };
```

- `svg.ts` wraps DOM `Element`s in a thin adapter (`tag` from `localName`, `attr` from
  `getAttribute`, `children` lazily from `el.children`).
- `svg-lite.ts` gains a small tag scanner that turns the source text into an `SvgNode` tree: it walks
  start tags, self-closing tags and end tags with a stack, and keeps its existing tolerances
  (comments and CDATA stripped, either quote style, case-insensitive tag names).

`label` is the caller's function name, so error messages keep saying `shapeFromSvg:` or
`shapeFromSvgLite:` as they do today.

This is the answer to constraint 2: the _only_ thing that differs between the loaders after this
change is how a tree of nodes is obtained. Skip rules, transform maths, shape conversion, the order
of concatenation and every error message are literally the same code. Parity is structural, and the
tests assert it on every new fixture.

### 3. Element → path data conversion

Applied in document order; each element's contribution is one or more subpaths appended to the
output, space-joined, exactly as `<path d>` values are joined today.

| Element                 | Conversion                                                                                                                                                                   |
| ----------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `<path>`                | `d` verbatim.                                                                                                                                                                |
| `<rect>`                | `M x+rx,y H x+w−rx A rx,ry 0 0 1 x+w,y+ry V y+h−ry A … Z`, clockwise from the top-left corner (SVG 2 §"equivalent path"). With no corner radius, the plain `M/H/V/H/Z` form. |
| `<circle>`, `<ellipse>` | Two half-arcs, `M cx+rx,cy A rx,ry 0 0 1 cx−rx,cy A rx,ry 0 0 1 cx+rx,cy Z` — the same direction as SVG 2's four-arc equivalent path.                                        |
| `<polygon>`             | `M`, then `L` per remaining point, then `Z`.                                                                                                                                 |
| `<polyline>`            | The same, **without** `Z`.                                                                                                                                                   |
| `<line>`                | Skipped: zero area, so it can never add a cell, and emitting it would only risk a stray `M/L` in the output.                                                                 |

Geometry-attribute rules follow SVG 2 rather than being invented:

- `<rect>`: `width`/`height` missing, non-numeric, or `<= 0` → the element is skipped (not an error;
  that is what a renderer does). `rx`/`ry`: both absent or `auto` → 0; exactly one present → the
  other takes its value; negative → treated as absent. Each is then clamped to half the
  corresponding side (`rx <= width/2`, `ry <= height/2`), which is where a naive implementation
  produces self-crossing corners on a pill-shaped `rect rx="999"`.
- `<circle>`: `r` absent or `<= 0` → skipped. `<ellipse>`: `rx`/`ry` follow the same auto rule as
  `rect` (one given → both), and a non-positive resolved radius → skipped.
- `<polygon>`/`<polyline>`: `points` is parsed as a flat number list separated by whitespace and/or
  commas; a trailing odd coordinate is dropped (SVG renders up to the error). Fewer than two points
  → skipped.
- Missing numeric attributes on `circle`/`ellipse`/`line` centre coordinates default to 0, as in SVG.

### 4. Transforms are composed parent-first and baked into coordinates

Each node carries a current transformation matrix. The root `<svg>` element's own `transform` is
ignored (it is not applied to the viewBox coordinate system in any meaningful way for our purposes,
and design tools do not emit one); every descendant computes
`ctm = parentCtm × parseTransform(node.transform)`.

Within a single attribute, the transform list composes **left to right**:
`transform="translate(10,0) rotate(45)"` is `T × R`, so `rotate` applies first to the geometry. The
supported functions and their matrices:

| Function               | Matrix                                              |
| ---------------------- | --------------------------------------------------- |
| `translate(tx [ty])`   | `ty` defaults to 0                                  |
| `scale(sx [sy])`       | `sy` defaults to `sx`                               |
| `rotate(a)`            | rotation by `a` degrees about the origin            |
| `rotate(a cx cy)`      | `translate(cx,cy) × rotate(a) × translate(−cx,−cy)` |
| `skewX(a)`, `skewY(a)` | `[1 0 tan a 1 0 0]`, `[1 tan a 0 1 0 0]`            |
| `matrix(a b c d e f)`  | verbatim                                            |

Separators may be whitespace and/or commas; an unknown function name or a wrong argument count
throws (loudly, per the PRD's stance) rather than being ignored, which would silently misplace the
shape.

Baking: an element whose CTM `isIdentity` contributes its path data **unchanged** — no re-parse, no
re-serialize. This keeps today's output byte-identical for the SVGs that already work (and keeps the
existing tests meaningful). Only when the CTM is non-identity is the path parsed, absolutized and
transformed.

### 5. Arcs are converted to cubics whenever a transform is baked

An `A` command under a non-uniform scale, a skew or a mirror cannot be re-emitted as an arc without
recomputing the ellipse's axes and rotation from the transformed conic, and a negative determinant
additionally flips the sweep flag. Rather than special-casing uniform transforms, `transformSegments`
converts **every** arc it meets to a chain of cubic Béziers (endpoint → centre parameterization, then
segments of at most 90°, the standard `4/3·tan(θ/4)` control-point construction) and transforms the
control points. Cubics are closed under affine transforms, so this is exact for every supported
transform, and it removes the sweep-flag question entirely.

Combined with §4, an untransformed `<rect rx>` or `<circle>` still emits compact `A` commands — both
`Path2D` and `SkPath.MakeFromSVGString` parse them — and only transformed geometry pays the
conversion.

### 6. `fillRule` is a document-level property of `Shape`

```ts
export interface Shape {
  path: string;
  viewBox: { x: number; y: number; width: number; height: number };
  fillRule?: 'nonzero' | 'evenodd';
}
```

`fill-rule` is an inherited presentation attribute, so it is resolved for each contributing element
by walking up its ancestor chain (nearest declaration wins; the initial value is `nonzero`). Since a
`Shape` holds one path string, one rule has to cover all of it:

- Every contributing element resolves to `nonzero` (or declares nothing) → `fillRule` is **omitted**,
  which keeps existing `Shape` values and snapshots unchanged.
- Every contributing element resolves to `evenodd` → `fillRule: 'evenodd'`.
- Contributing elements disagree → **throw**, naming both rules. Picking one silently would produce
  a wrong silhouette for half the document, and the case is rare enough in real icons that failing
  loudly is the better trade. The message tells the user to split the file or pre-convert it.

Elements that are skipped (hidden, zero-area, `<line>`) do not vote.

Consumption:

- `domHitTester` → `ctx.isPointInPath(path, x, y, shape.fillRule ?? 'nonzero')`. The canvas fill-rule
  strings are exactly the two SVG values, so no mapping is needed.
- `skiaHitTester` → `path.setFillType(FillType.EvenOdd)` when the shape asks for it; Skia's default
  is `Winding`, which is `nonzero`.
- No other consumer needs it: `paintFrame` draws sampled cells, never the shape path itself.

### 7. Exact skip rules

Evaluated during the walk, in this order:

1. **Non-rendered containers — element and entire subtree skipped:** `defs`, `clipPath`, `mask`,
   `symbol`, `pattern`, `marker`, `style`, `script`, `title`, `desc`, `metadata`. The PRD names the
   first three; the rest are skipped for the same reason — their geometry is a definition or metadata,
   never painted where it stands, so letting a `<symbol>` through would be exactly the `<defs>` bug
   under another tag.
2. **`display="none"` — element and entire subtree skipped.** `display` is not inherited, but a
   `display:none` container is not rendered _along with all its descendants_, so a subtree skip is
   the correct semantics (a descendant `display="block"` cannot bring it back).
3. **Unsupported drawables — skipped, but recorded:** `use`, `text`, `image`, plus `textPath`/`tspan`
   as children of `text`. Recording the tags found lets the "nothing drawable" error name them.
4. **Paint-invisible geometry — the element skipped (it is a leaf; there is no subtree):** a geometry
   element whose resolved `fill` is `none` **and** whose resolved `stroke` is absent or `none`. Both
   are inherited presentation attributes and are resolved through the ancestor chain, which matters:
   Figma emits `<svg fill="none">` with `fill` set per `<path>`, and treating the root declaration as
   final would drop the whole icon.
5. **Zero-area geometry — skipped:** `<line>` always, plus the degenerate-dimension cases in §3.

Everything else (`g`, `a`, `switch`, the root `svg`, unknown containers) is descended into. A
geometry element with `fill="none"` but a stroke _does_ contribute its fill area, because stroke
outlines are out of scope: that is the PRD's stated rule, and it is noted as a known
over-inclusion below.

### 8. Error messages

- Nothing drawable found, and the document contained `<use>`/`<text>`/`<image>`:
  `shapeFromSvg: this SVG's geometry is all <use>/<text>, which is not supported. Expand symbols and convert text to outlines in your editor, then re-export.`
  (naming only the tags actually seen).
- Nothing drawable found, nothing unsupported seen: the existing "no drawable geometry" error,
  reworded to list the supported elements rather than claiming only `<path>` is read.
- Conflicting `fill-rule`, malformed `transform`, malformed `d`: their own specific messages, each
  prefixed with the calling function's name.

## Alternatives considered

**Convert basic shapes in each loader separately.** Fewer moving parts per file, but it doubles every
rule in §3/§7 and guarantees the two loaders drift on the next change. Rejected on constraint 2.

**Have `shapeFromSvgLite` delegate to a real XML parser.** Would collapse the two loaders into one,
but the reason `shapeFromSvgLite` exists is that React Native has no `DOMParser`; bundling an XML
parser would add the dependency PR #3 deliberately avoided. Rejected.

**Represent per-element `fill-rule` by emitting a normalized path.** An `evenodd` subpath can be
rewritten as a `nonzero`-equivalent one by reversing the winding of interior contours, which would
let mixed documents work. It needs full contour-orientation and containment analysis (self-
intersection included) — far more machinery than the rest of this change put together, for a case
that essentially does not occur in exported icons. Rejected; §6 throws instead.

**Keep arcs as arcs and recompute `rx`/`ry`/rotation under transform.** Doable via the conic matrix
and an eigen-decomposition, and it keeps output compact. It is also the part most likely to be subtly
wrong (mirrors, degenerate axes) and hardest to test. Cubic conversion is exact, standard, and the
PRD asks for it. Rejected.

**Apply the CTM at hit-test time instead of baking it.** `Path2D` has no transform-on-construct, the
`Shape` would need to carry a matrix per subpath, and `skiaHitTester` would have to mirror it.
Baking keeps `Shape` plain data — which is the property that lets users pre-convert at build time and
commit the result. Rejected.

**Treat `visibility="hidden"` and `opacity="0"` as hidden too.** Both really are hidden helper
geometry, but neither is in the PRD, `visibility` is inherited-and-overridable (so it needs different
plumbing from `display`), and `opacity` interacts with group opacity. Deferred; noted below.

## Consequences

- `Shape` gains an optional field. Existing `Shape` literals, the built-in `shapes`, and anything
  users have committed keep working untouched, and `fillRule` is omitted rather than set to
  `'nonzero'` so `toEqual` comparisons against old values still pass.
- `sampleCells` is unchanged; the fill rule reaches sampling entirely through the hit testers.
- The DOM loader no longer uses `querySelectorAll('path')`, so document order across _all_ geometry
  is now what determines concatenation order — previously all `<path>`s came first regardless of
  where they sat relative to other elements. No observable change for path-only documents.
- Any JS hit tester added later must read `shape.fillRule`; the two shipped testers do.
- A stroke-only shape (`fill="none" stroke="…"`) contributes its _fill_ area, which is empty-looking
  in a real renderer but solid here. This is the PRD's rule; the alternative (stroke outlining) is
  explicitly out of scope. Documented in the README.
- `visibility="hidden"`, `opacity="0"`, CSS-driven styling (`<style>` rules, `style="fill:none"`),
  `<use>` expansion, `preserveAspectRatio`, and nested `<svg>` viewports remain unsupported. The
  `style` attribute in particular is worth flagging: `style="display:none"` will _not_ skip an
  element, only the presentation attribute will.
- **Concatenation changes fill semantics across elements, and this decision does not fix that.**
  Merging every element into one path string means overlapping regions of _separately filled_
  elements cancel rather than union: a counter-clockwise author `<polygon>` overlapping the
  clockwise `<rect>` this ADR emits punches a hole under `nonzero`, and once `fillRule: 'evenodd'`
  is hoisted to the document (§6) _any_ overlap between two elements becomes a hole. SVG renders
  both cases solid, because each element is filled independently. The single-path `Shape` predates
  this change — two overlapping `<path>` elements with opposite winding always behaved this way —
  but supporting basic shapes makes it reachable far more often, and §6 adds the evenodd case.
  Fixing it properly means either `Shape` carrying a list of subpaths with per-subpath fill rules
  (both hit testers OR-ing over them) or a boolean path union; both are larger than this change and
  neither is in the PRD. Documented as a known limitation in the README, and left for a follow-up.

- Each contributing element's _leading_ moveto is rewritten to an absolute `M` before
  concatenation. In the source document every element's path data starts its own path, so its first
  moveto is absolute-equivalent by definition; spliced into one string, a leading relative `m` would
  otherwise resolve against the previous element's current point and displace the whole subpath.
  Commands after the first moveto keep whatever form they were written in, so output stays
  byte-identical for the absolute-`M` data that design tools usually emit.

- `packages/dithered/src/core/path.ts` is now a shared surface. Issue #7 can import it as-is; if #7
  lands first with its own parser, one of the two should be deleted in favour of the other rather
  than left as a duplicate.

## Implementation plan

### Files to add

| File                                | Contents                                                                                                                                                           |
| ----------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/path.ts`                  | `PathSegment`, `parsePath`, `toAbsolute`, `transformSegments`, `arcToCubics`, `serializePath`.                                                                     |
| `src/core/path.test.ts`             | Tokenizer, implicit repeats, relative→absolute, S/T expansion, arc→cubic geometry, round-tripping, malformed-input throws.                                         |
| `src/core/transform.ts`             | `Matrix`, `IDENTITY`, `parseTransform`, `multiply`, `apply`, `isIdentity`.                                                                                         |
| `src/core/transform.test.ts`        | Each function, list composition order, `rotate` with centre, separators, unknown-function throw.                                                                   |
| `src/core/svg-shapes.ts`            | `basicShapeToPath(tag, attr)` for rect/circle/ellipse/polygon/polyline/line.                                                                                       |
| `src/core/svg-shapes.test.ts`       | Per element: normal case, `rx`/`ry` auto and clamping, degenerate dimensions, odd `points` list, `polyline` not closed.                                            |
| `src/core/svg-tree.ts`              | `SvgNode`, `collectGeometry`, skip rules, inherited-attribute resolution, `fill-rule` reconciliation, error messages.                                              |
| `src/core/svg-tree.test.ts`         | The traversal directly, against hand-built `SvgNode` trees: nesting, `<defs>`, `display="none"`, inherited `fill`, mixed `fill-rule` throw, unsupported-tag error. |
| `src/svg-fixtures.test.ts`          | The PRD's fixtures, run through **both** loaders (see below).                                                                                                      |
| `docs/adrs/0010-wider-svg-input.md` | This document.                                                                                                                                                     |

### Files to change

| File                                                    | Change                                                                                                                |
| ------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------- |
| `src/shape.ts`                                          | Add `fillRule?: 'nonzero' \| 'evenodd'` to `Shape`; export the `FillRule` type.                                       |
| `src/core/index.ts`                                     | Re-export the new core modules.                                                                                       |
| `src/svg.ts`                                            | Replace the `querySelectorAll('path')` body with a DOM→`SvgNode` adapter + `collectGeometry`; update the doc comment. |
| `src/svg-lite.ts`                                       | Add the tag scanner producing an `SvgNode` tree; same `collectGeometry` call; update the doc comment.                 |
| `src/hit-test.ts`                                       | Pass `shape.fillRule ?? 'nonzero'` to `isPointInPath`.                                                                |
| `src/native/hit-test.ts`                                | `setFillType(FillType.EvenOdd)` when the shape asks for it.                                                           |
| `src/index.ts`, `src/native.ts`                         | Export `FillRule` (and the path module, if it is useful publicly — at minimum it must stay DOM-free).                 |
| `README.md` (repo root; there is no per-package README) | Rewrite the `shapeFromSvg` section: supported elements, transforms, skip rules, `fillRule`, what still throws.        |

### Tests to write

Beyond the per-module unit tests above:

- **Fixture parity (the PRD's acceptance criterion).** For each of — a Figma-style icon with
  `<rect rx>` inside `<g transform="translate(…) rotate(…)">`, a `<circle>`-only icon, a `<polygon>`
  star — assert that `shapeFromSvg(fixture)` and `shapeFromSvgLite(fixture)` return deep-equal
  `Shape`s, **and** that `sampleCells` over the fixture selects exactly the same cells as
  `sampleCells` over a hand-written `<path>` equivalent of the same icon. Sampling comparison (not
  string comparison) is what the PRD asks for and is the only comparison that survives an arc being
  emitted as cubics.
- **Transform order.** Nested `<g transform>` inside `<g transform>`; `rotate(a cx cy)`;
  `matrix(...)`; a transform on the geometry element itself combined with an ancestor's — each
  checked against hand-computed coordinates.
- **Skip rules.** Geometry inside `<defs>`, `<clipPath>`, `<mask>`, `<symbol>` does not appear;
  `display="none"` on a `<g>` removes its children; `fill="none"` with no stroke is dropped but
  `fill="none" stroke="red"` is kept; root `fill="none"` does not drop a child that sets its own
  fill.
- **`fillRule` end-to-end.** An evenodd fixture yields `fillRule: 'evenodd'`; `domHitTester` forwards
  it to `isPointInPath` (spy); `skiaHitTester` calls `setFillType` (fake `SkPath`); a nonzero-only
  document leaves the field `undefined`; a mixed document throws.
- **Error messages.** `<use>`-only and `<text>`-only documents throw the specific message from §8,
  from both loaders; an empty `<svg>` throws the generic one.
- **Regression.** Every existing `svg.test.ts` / `svg-lite.test.ts` case still passes unchanged.
