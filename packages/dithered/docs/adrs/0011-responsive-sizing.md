# 0011 — Responsive sizing on web (`size: 'fill'`, DPR change handling)

## Status

Proposed

## Context

`size` is a fixed CSS-pixel height, resolved once and baked into the backing store by
`configure()` in `packages/dithered/src/renderer.ts`. Two things break in real layouts
(see issue #11):

1. **Container-driven size.** A hero or empty-state illustration needs to fill its
   parent. Today the caller has to measure the parent with their own `ResizeObserver`
   and push a new `size` in through `update()`, which runs the whole of `configure()` —
   including a full `sampleCells()` resample and a sprite-strip rebuild — on every pixel
   of change.
2. **Device pixel ratio changes.** `devicePixelRatio` is read once, inside `configure()`,
   and clamped to a hard-coded `3`. Drag the window to a monitor with a different scale
   factor, or zoom the browser, and the backing store keeps the old resolution: the
   canvas renders blurry (DPR went up) or wastefully oversized (DPR went down) until some
   unrelated `update()` happens to run.

Two facts about the current code shape the decision:

- **Cells do not depend on `size`.** `sampleCells(shape, cols, hitTest, rows)` samples the
  shape's viewBox on a normalized grid; its output is a function of `shape`, `cols` and
  `rows` only. `size` and DPR enter later, through `computeGeometry(opts, W, H)`. The
  existing `configure()` conflates the two, which is why resizing currently resamples.
- **The sprite strip _is_ resolution-dependent.** It is rasterized at `W × H` device
  pixels per frame, so a change in backing-store size does invalidate it.

So the expensive work a resize can trigger is the strip rebuild, not the resample — and
the resample is avoidable outright.

The renderer is also the only place that reads `devicePixelRatio`, `canvas.style` and
`document`; the platform-free core (`src/core/`) must stay DOM-free so `dithered/native`
never pulls DOM code into a native bundle.

## Decision

### API

```ts
export type Size = number | 'fill';

interface DitheredOptions {
  /** CSS px height, or 'fill' to track the canvas's parent box. Default 48. Web only for 'fill'. */
  size?: Size;
  /** Upper bound on the backing-store DPR. Default 3. Web only; native ignores it. */
  maxDpr?: number;
}
```

`'fill'` is rejected on native at _both_ compile time and runtime: `dithered/native`'s
`DitheredProps` narrows `size` to `number`, and the shared core throws
`dithered: size: 'fill' is web-only; on native, size the <Canvas> through the style prop.`
from a new `resolveSizePx()` guard that `useDitheredPictures` goes through.

### Split `configure()` into three stages

| Stage            | Depends on                                              | Re-run when                                               |
| ---------------- | ------------------------------------------------------- | --------------------------------------------------------- |
| `resample()`     | `shape`, `cols`, `rows`                                 | those change (never on resize or DPR change)              |
| `applySurface()` | resolved size px, DPR, shape aspect                     | size or DPR changes                                       |
| `buildCache()`   | cells, `W`/`H`, brightness, frames, colors, gap, radius | after either of the above, subject to the threshold below |

`update()` runs whichever stages its patch touches. `sampleCells` is therefore never
called from a resize or a DPR change, which satisfies the PRD's "sub-cell resizes do not
resample" criterion by construction and extends it to _all_ resizes.

### Fill: measurement and fit

- Observe `canvas.parentElement` with one `ResizeObserver`, created lazily the first time
  the instance is in fill mode and disconnected when it leaves fill mode or is destroyed.
- Fit the shape's aspect ratio inside the parent's **content box** (contain):
  `sizePx = min(contentHeight, contentWidth / aspectOf(shape))`. The canvas CSS width and
  height are both written explicitly; nothing relies on `width: 100%`, because the aspect
  ratio has to come from the shape.
- Measurement source: the `ResizeObserver` entry's `contentBoxSize` when present, falling
  back to `contentRect`. The synchronous first measurement (before the observer has
  delivered anything) reads `parent.clientWidth/clientHeight` minus computed horizontal
  and vertical padding, so the first paint is already correct and there is no flash at the
  default 48.
- In fill mode the canvas also gets `display: block`, so the inline-element baseline gap
  cannot feed a few pixels back into a shrink-wrapping parent every cycle.

### Feedback-loop protection

The canvas is a child of the box it measures, so writing its CSS size can in principle
change that box. Three guards, in order of importance:

1. **Contain-fit is a fixed point.** For a shrink-wrapping parent the next measurement is
   `min(H, (H·a)/a) = H` — the same value — so the sequence converges immediately instead
   of ratcheting down.
2. **Epsilon guard.** A measurement whose fitted size differs from the currently applied
   size by less than `0.5` CSS px is dropped before anything is written to the DOM. This
   is what actually stops a ping-pong between two sub-pixel values.
3. **`display: block`**, as above.

A parent whose own size is driven by its content _and_ which adds padding or a border can
still walk downward; that is documented as unsupported (give the fill parent a size).

### Resize cost: the one-cell threshold

Track `builtWidth` — the device-pixel width the current cells/strip were built at. On each
accepted measurement, compare the new device width against it:

- **`|ΔW| < builtWidth / cols`** (less than one cell): **cheap path.** Write the new CSS
  size, resize the backing store, and re-blit. When a sprite strip exists, the blit
  rescales the current frame out of the existing strip with `drawImage` (source rect at
  the strip's resolution, destination the new `W × H`); when there is no strip, `blit()`
  already repaints through `paintFrame` with freshly computed geometry, which is exact.
  No resample, no strip rebuild.
- **`|ΔW| ≥ builtWidth / cols`**: **full path.** Resize the backing store, rebuild the
  strip at the new resolution, re-blit, and update `builtWidth`.

During a drag-resize the full path runs once per cell boundary crossed (≈ 16 rebuilds
across a 400 px drag at `cols: 16`), not once per observer callback, which is the
rebuild-storm protection. No timer, no debounce: the threshold _is_ the debounce, and a
timer would leave the last frame of a drag stale for its duration.

The residual is bounded: between two cell boundaries the strip can be up to one cell
(≈ 6 % at `cols: 16`) off its ideal resolution, so a resize that stops mid-cell leaves a
slightly soft sprite until the next reconfigure. This only affects cached instances, and
`cache: 'auto'` turns the strip _off_ above 120 px — i.e. off for essentially every filled
hero, where the cheap path repaints exactly. Accepted.

### Cache policy against the resolved size

`useCache = opts.cache === 'auto' ? sizePx <= 120 : opts.cache`, where `sizePx` is the
_resolved_ size — the fill-fitted value in fill mode. A filled hero at 400 px therefore
correctly opts out of the strip, and a filled 60 px box in a small container opts in.
Crossing the 120 px boundary during a resize is handled by the full path (it re-evaluates
`useCache` and drops or builds the strip accordingly); the threshold check is on device
width, so a crossing always coincides with a full path or is smaller than one cell.

### Zero-size and absent parents

- **No `parentElement`** (canvas not yet in the document): fall back to the numeric default
  (`DEFAULTS.size`, 48), attach no observer, and `console.warn` once per instance. A later
  `update()` re-attempts the attachment, so a canvas mounted afterwards recovers.
- **Degenerate content box** (either axis `≤ 0` — `display: none`, a collapsed flex item,
  pre-layout): enter a **dormant** state. Set the canvas CSS size to `0px × 0px`, halt the
  animation loop, and _retain_ the backing store, the cells and the strip along with the
  last good `sizePx`, so waking is a CSS write plus a blit. Never resample or rebuild while
  dormant, and never write a `0` backing-store dimension. On the next non-degenerate
  measurement, leave dormancy through the normal accepted-measurement path (cheap or full
  depending on Δ) and reschedule the loop.
- **No `ResizeObserver`** (old browser, bare jsdom): take the one synchronous measurement
  and stay at it; `update()` re-measures. Documented.

### DPR

```ts
function armDpr(): void {
  disarmDpr();
  const raw = rawDpr(); // window.devicePixelRatio || 1
  mql = window.matchMedia(`(resolution: ${raw}dppx)`);
  // Safari < 14 has only addListener.
  if (mql.addEventListener) mql.addEventListener('change', onDprChange);
  else mql.addListener?.(onDprChange);
}
```

- Arm on the **raw** `devicePixelRatio`, never on the `maxDpr`-clamped value. Clamping
  first would build `(resolution: 3dppx)` on a 4× display — a query that is already false
  and never transitions, so the listener would never fire.
- `onDprChange` re-arms unconditionally (a `MediaQueryList` for the _old_ ratio is
  useless once the ratio moved) and then does work only if the **effective** DPR —
  `min(raw, maxDpr)` — actually changed. Raw 4 → 5 under `maxDpr: 3` re-arms and repaints
  nothing.
- Work on an effective change = `applySurface()` + `buildCache()` + re-blit the current
  frame. No resample: cells are DPR-independent.
- Guards: `matchMedia` absent or throwing (jsdom, SSR) degrades to no DPR tracking;
  a non-finite or non-positive `devicePixelRatio` reads as `1`; `maxDpr` is clamped to
  `≥ 1`.
- Both the `ResizeObserver` and whichever DPR listener form was used are released in
  `destroy()`, alongside the existing `IntersectionObserver` and `visibilitychange`
  listener. `destroy()` is idempotent.

### `update({ size })` transitions

| From → to                      | Behaviour                                                                                                                                                                                 |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| number → number                | As today: `applySurface()` + `buildCache()` + blit.                                                                                                                                       |
| number → `'fill'`              | Attach the observer to the current `parentElement`, measure synchronously, configure at the fitted size (or go dormant / fall back per the rules above).                                  |
| `'fill'` → number              | Disconnect the observer, drop the fill state, configure at the numeric size. Reset `display` to what it was before fill mode set it.                                                      |
| `'fill'` → `'fill'`            | Keep the existing observer (no disconnect/reconnect churn), re-measure synchronously in case the parent changed.                                                                          |
| any other option, in fill mode | `opts.size` stays `'fill'`; the resolved `sizePx` is derived state and is _not_ clobbered. A `shape` change re-fits (the aspect ratio changed); a `cols` change re-derives the threshold. |

`update()` keeps its current `assignDefined` merge semantics, so a forwarded
`size: undefined` still leaves the current value alone.

## Alternatives considered

- **`width: 100%` + CSS `aspect-ratio`.** Lets the browser do the fitting, but the aspect
  ratio has to come from the shape's viewBox, the backing store still needs an explicit
  device-pixel size on every layout change, and reading back the laid-out size costs the
  same observer. No saving, less control.
- **Debounce the rebuild on a trailing timer (e.g. 100 ms).** Smoother during a fast drag,
  but it leaves the sprite stale for the debounce window _after_ the drag ends — the most
  visible moment — and adds a timer to cancel in `destroy()`. The one-cell threshold gives
  bounded staleness with no timer at all.
- **Rebuild on every observer callback.** Simple and always crisp; rebuilds the whole strip
  ~60×/s during a drag. Rejected outright — it is the problem the PRD names.
- **Poll `devicePixelRatio` from the rAF loop.** One line, no listeners, but it only works
  while the loop runs — a paused, reduced-motion or offscreen instance would stay blurry —
  and it burns a comparison every frame. The `matchMedia` re-arm is the standard trick and
  fires even while halted.
- **Observe the canvas itself instead of the parent.** Guarantees a feedback loop: the
  canvas's size is exactly what we write.
- **Let `'fill'` fall back silently to 48 on native.** Rejected: a silently wrong size on
  one platform is worse than a loud error. Compile-time narrowing plus a runtime throw.

## Consequences

- Resizes get cheaper across the board: no resize or DPR change resamples cells any more,
  including the numeric-`size` path that does today.
- `ResolvedOptions['size']` becomes `number | 'fill'`, so internal consumers can no longer
  treat it as a number. `surfaceSize(opts, scale)` becomes
  `surfaceSize(sizePx: number, shape: Shape, scale?)`; it is exported from `core/` but not
  from the package root (`src/index.ts` does not re-export it), so this is not a public
  break. `dithered/native` narrows `size` to `number` in its props — a compile error only
  for native code that was already broken.
- One new observer and one new media-query listener per web instance in fill mode; both
  released in `destroy()`. Instances with a numeric size gain the DPR listener only.
- A filled instance whose parent shrink-wraps _and_ has padding can walk downward; the
  README documents that the fill parent needs its own size.
- A drag-resize can leave the sprite strip up to one cell off its ideal resolution, as
  described above.
- `maxDpr` is a new public option that also removes a hard-coded `3`.

## Implementation plan

### Files to change

- **`packages/dithered/src/core/options.ts`**
  - `export type Size = number | 'fill'`; widen `DitheredOptions['size']`; add `maxDpr?: number`.
  - `DEFAULTS.maxDpr = 3`.
  - `resolveSizePx(size: Size, api?: string): number` — returns the number, throws the
    web-only error for `'fill'`.
  - `fitSize(contentWidth, contentHeight, aspect): number` — contain fit, `0` for a
    degenerate box (pure function, DOM-free, directly unit-testable).
  - `surfaceSize(sizePx: number, shape: Shape, scale = 1)` — new signature.
  - `resolveMaxDpr(opts)` / `effectiveDpr(raw, maxDpr)` helpers.
- **`packages/dithered/src/core/index.ts`** — export `Size`, `fitSize`, `resolveSizePx`,
  `effectiveDpr`.
- **`packages/dithered/src/renderer.ts`** — the bulk:
  - Split `configure()` into `resample()`, `applySurface()`, `buildCache()`; add
    `reconfigure(what)`.
  - Fill state: `sizePx`, `builtWidth`, `dormant`, `fillObserver`, `previousDisplay`.
  - `measureParent()`, `onResize(entries)`, `applyMeasurement(sizePx)` with the epsilon
    guard and the one-cell threshold.
  - `armDpr()` / `disarmDpr()` / `onDprChange()`.
  - `update()` transition table above; `destroy()` releases the observer and the DPR
    listener and is idempotent.
  - `blit()` learns to rescale out of a strip built at a different resolution.
- **`packages/dithered/src/native/pictures.ts`** — route `size` through `resolveSizePx`
  and the new `surfaceSize` signature.
- **`packages/dithered/src/native/Dithered.tsx`** — narrow `size?: number` in
  `DitheredProps`.
- **`packages/dithered/src/react.tsx`** — `size?: Size` flows through unchanged (it is
  already `Omit<DitheredOptions, …>`-derived); add `maxDpr` to the `createDithered` call
  and to the `update()` effect's dependency list.
- **`packages/dithered/src/test-utils.ts`** — add a `ResizeObserver` stub (recording
  instances, `observe`/`unobserve`/`disconnect`, plus a `trigger(entries)` helper) and
  upgrade the `matchMedia` stub to a real `MediaQueryList`-alike with
  `addEventListener`/`removeEventListener`/`addListener`/`removeListener`, per-query
  matching, and a way to dispatch a `change`. Keep the current
  `prefers-reduced-motion → { matches: false }` behaviour for existing tests.
- **`README.md`** (repo root — there is no `packages/dithered/README.md`; the root README
  is the package's documentation) — document `size: 'fill'` with a worked example,
  `maxDpr`, the option-table rows, the parent-sizing requirement, the web-only note for
  native, and the cache-threshold interaction.
- **`packages/playground-web/main.tsx`** — a "fill the box" example: a resizable container
  (`resize: both; overflow: hidden` with a min size) holding a `<Dithered size="fill" />`,
  a live read-out of the measured box, and a note that dragging the corner re-fits.

### Tests to write (`packages/dithered/src/renderer.test.ts`, plus `core` unit tests)

1. `fitSize` unit tests: contains on both axes, picks the limiting one, returns `0` for a
   degenerate box, and handles non-square aspects.
2. `size: 'fill'` sets the canvas CSS width/height to the contain-fit of a mocked parent
   box, with width following the shape's aspect ratio.
3. A `ResizeObserver` delivery with a larger box re-fits: CSS size and backing store both
   follow, at `size × dpr`.
4. Sub-cell resize does **not** resample — `vi.spyOn` on `sampleCells` (or a module mock)
   records zero further calls, and the strip is not rebuilt (no new offscreen canvas).
5. Super-cell resize **does** rebuild the strip but still does not resample.
6. Epsilon guard: a measurement within 0.5 CSS px writes nothing to `canvas.style`.
7. Degenerate parent box → dormant: CSS size `0px`, loop halted, backing store retained;
   a following non-degenerate box wakes it and re-blits.
8. No parent element → falls back to 48 and attaches no observer.
9. DPR change: with a mocked `matchMedia`, dispatching `change` after moving
   `devicePixelRatio` from 2 to 3 reconfigures — backing store becomes `size × 3` — and
   the listener is re-armed on a `(resolution: 3dppx)` query.
10. `maxDpr` clamps the backing store (raw 4, `maxDpr: 2` → `size × 2`), and a raw
    change entirely above the clamp re-arms without rebuilding.
11. `destroy()` disconnects the `ResizeObserver` _and_ removes the DPR listener (and is
    safe to call twice).
12. `update()` transitions: number → `'fill'` attaches an observer and re-fits;
    `'fill'` → number disconnects it and uses the number; `'fill'` → `'fill'` keeps the
    same observer instance; an unrelated `update()` in fill mode preserves the fitted size.
13. `cache: 'auto'` is evaluated against the resolved size: a fill that resolves to 400
    builds no strip; one that resolves to 60 does.
14. Native: `size: 'fill'` through `useDitheredPictures` throws with the web-only message.
15. No feedback loop: re-delivering the _same_ box after the canvas CSS size was written
    produces no further style writes and no rebuild.

### Checks

`pnpm install`, then `pnpm format`, `pnpm build`, `pnpm typecheck`, `pnpm test` from the
workspace root, all green.
