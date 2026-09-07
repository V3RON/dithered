# 0005 — Multi-tone palettes (`fg` as an array) and `currentColor`

## Status

Proposed

## Context

`fg` is a single color, so a cell is either painted or not. `Brightness` already
returns a continuous value in `0..1`, but the Bayer comparison
(`brightness > cell.threshold`) collapses it to one bit. Two- and three-tone
dithers are what make the "retro screen" look read well at larger sizes, and
today they can only be had by stacking canvases.

Separately, a canvas cannot inherit the surrounding text color the way SVG's
`currentColor` does, so themed UIs have to thread a color prop through by hand.

Issue #5 asks for both, under a hard constraint: **existing output must not
change**. Every preset, every snapshot, every single-color `fg` render must be
byte-identical after this change.

The constraint is what makes the design non-obvious. The PRD sketches a
quantization rule but leaves four things open, and each has a wrong answer that
silently breaks either output identity or performance:

1. The exact quantization formula, and what "tone 0" means.
2. How `paintFrame` groups by tone without calling `brightness` more than once
   per cell per frame (`gameOfLife` is stateful; `wave`/`rain` are not free).
3. How the sprite-strip cache, the Skia paint context and the `SkPicture`
   recorder carry a palette.
4. Where `currentColor` is resolved, and what re-resolves it.

This ADR settles those. It builds on PR #3's platform-free `src/core/`, and
deliberately does not depend on issue #8 (shared threshold assignment); it reads
`cell.threshold` as it exists today.

## Decision

### 1. Palette representation

```ts
/** A single color (unchanged), or an ordered palette from darkest to brightest. */
fg?: string | readonly string[];
```

<!--
  Round-2 review correction (finding 3): the exported `Palette` type is
  `readonly string[]`, so a mutable `string | string[]` here would reject a
  caller passing back a `Palette` value (or an `as const` array) they got
  from the library itself. Widened to `string | readonly string[]`; safe
  because normalization always copies (see below). This is the one
  correction the review authorized to this ADR, to match the shipped API.
-->

A palette is normalized once, at the edge, into a `readonly string[]` of length
`n >= 1`:

- `fg: string` → `[fg]` (`n === 1`).
- `fg: string[]` → a copy, darkest first.
- `fg: []` → `[DEFAULTS.fg]`. An empty palette has no sensible rendering and
  throwing from inside a paint loop is worse than a documented fallback.

`bg` stays a single color. Per-cell colors returned by `Brightness` and
gradients stay out of scope, per the PRD.

### 2. Quantization: levels `0..n`, not tones `0..n-1`

The PRD's sketch — "draws tone `floor(L)` if `frac(L) <= threshold`, else
`ceil(L)`, clamped to `n - 1`" — **does not** reduce to today's behavior at
`n === 1`: both branches clamp to tone `0`, so every cell would paint. The
missing piece is that "not drawn" has to be a level of its own.

So the range is `0..n` inclusive, where level `0` means _skip the cell_ and
level `k >= 1` paints `palette[k - 1]`:

```ts
/**
 * The palette level for a brightness value: 0 = skip, k >= 1 = palette[k - 1].
 * `tones` is the palette length.
 */
export function toneLevel(b: number, threshold: number, tones: number): number {
  if (!(b > 0)) return 0; // 0, negatives and NaN skip, matching `b > threshold`
  if (b >= 1) return tones; // saturate at the brightest tone
  const level = b * tones;
  const base = Math.floor(level);
  return level - base <= threshold ? base : base + 1;
}
```

Boolean brightness keeps its meaning and bypasses the dither entirely:
`true` → level `n` (brightest tone), `false` → level `0`.

For `b` in `(0, 1)` no clamp is needed: `b * tones < tones`, so `base <= n - 1`
and `base + 1 <= n`.

#### Proof of byte-identical output for a single color

Let `n = 1` and let `t = cell.threshold`, which is `(BAYER_4[j%4][i%4] + 0.5) / 16`
and therefore always in `(0, 1)` — specifically `[0.03125, 0.96875]`. Today's
rule is: draw `fg` iff `b > t` (for numeric `b`), where `NaN > t` is `false`.

- `b <= 0`, or `b` is `NaN`: `toneLevel` returns `0` (skip). Today `b > t` is
  `false` for `b <= 0 < t`, and `false` for `NaN`. **Match.**
- `0 < b < 1`: `level = b`, `base = Math.floor(b) = 0`, `level - base = b`.
  The result is `b <= t ? 0 : 1` — the exact negation of today's `b > t`, with
  level `1` painting `palette[0] === fg`. **Match.**
- `b >= 1`: returns `tones = 1` (paint). Today `b > t` is `true` since `t < 1`.
  **Match.**
- `b === true` / `b === false`: level `1` / level `0`. Today: draw / skip.
  **Match.**

So for `n === 1` the level is `1` exactly when today's predicate is `true`, and
`palette[0] === fg`. The set of painted cells, their geometry, and their fill
color are unchanged; the output is byte-identical. The `n === 1` fast path in
§3 additionally keeps the _sequence of context calls_ identical, so mock-based
tests keep passing unchanged.

### 3. `paintFrame` groups by tone, with an `n === 1` fast path

`brightness` must be called **exactly once per cell per frame** — `gameOfLife`
is stateful and re-invoking it per tone would both corrupt it and cost `n` times
the work. So grouping is a single pass that buckets cell indices, followed by
one drawing pass per non-empty bucket:

```ts
// n === 1: today's loop, verbatim. One fillStyle assignment, drawn inline.
// n > 1:   one pass computing levels into n buckets, then for level 1..n
//          set fillStyle = palette[level - 1] once and draw that bucket.
```

Consequences of this shape:

- `fillStyle` is assigned at most `n` times per frame (plus once for `bg`), as
  the PRD requires.
- The `n === 1` path allocates nothing and emits the identical call sequence to
  today, including the unconditional `ctx.fillStyle = fg` assignment that
  happens even when no cell is drawn.
- Cells within a bucket keep their original relative order. Cells are laid out
  on a non-overlapping grid, so cross-bucket reordering cannot change any pixel.
- The `n > 1` path allocates `n` index arrays per frame. That is once per
  `paintFrame` call, which for cached web rendering is once per frame _of the
  strip build_, not per animation frame, and on native once per picture
  recording. Acceptable; no pooling.

`PaintGeometry.fg` widens from `string` to `string | readonly string[]`, and
`paintFrame` normalizes it. Widening rather than replacing keeps every existing
hand-built geometry literal (`{ fg: '#000', ... }`) valid, in tests and for
consumers of the exported type. `computeGeometry` passes the resolved palette
straight through from `ResolvedOptions`.

### 4. Sprite cache and Skia pictures

Neither needs structural change — both already paint through
`computeGeometry` + `paintFrame`, so a palette flows through as soon as
`PaintGeometry` carries one. What does need attention:

- **`skiaPaintContext` keeps one `SkPaint` per color**, lazily created in a
  `Map<string, SkPaint>` keyed by the color string, instead of mutating a single
  paint. This is what the PRD asks for, it avoids re-parsing a color on every
  tone switch, and — the real reason — it removes any dependence on whether
  `createPicture` snapshots paint state at record time or holds a reference.
  With one paint per tone the question cannot arise.
- **`useDitheredPictures` keys its memo on palette _value_, not identity.**
  `fg={['#a', '#b']}` is a fresh array every render; with `fg` in the dependency
  array every render would re-record every frame. The dependency becomes a
  joined string key (`palette.join(' ')`).
- **The React wrapper stabilizes `fg` the same way** before handing it to
  `update()`, so an inline palette literal does not trigger a resample and a
  full sprite-strip rebuild on every render.

### 5. `currentColor` is resolved in the web renderer, not only the wrapper

The PRD scopes `currentColor` to the React wrapper. We resolve it one level
down, in `createDithered`, because that is where the canvas element and the
`configure()`/cache-rebuild path already live:

- Any palette entry equal to `currentColor` (ASCII case-insensitive, as CSS is)
  is replaced with `getComputedStyle(canvas).color` at `configure()` time —
  i.e. on create and on every `update()`. A failed or empty lookup falls back
  to `DEFAULTS.fg`.
- The unresolved palette is what is stored in `opts`, so a later re-resolve
  always starts from the token, never from a stale resolved value.
- `DitheredInstance` gains `refreshColors(): void`: re-resolve, and if the
  resolved palette actually changed, rebuild the sprite strip and repaint the
  current frame. If nothing changed it is a no-op, which is the common case.
- The React wrapper calls `refreshColors()` from an effect keyed on
  `[className, style, fg]`, but only when the palette contains `currentColor`.
  React applies `style` to the canvas before effects run, so the computed color
  is current by then. Because the call no-ops when the color is unchanged, the
  new object identity of an inline `style={{...}}` literal every render is
  harmless.
- This satisfies the PRD's acceptance criterion (works in `dithered/react`) and
  additionally makes it work for plain `createDithered` users. Automatic
  re-resolution on an ambient theme change with no React re-render remains out
  of scope, as the PRD states; `refreshColors()` is the documented escape hatch.

**Native rejects it.** There is no cascade, and `Skia.Color('currentColor')`
would throw somewhere far from the cause. Palette normalization on the native
path throws eagerly with a clear message:

```
dithered: 'currentColor' is not supported on native — pass an explicit color.
```

This surfaces from `useDitheredPictures` (and therefore `<Dithered>` from
`dithered/native`) during render, at the point the bad prop is passed.

## Alternatives considered

- **The PRD's literal `0..n-1` formula.** Rejected: it paints every cell at
  `n === 1`, breaking the one constraint the feature must not break. Adopting
  it plus a "if `n === 1` use the old rule" special case would leave the two
  paths free to drift and would still be wrong at `n >= 2` (nothing would ever
  be skipped, so `bg` would show through nowhere).
- **`Brightness` returning a color string per cell.** Explicitly out of scope in
  the PRD, and it would defeat the sprite cache and picture recording, which
  depend on the drawn colors being a small closed set.
- **A separate `palette` option, leaving `fg` a string.** Two options meaning
  the same thing, with a precedence rule to document and test. The union type
  costs one normalization helper and keeps one concept.
- **Drawing one pass per tone, re-calling `brightness` each pass.** Simpler code
  (no buckets, no allocation) but `n` times the brightness calls, and it breaks
  any stateful brightness function outright — `gameOfLife` advances its board
  per call.
- **Resolving `currentColor` in the React wrapper only**, as the PRD sketches.
  It would need `getComputedStyle` on a ref in the wrapper and would leave
  `createDithered` users without it, while duplicating palette-resolution logic
  in two places. Resolving in the renderer is strictly less code.
- **Re-resolving `currentColor` via `MutationObserver` on `class`/`style`, or a
  `transitionend` listener.** Out of scope per the PRD, and it would add an
  always-on observer to every instance for a case most callers do not have.

## Consequences

- Single-color output is provably unchanged, and existing tests keep passing
  without edits.
- `PaintGeometry.fg` and `DitheredOptions.fg` widen. Both are backwards
  compatible for callers; a consumer who _reads_ `geometry.fg` and assumes
  `string` would now need a narrowing check. `dithered` is at `0.1.0` and PR #3
  is unreleased, so this is acceptable without a deprecation cycle.
- `DitheredInstance` gains a method, which is additive.
- `paintFrame` allocates `n` arrays per call when `n > 1`. No allocation when
  `n === 1`.
- Native and web diverge, deliberately and loudly, on `currentColor`. A shared
  component that spreads one props object at both entries will throw on native
  if it passes `currentColor` — which is the intended, documented behavior, and
  is better than silently painting black.
- The `n > 1` visual result depends on `Brightness` actually using its full
  `0..1` range. Presets that effectively return near-binary values will show
  fewer tones than the palette has. Documented, not fixed here.

## Implementation plan

### Files to add

| File                                         | What                                                                                                                                             |
| -------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `packages/dithered/src/core/palette.ts`      | `toPalette`, `hasCurrentColor`, `resolvePalette`, `toneLevel`, `CURRENT_COLOR`. The whole quantization and normalization surface, platform-free. |
| `packages/dithered/src/core/palette.test.ts` | Unit tests for the above, including the `n === 1` equivalence table.                                                                             |

### Files to change

| File                                                                   | Change                                                                                                                                                                                                                   |
| ---------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `src/core/options.ts`                                                  | `fg?: string \| readonly string[]`; doc comment for palettes and `currentColor`. `DEFAULTS.fg` stays `'#000'`.                                                                                                           |
| `src/core/paint.ts`                                                    | `PaintGeometry.fg: string \| readonly string[]`; `paintFrame` normalizes, buckets by level for `n > 1`, keeps today's inline loop for `n === 1`.                                                                         |
| `src/core/index.ts`                                                    | Export the palette helpers and their types.                                                                                                                                                                              |
| `src/renderer.ts`                                                      | Resolve `currentColor` against `getComputedStyle(canvas).color` in `configure()`; add `refreshColors()` to `DitheredInstance`; keep the unresolved palette in `opts`.                                                    |
| `src/react.tsx`                                                        | Accept `fg: string \| string[]`; stabilize palette identity by value before `update()`; `refreshColors()` effect keyed on `[className, style, fg]`, guarded on the palette containing `currentColor`.                    |
| `src/native/paint-context.ts`                                          | One `SkPaint` per color, cached in a `Map`.                                                                                                                                                                              |
| `src/native/pictures.ts`                                               | Throw on `currentColor`; memo keyed on palette value, not identity.                                                                                                                                                      |
| `src/native/Dithered.tsx`                                              | Widen the `fg` prop through to `useDitheredPictures`.                                                                                                                                                                    |
| `src/index.ts`, `src/native.ts`                                        | Re-export the new public helpers/types.                                                                                                                                                                                  |
| `README.md` (repo root — `packages/dithered` has no README of its own) | A "Palettes" section with a runnable example, the quantization rule, the `currentColor` section marked web-only with the native error, and the `fg` row of the props table updated to `string \| string[]`.              |
| `packages/playground-web/main.tsx`                                     | A palette picker: a tone-count control (1–3) with a color input per tone, wired into the live preview and into `buildSnippet` so the emitted snippet shows `fg={[...]}` for a palette and `fg="..."` for a single color. |

### Tests to write

1. **`toneLevel` equivalence at `n === 1`** — for every one of the 16 Bayer
   thresholds, across a sweep of `b` (including `0`, `1`, `NaN`, negatives,
   values just either side of each threshold), assert
   `toneLevel(b, t, 1) === 1` iff `b > t`.
2. **`toneLevel` at `n = 2` and `n = 3`** — table-driven: level boundaries,
   saturation at `b >= 1`, `frac === threshold` landing on the darker tone.
3. **Single-color output snapshot** — a recording `PaintContext` fake; assert the
   full call sequence for `fg: '#8232ff'` is identical before and after (a
   committed expected-call-log fixture), including the no-cells-drawn case.
4. **Palette output** — `fg: ['#a00', '#0a0', '#00a']` over a brightness ramp:
   assert each cell paints the expected color, that `fillStyle` is assigned at
   most `n` times (plus `bg`), and that `brightness` is called exactly once per
   cell.
5. **Boolean brightness with a palette** — `true` paints the last entry,
   `false` paints nothing.
6. **Empty palette** — `fg: []` falls back to `'#000'`.
7. **Sprite cache with a palette** — `createDithered` with `cache: true` and a
   3-tone palette; assert the strip is built and blitted, and that a
   cached and an uncached instance paint the same colors.
8. **`currentColor` on web** — jsdom: canvas with a computed `color`; assert the
   resolved palette uses it, that `update()` re-resolves, that `refreshColors()`
   picks up a changed color and no-ops when unchanged, and that a mixed palette
   (`['currentColor', '#fff']`) resolves only the token.
9. **`currentColor` in `dithered/react`** — render `<Dithered fg="currentColor">`
   under a styled parent; assert the painted color matches, and that changing
   `style` re-resolves.
10. **`currentColor` on native throws** — `useDitheredPictures` with
    `fg: 'currentColor'` and with `fg: ['#000', 'CURRENTCOLOR']` both throw the
    documented message.
11. **`skiaPaintContext` palettes** — against the existing fake `SkCanvas`:
    a distinct paint per color, paints reused across tone switches, and the
    color actually applied to each drawn rrect.
12. **`useDitheredPictures` memo stability** — re-render with an equal-but-new
    `fg` array and assert the returned `pictures` array is referentially the
    same (no re-record).
