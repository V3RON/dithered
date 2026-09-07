import {
  DEFAULTS,
  advancePhase,
  assignDefined,
  clonePaletteOption,
  computeGeometry,
  effectiveDpr,
  fitSize,
  frameForPhase,
  hasCurrentColor,
  loopsAt,
  paintFrame,
  phaseForFrame,
  resolveOptions,
  resolvePalette,
  resolveRows,
  resolveSizePx,
  surfaceSize,
  toPalette,
  wrapFrame,
  wrapPhase,
  type DitheredOptions,
  type PaintContext,
  type PaintGeometry,
  type Palette,
  type ResolvedOptions,
} from './core';
import { aspectOf, sampleCells, type Cell } from './shape';

// Re-exported so `dithered`'s public surface (and the deep import
// `dithered/dist/renderer`) keeps working now that these live in core/.
export type { Brightness, DitheredOptions, PaintContext, PaintGeometry } from './core';
export { frameAt, paintFrame } from './core';

export interface DitheredInstance {
  setPaused(paused: boolean): void;
  /** Re-configures the instance; may resample cells and/or rebuild the sprite cache. */
  update(options: Partial<DitheredOptions>): void;
  /** Draws a specific frame directly, bypassing the animation loop. */
  renderFrame(frame: number): void;
  /**
   * Re-resolves any `'currentColor'` entries in `fg` against the canvas's
   * current computed text color, and — only if the resolved palette
   * actually changed — rebuilds the sprite cache and repaints the current
   * frame. A no-op otherwise, so calling this on every render (e.g. from a
   * `style`-keyed effect) is cheap. `create()`/`update()` already do this
   * on create and on every `update()`; call this directly for the case
   * ADR 0005 §5 leaves out of scope — an ambient theme change with no
   * other option change to trigger `update()`.
   */
  refreshColors(): void;
  /**
   * Drives playback externally: sets the loop phase to `t` (loop units —
   * `1` is one full loop) and halts the internal clock. Idempotent —
   * repeated calls that land on the same frame index repaint at most
   * once — and does not fire `onLoop`, since a jump isn't a wrap. A
   * non-finite `t` (`NaN`, `Infinity`, `-Infinity`) is ignored: the
   * displayed frame holds and neither callback fires.
   */
  setTime(t: number): void;
  /**
   * Hands playback back to the internal clock, resuming from wherever
   * `setTime` left the phase rather than snapping back to the phase the
   * clock had reached before `setTime` took over.
   */
  clearTime(): void;
  /** Stops the loop and releases all listeners/observers. */
  destroy(): void;
}

interface MeasuredBox {
  width: number;
  height: number;
}

function prefersReducedMotion(opts: ResolvedOptions): boolean {
  if (!opts.respectReducedMotion) return false;
  if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return false;
  try {
    return window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  } catch {
    return false;
  }
}

/**
 * Creates and starts an animated dither loop on `canvas`.
 *
 * Generalizes the Rozenite loading spinner's playback engine: time is
 * quantized to the dither frame grid (redraws are skipped for repeated
 * frames), an optional sprite-strip cache turns steady-state playback
 * into a single `drawImage` per frame, and playback pauses when the tab
 * is hidden, the canvas leaves the viewport, or `prefers-reduced-motion`
 * is set — falling back to a single static frame in that last case.
 *
 * `size: 'fill'` tracks the canvas's parent content box (contain-fit to
 * the shape's aspect ratio) via `ResizeObserver`, and the backing store
 * follows `devicePixelRatio` (clamped to `maxDpr`) even when it changes
 * after creation — see the responsive-sizing ADR (0011) for the full
 * design.
 *
 * Playback itself is a phase accumulator in loop units (`phase += (dt /
 * period) * speed`, see `core/clock.ts`), not a function of wall-clock
 * time — that's what makes `speed`, negative `speed`, `onLoop`, and
 * `setTime`/`clearTime` possible without ever moving the displayed frame
 * discontinuously. See ADR 0006.
 */
export function createDithered(
  canvas: HTMLCanvasElement,
  options: DitheredOptions,
): DitheredInstance {
  const rawCtx = canvas.getContext('2d');
  if (!rawCtx) {
    throw new Error('dithered: unable to acquire a 2D canvas context.');
  }
  const ctx: CanvasRenderingContext2D & PaintContext = rawCtx;

  let opts = resolveOptions(options);
  // `opts.fg` may hold the unresolved `'currentColor'` token; `paintOpts`
  // is what geometry is actually built from, with that token replaced by
  // `applyResolvedFg()`. Keeping them separate means a later re-resolve
  // (`refreshColors`) always starts from the token, never from a stale
  // resolved value baked into `opts`.
  let paintOpts: ResolvedOptions = opts;
  let reduced = prefersReducedMotion(opts);

  // `W`/`H` are the backing store's *integer* pixel dimensions — what
  // `canvas.width`/`height`, the sprite strip, and `drawImage` need.
  // `cssW`/`cssH` are the CSS-pixel size `canvas.style` is set to. The
  // context is given a device transform, `setTransform(W / cssW, 0, 0,
  // H / cssH, 0, 0)` — the browser's own two independent stretch
  // factors — and everything is then painted in CSS pixels, through
  // `computeGeometry(opts, cssW, cssH)`: the identical call
  // `renderToSvg` makes. There is no correction factor left to get
  // wrong on either axis; the backing store's rounding of `W`/`H` still
  // resamples the result by a fraction of a device pixel, but that is
  // rasterization, not geometry. See the ADR's "the canvas must paint
  // in CSS pixels under a device transform" section.
  let W = 0;
  let H = 0;
  let cssW = 0;
  let cssH = 0;
  let dpr = 1;
  let cells: Cell[] = [];
  let sheet: HTMLCanvasElement | null = null;
  // Device-pixel dimensions the current `sheet` (or, absent one, the last
  // exact paint) was built at. Compared against `W`/`H` to decide whether
  // a fill-mode resize can cheaply rescale the existing sprite via
  // `drawImage` or needs a full rebuild — see `resizeTo`.
  let builtW = 0;
  let builtH = 0;

  // --- responsive-size state (web only; see ADR 0011) -------------------
  // The resolved CSS-px height in effect right now: `opts.size` itself
  // when numeric, or the fill-fitted value when `opts.size === 'fill'`.
  let sizePx = 0;
  let dormant = false;
  let resizeObserver: ResizeObserver | null = null;
  // True once `attachFillObserver()` has captured `previousDisplay` and set
  // `display: block` — gated on this rather than on `resizeObserver` being
  // non-null, since the latter stays `null` forever when the global
  // `ResizeObserver` is unavailable, which would otherwise re-capture
  // `previousDisplay` (already 'block' by then) on every call.
  let fillArmed = false;
  let previousDisplay: string | undefined;
  // The element `resizeObserver` currently observes, so a reparented
  // canvas can `unobserve` the old parent instead of accumulating targets.
  let observedParent: Element | null = null;
  let warnedNoParent = false;
  // Set when an `update()` (or a DPR change) arrives while dormant: the
  // patch's surface/cache-affecting work can't run against a 0x0 backing
  // store, so it's deferred and forced through on the next wake regardless
  // of the one-cell threshold (see `resizeTo` and review finding 1).
  let pendingRebuild = false;
  // One-time warnings, so a persistently-too-large or persistently-detached
  // instance doesn't spam the console on every resize/update.
  let warnedCacheTooLarge = false;

  // A large resolved size (easiest to reach via `size: 'fill'`) times
  // `frames` can exceed the canvas dimension limit browsers silently clamp
  // to; past that the strip would allocate as blank and every frame would
  // blit nothing. 32767 is Firefox's limit -- the tightest of the major
  // engines (Chrome's is considerably higher) -- so it's the realistic
  // floor rather than a value picked to merely "feel safe": a strip under
  // it is one every shipping browser can actually rasterize. Compared
  // against the *strip* width (`W * frames`) and the frame height (`H`)
  // separately, not a combined-area budget (review finding 3: the
  // previous 16384 value tripped for perfectly ordinary default-configured
  // instances -- a retina-DPR instance on a moderately wide shape).
  const MAX_STRIP_DIMENSION = 32767;

  /** Whether a sprite strip at the current W/H/frames would exceed a safe canvas size. */
  function tooLargeForStrip(): boolean {
    return W * opts.frames > MAX_STRIP_DIMENSION || H > MAX_STRIP_DIMENSION;
  }

  /**
   * Whether the sprite-strip cache should exist right now, given the
   * resolved `cache` policy and the size cap above. Shared by `buildCache()`
   * (which acts on it) and `resizeTo()` (which needs to know whether the
   * *actual* cache state disagrees with the policy, to decide whether a
   * cheap-path resize must still force a rebuild -- see review finding 3's
   * secondary issue: comparing against the cap-unaware policy alone left
   * `cacheStateStale` permanently true whenever the cap was in effect).
   */
  function shouldUseCache(): boolean {
    const requestedCache = opts.cache === 'auto' ? sizePx <= 120 : opts.cache;
    return requestedCache && !tooLargeForStrip();
  }

  // --- DPR tracking ------------------------------------------------------
  let mql: MediaQueryList | null = null;
  let lastEffectiveDpr = 1;

  let raf = 0;
  let currentFrame = -1;
  let isPaused = opts.paused;
  let visible = true;
  let destroyed = false;

  // Playback state: `phase` is in loop units (1 = one full loop) and is
  // the single source of truth for the displayed frame, whether it's
  // being advanced by the internal clock or pinned by `setTime`.
  // `lastNow` is `null` whenever the clock is not mid-run (freshly
  // created, just resumed from a pause, or just handed back by
  // `clearTime`) so the next tick's `dt` is 0 rather than a jump across
  // however long playback was stopped.
  //
  // Seeded via `phaseForFrame`, not a bare `initialFrame / opts.frames`:
  // the latter rounds down for a third of its valid inputs (ADR 0006
  // §1), which would both paint the wrong initial frame and report it
  // to `onFrame` below. `initialFrame` is wrapped into `[0, opts.frames)`
  // *before* that conversion (ADR 0006 §6) so an out-of-range value
  // (`-1`, `frames`, ...) seeds the same `loopsAt` starting point — `0`
  // — as native's `wrapFrame`-then-convert seed does; seeding it
  // unwrapped makes `loopsAt` start at `-1` for `initialFrame: -1`, so
  // the first forward wrap fires `onLoop(0)` instead of `onLoop(1)`.
  let phase =
    opts.frames > 0 ? phaseForFrame(wrapFrame(opts.initialFrame, opts.frames), opts.frames) : 0;
  let lastNow: number | null = null;
  // True while a `setTime` caller owns `phase`; the internal clock never
  // runs while this is set, regardless of `isPaused`.
  let driven = false;

  function computedColor(): string {
    if (typeof getComputedStyle === 'undefined') return '';
    try {
      return getComputedStyle(canvas).color;
    } catch {
      // A canvas that isn't attached to a real document (a test double, or
      // detached-node edge cases) can't be resolved; fall through to the
      // DEFAULTS.fg fallback in `resolvePalette` instead of throwing.
      return '';
    }
  }

  function palettesEqual(a: string | Palette, b: string | Palette): boolean {
    if (a === b) return true;
    const pa = typeof a === 'string' ? [a] : a;
    const pb = typeof b === 'string' ? [b] : b;
    return pa.length === pb.length && pa.every((color, i) => color === pb[i]);
  }

  /**
   * Re-resolves any `'currentColor'` entries in `opts.fg` against the
   * canvas's current computed color and updates `paintOpts` to match.
   * A palette with no `'currentColor'` entry is passed through as-is (by
   * reference, when it's the same array), which is what lets the `fg:
   * string` fast path in `paintFrame` fire for the common case. Returns
   * whether the resolved palette actually changed.
   */
  function applyResolvedFg(): boolean {
    const palette = toPalette(opts.fg);
    const next: string | Palette = hasCurrentColor(palette)
      ? resolvePalette(palette, computedColor())
      : opts.fg;
    const changed = !palettesEqual(next, paintOpts.fg);
    paintOpts = next === opts.fg ? opts : { ...opts, fg: next };
    return changed;
  }

  function isFillMode(): boolean {
    return opts.size === 'fill';
  }

  function rawDpr(): number {
    const d = typeof window !== 'undefined' ? window.devicePixelRatio : 1;
    return typeof d === 'number' && Number.isFinite(d) && d > 0 ? d : 1;
  }

  function warnNoParent(): void {
    if (warnedNoParent) return;
    warnedNoParent = true;
    if (typeof console !== 'undefined') {
      console.warn(
        "dithered: size: 'fill' has no parent element to measure yet; using the default " +
          `size (${DEFAULTS.size}) until update() is called again on a mounted canvas.`,
      );
    }
  }

  /** The parent's content box (client box minus padding), synchronously. */
  function measureParentBox(): MeasuredBox | null {
    const parent = canvas.parentElement;
    if (!parent) return null;
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return { width: parent.clientWidth, height: parent.clientHeight };
    }
    let paddingX = 0;
    let paddingY = 0;
    try {
      const cs = window.getComputedStyle(parent);
      paddingX =
        (parseFloat(cs.paddingLeft || '0') || 0) + (parseFloat(cs.paddingRight || '0') || 0);
      paddingY =
        (parseFloat(cs.paddingTop || '0') || 0) + (parseFloat(cs.paddingBottom || '0') || 0);
    } catch {
      // getComputedStyle can throw in some non-browser test environments.
    }
    return {
      width: parent.clientWidth - paddingX,
      height: parent.clientHeight - paddingY,
    };
  }

  /**
   * `contentBoxSize` reports *logical* dimensions (inline/block axis), which
   * only line up with visual width/height under a horizontal writing mode.
   * Under `writing-mode: vertical-*` the axes are swapped, so the parent's
   * computed writing mode decides how to map them (review finding 8). The
   * `contentRect` fallback below is unaffected — it already reports visual
   * width/height.
   */
  function isVerticalWritingMode(el: Element): boolean {
    if (typeof window === 'undefined' || typeof window.getComputedStyle !== 'function') {
      return false;
    }
    try {
      const mode = window.getComputedStyle(el).writingMode || '';
      return mode.startsWith('vertical');
    } catch {
      return false;
    }
  }

  /** Extracts a `{width, height}` box from a `ResizeObserverEntry`. */
  function boxFromEntry(entry: ResizeObserverEntry): MeasuredBox {
    const boxes = entry.contentBoxSize;
    if (boxes) {
      const box = Array.isArray(boxes) ? boxes[0] : boxes;
      if (box) {
        return isVerticalWritingMode(entry.target)
          ? { width: box.blockSize, height: box.inlineSize }
          : { width: box.inlineSize, height: box.blockSize };
      }
    }
    const rect = entry.contentRect;
    return { width: rect.width, height: rect.height };
  }

  /**
   * Idempotent: captures/applies `display: block` once ('fill' -> 'fill'
   * keeps the same state), and (re-)observes the current parent every time
   * it's called, so a canvas that had no parent yet at the last attempt
   * recovers the moment `update()` runs again after it's mounted.
   *
   * The `ResizeObserver` itself is constructed lazily on the first call that
   * finds an actual parent to observe — not before — per ADR 0011 ("No
   * parentElement … attach no observer"); review finding 6.
   */
  function attachFillObserver(): void {
    if (!fillArmed) {
      fillArmed = true;
      previousDisplay = canvas.style.display;
      canvas.style.display = 'block';
    }
    const parent = canvas.parentElement;
    if (!resizeObserver && parent && typeof ResizeObserver !== 'undefined') {
      resizeObserver = new ResizeObserver((entries) => {
        if (destroyed || !isFillMode()) return;
        const entry = entries[entries.length - 1];
        if (!entry) return;
        applyMeasurement(boxFromEntry(entry));
      });
    }
    // else (no parent yet, or no global ResizeObserver): documented — one
    // sync measurement that stays put until the next update() re-attempts.
    // Re-observing every call is what lets a canvas mounted after the last
    // attempt recover; unobserving the previous parent first is what stops
    // a reparented canvas from being driven by two boxes at once (a stray
    // resize of the old parent would otherwise still reach `applyMeasurement`).
    if (resizeObserver && observedParent !== parent) {
      if (observedParent) resizeObserver.unobserve(observedParent);
      if (parent) resizeObserver.observe(parent);
      observedParent = parent;
    }
  }

  function detachFillObserver(): void {
    if (resizeObserver) {
      resizeObserver.disconnect();
      resizeObserver = null;
    }
    observedParent = null;
    fillArmed = false;
    canvas.style.display = previousDisplay ?? '';
    previousDisplay = undefined;
    dormant = false;
  }

  /** Synchronous fill-size resolution used by create() and update(). */
  function resolveFillSizeSync(): void {
    const box = measureParentBox();
    if (!box) {
      warnNoParent();
      dormant = false;
      // Always the numeric default here — not "leave sizePx alone" — so a
      // `number -> 'fill'` transition on a detached canvas actually matches
      // the warning it just logged instead of silently keeping the old
      // numeric size (see review finding 6).
      sizePx = resolveSizePx(DEFAULTS.size);
      return;
    }
    warnedNoParent = false; // a parent showed up; warn again if it later disappears
    const fitted = fitSize(box.width, box.height, aspectOf(opts.shape));
    if (fitted <= 0) {
      dormant = true;
      return;
    }
    dormant = false;
    sizePx = fitted;
  }

  /** Applied on every accepted `ResizeObserver` delivery in fill mode. */
  function applyMeasurement(box: MeasuredBox): void {
    if (destroyed) return;
    const fitted = fitSize(box.width, box.height, aspectOf(opts.shape));

    if (fitted <= 0) {
      if (!dormant) {
        dormant = true;
        halt();
        canvas.style.width = '0px';
        canvas.style.height = '0px';
      }
      return;
    }

    const wakingFromDormant = dormant;
    // Epsilon guard: sub-pixel measurements (including the parent
    // re-measuring its own now-written size, i.e. the feedback loop) are
    // dropped before touching the DOM at all.
    if (!wakingFromDormant && Math.abs(fitted - sizePx) < 0.5) return;

    dormant = false;
    resizeTo(fitted);
    schedule();
  }

  /**
   * Applies a new fitted size: writes CSS + backing-store dimensions, then
   * rebuilds the sprite cache only if the device-pixel width moved by at
   * least one cell (`builtW / cols`) since the cache was last built —
   * otherwise `blit()` cheaply rescales the existing strip.
   */
  function resizeTo(fitted: number): void {
    sizePx = fitted;
    // `phase` — not `currentFrame` — is the source of truth for what's
    // displayed (see the field comment; `renderFrame()`/`setTime()` both
    // keep it in sync). Captured before `buildCache()` runs, since that
    // always resets `currentFrame` to -1 (review finding 2). While
    // reduced motion is in effect, the frame shown is always `initialFrame`.
    const frameToShow = reduced ? opts.initialFrame : frameForPhase(phase, opts.frames);
    // Also captured here, before a possible `buildCache()` below resets
    // `currentFrame` to -1 — see the identical comment in `update()`.
    const frameBeforeRepaint = currentFrame;
    applySurface();
    // Floored at 2 device px: `W`/`builtW` are always whole device pixels
    // (rounded in `applySurface()`), so the smallest possible nonzero delta
    // is 1 — and the comparison below is `>=`. On a fine grid at a small
    // resolved size (e.g. `cols: 32` on a ~30px fill), `builtW / cols` falls
    // below 1, which — even "floored" at exactly 1 — would still call a
    // 1px delta a full rebuild (`1 >= 1`), i.e. every single observer
    // delivery during a drag, exactly the rebuild storm the threshold
    // exists to prevent. Flooring at 2 instead guarantees at least one
    // device pixel of slack is always absorbed by the cheap path (review
    // finding 5).
    const cellThreshold = builtW > 0 ? Math.max(builtW / opts.cols, 2) : 0;
    // Whether `cache: 'auto'`'s size <= 120 threshold, re-evaluated at the
    // *new* sizePx, disagrees with whether a strip currently exists. A
    // resize can cross that boundary while staying under the one-cell
    // threshold (cheap path); without this check the stale strip would
    // silently keep being rescaled (or stay absent) past the boundary
    // (review finding 4).
    const useCacheNow = shouldUseCache();
    const cacheStateStale = useCacheNow !== (sheet !== null);
    // `pendingRebuild` forces this even under the threshold: a resample or
    // an option change (e.g. `fg`) picked up while dormant has no surface
    // to apply to yet, and waking at the *same* device size would otherwise
    // never rebuild the now-stale cache (see review finding 1, scenario B).
    if (
      pendingRebuild ||
      builtW === 0 ||
      cacheStateStale ||
      Math.abs(W - builtW) >= cellThreshold
    ) {
      buildCache();
    }
    // A resize always warrants a repaint at the new dimensions, even if
    // `frameToShow` happens to equal `currentFrame` — but `onFrame` only
    // fires when the frame index actually moved.
    const frameChanged = frameToShow !== frameBeforeRepaint;
    blit(frameToShow);
    if (frameChanged) opts.onFrame?.(frameToShow, frameToShow / opts.frames);
  }

  // --- the three configure stages (see ADR 0011) ------------------------

  /**
   * Depends only on `shape`/`cols`/`rows`/`hitTest`/`matrix` — never on
   * resize or DPR. The only stage that can throw from a bad candidate
   * option (an invalid custom `matrix`, via `resolveMatrix`), and it never
   * touches the canvas or any other module state — see `update()`.
   */
  function resample(): void {
    cells = sampleCells(opts.shape, opts.cols, opts.hitTest, resolveRows(opts), opts.matrix);
  }

  /** Depends on the resolved size, DPR and shape aspect. */
  function applySurface(): void {
    const newDpr = effectiveDpr(rawDpr(), opts.maxDpr);
    lastEffectiveDpr = newDpr;
    const css = surfaceSize(sizePx, opts.shape);
    canvas.style.width = css.width + 'px';
    canvas.style.height = css.height + 'px';
    const device = surfaceSize(sizePx, opts.shape, newDpr);
    W = canvas.width = Math.round(device.width);
    H = canvas.height = Math.round(device.height);
    // Kept in sync with `W`/`H` here so a later `buildCache()`/`blit()`
    // (which read them via closure) always sees this same surface's
    // values.
    cssW = css.width;
    cssH = css.height;
    dpr = newDpr;
  }

  /** Depends on cells, W/H, brightness, frames, colors, gap and radius. */
  function buildCache(): void {
    // Only warn when the caller explicitly opted into a strip (`cache:
    // true`): under `cache: 'auto'` the cap tripping just means "this
    // particular resolved size doesn't get a strip", which is exactly what
    // `'auto'` is supposed to decide silently — the same way it silently
    // opts out above the 120px size threshold. Warning here too used to
    // fire for perfectly ordinary default-configured instances (e.g. a
    // retina-DPR instance on a moderately wide shape) with a remedy
    // ("pass `cache: false`") that makes no sense to a caller who never
    // asked for a cache (review findings 3 and 10).
    if (
      opts.cache === true &&
      tooLargeForStrip() &&
      typeof console !== 'undefined' &&
      !warnedCacheTooLarge
    ) {
      warnedCacheTooLarge = true;
      console.warn(
        'dithered: the sprite-strip cache would exceed a safe canvas size at this ' +
          'resolution; falling back to direct per-frame painting. Pass `cache: false` ' +
          '(or a smaller `size`) to avoid this check.',
      );
    }
    const useCache = shouldUseCache();
    if (useCache) {
      // `W / cssW`, not `dpr`: that is the factor the browser actually
      // stretches the backing store by when painting it into the CSS
      // box, so geometry matches `renderToSvg`'s CSS-pixel geometry
      // exactly (up to the half-device-pixel `W`/`H` rounding can
      // introduce) — see the field comments above.
      const strip = document.createElement('canvas');
      strip.width = W * opts.frames;
      strip.height = H;
      const sctx = strip.getContext('2d');
      if (sctx) {
        // One frame per `W`-wide device-pixel slot, painted in CSS
        // pixels under the same device transform `blit` uses for the
        // direct-paint path — `ox = f * cssW` lands each frame flush
        // against `f * W` in the backing store.
        sctx.setTransform(W / cssW, 0, 0, H / cssH, 0, 0);
        for (let f = 0; f < opts.frames; f++) {
          paintFrame(
            sctx,
            cells,
            opts.brightness,
            f / opts.frames,
            computeGeometry(paintOpts, cssW, cssH, f * cssW),
          );
        }
        sheet = strip;
      } else {
        sheet = null;
      }
    } else {
      sheet = null;
    }
    builtW = W;
    builtH = H;
    currentFrame = -1;
    pendingRebuild = false;
  }

  function blit(f: number): void {
    const frame = wrapFrame(f, opts.frames);
    // Dormant instances retain W = H = 0 (no surface to paint into) while
    // the animation loop or a direct `renderFrame()` call can still reach
    // here; painting would compute a zero cell size and draw hundreds of
    // degenerate rects into an untouched, default-sized canvas for nothing
    // (review finding 7).
    if (W <= 0 || H <= 0) {
      currentFrame = frame;
      return;
    }
    ctx.setTransform(W / cssW, 0, 0, H / cssH, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    if (sheet) {
      // Sourcing at the strip's *build* resolution and destination at the
      // *current* W/H means an unchanged resolution is a plain 1:1 blit,
      // and a cheap-path resize since the last rebuild is a rescale — one
      // code path for both.
      ctx.drawImage(sheet, frame * builtW, 0, builtW, builtH, 0, 0, W, H);
    } else {
      paintFrame(
        ctx,
        cells,
        opts.brightness,
        frame / opts.frames,
        computeGeometry(paintOpts, cssW, cssH),
      );
    }
    currentFrame = frame;
  }

  /**
   * Paints the frame `phase` maps to, if it differs from what's already
   * on screen, and fires `onFrame`. The one place both the internal
   * clock and `setTime` funnel through, so "a repeated frame index is
   * never redrawn or reported twice" holds for either driver.
   */
  function paintForPhase(): void {
    const f = frameForPhase(phase, opts.frames);
    if (f !== currentFrame) {
      blit(f);
      opts.onFrame?.(f, wrapPhase(phase));
    }
  }

  function schedule(): void {
    if (destroyed || isPaused || !visible || reduced || dormant || driven) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (raf) return;
    raf = requestAnimationFrame(tick);
  }

  function halt(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastNow = null;
  }

  function tick(now: number): void {
    raf = 0;
    const dt = lastNow === null ? 0 : now - lastNow;
    lastNow = now;

    const loopsBefore = loopsAt(phase);
    phase = advancePhase(phase, dt, opts.period, opts.speed);
    const loopsAfter = loopsAt(phase);
    if (loopsAfter !== loopsBefore) opts.onLoop?.(loopsAfter);

    paintForPhase();
    schedule();
  }

  // Resample/rebuild before registering anything the caller would need to
  // release: an invalid `matrix` (or any other bad option) throws here, and
  // if the listener/observer below were already registered the throw would
  // escape with no `destroy()` to clean them up.
  resample();
  applyResolvedFg();

  if (isFillMode()) {
    attachFillObserver();
    resolveFillSizeSync();
  } else {
    sizePx = resolveSizePx(opts.size);
  }

  if (dormant) {
    canvas.style.width = '0px';
    canvas.style.height = '0px';
  } else {
    applySurface();
    buildCache();
    paintForPhase();
  }

  const io =
    typeof IntersectionObserver !== 'undefined'
      ? new IntersectionObserver((entries) => {
          visible = entries[0]?.isIntersecting ?? true;
          if (visible) schedule();
          else halt();
        })
      : null;
  io?.observe(canvas);

  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) halt();
    else schedule();
  };
  if (typeof document !== 'undefined') {
    document.addEventListener('visibilitychange', onVisibility);
  }

  // --- DPR change tracking -----------------------------------------------
  // `matchMedia('(resolution: Ndppx)')` re-armed on every change is the
  // standard trick for observing devicePixelRatio, since there is no
  // direct event for it. Armed on the *raw* ratio, never the `maxDpr`
  // clamped one — clamping first would build an already-false query that
  // never transitions.
  function onDprChange(): void {
    if (destroyed) return;
    armDpr(); // the old query is now stale; re-arm unconditionally.
    const eff = effectiveDpr(rawDpr(), opts.maxDpr);
    if (eff === lastEffectiveDpr) return; // raw moved, but the clamp absorbed it
    lastEffectiveDpr = eff;
    if (dormant) {
      // Nothing to redraw at 0x0. Force a full rebuild through the next
      // wake instead of leaving it to the one-cell threshold — a modest
      // DPR move can be smaller than one cell and would otherwise leave
      // the strip built at a stale resolution indefinitely (review finding 7).
      pendingRebuild = true;
      return;
    }
    // Captured before `buildCache()` clobbers `currentFrame` — see the
    // identical comment in `resizeTo` (review finding 2).
    const frameToShow = reduced ? opts.initialFrame : frameForPhase(phase, opts.frames);
    const frameBeforeRepaint = currentFrame;
    applySurface();
    buildCache();
    const frameChanged = frameToShow !== frameBeforeRepaint;
    blit(frameToShow);
    if (frameChanged) opts.onFrame?.(frameToShow, frameToShow / opts.frames);
  }

  function disarmDpr(): void {
    if (!mql) return;
    const current = mql;
    if (typeof current.removeEventListener === 'function') {
      current.removeEventListener('change', onDprChange);
    } else {
      const legacy = current as unknown as { removeListener?: (cb: () => void) => void };
      legacy.removeListener?.(onDprChange);
    }
    mql = null;
  }

  function armDpr(): void {
    disarmDpr();
    if (typeof window === 'undefined' || typeof window.matchMedia !== 'function') return;
    try {
      const next = window.matchMedia(`(resolution: ${rawDpr()}dppx)`);
      if (typeof next.addEventListener === 'function') {
        next.addEventListener('change', onDprChange);
      } else {
        const legacy = next as unknown as { addListener?: (cb: () => void) => void };
        legacy.addListener?.(onDprChange);
      }
      mql = next;
    } catch {
      mql = null;
    }
  }

  armDpr();
  schedule();

  return {
    setPaused(paused: boolean) {
      // Kept in sync with `opts.paused`, not just the local `isPaused`
      // flag: `update()` re-derives `isPaused` from `opts.paused` on
      // every call (a patch that doesn't itself touch `paused` must
      // leave it alone), so if this didn't update `opts` too, the next
      // unrelated `update()` (e.g. `update({ speed })`) would silently
      // revert whatever `setPaused()` last set back to the mount-time
      // value (review finding 6).
      opts.paused = paused;
      isPaused = paused;
      if (paused) halt();
      else schedule();
    },

    update(patch: Partial<DitheredOptions>) {
      // A destroyed instance is final: without this guard, `update()` in
      // fill mode would call `attachFillObserver()`, which finds the
      // `destroy()`-cleared `fillArmed` false and re-arms from scratch --
      // re-capturing `previousDisplay`, writing `display: block` back onto
      // a node the caller believes is released, and constructing a second,
      // never-disconnected `ResizeObserver` (review finding 2).
      if (destroyed) return;

      const prevShape = opts.shape;
      const prevCols = opts.cols;
      const prevRows = opts.rows;
      const prevMatrix = opts.matrix;
      const prevHitTest = opts.hitTest;
      const prevBrightness = opts.brightness;
      const prevFrames = opts.frames;
      const prevFg = opts.fg;
      const prevBg = opts.bg;
      const prevGap = opts.gap;
      const prevRadius = opts.radius;
      const prevCache = opts.cache;
      const prevMaxDpr = opts.maxDpr;
      const prevInitialFrame = opts.initialFrame;
      const wasFill = isFillMode();
      const wasDormant = dormant;
      const wasReduced = reduced;
      const patchHasSize = 'size' in patch && patch.size !== undefined;

      // Merge onto the *current* resolved options (not the static
      // DEFAULTS), and skip undefined patch values, so an explicit
      // `undefined` (e.g. a React wrapper forwarding an unset prop)
      // leaves the current value in place instead of resetting it. A
      // caller-supplied `fg` array is cloned first — same reasoning as
      // `resolveOptions`, see `clonePaletteOption` — so this instance
      // never aliases the caller's array.
      const candidate = assignDefined<ResolvedOptions>(opts, {
        ...patch,
        fg: clonePaletteOption(patch.fg),
      });

      const shapeChanged = candidate.shape !== prevShape;
      const doResample =
        shapeChanged ||
        candidate.cols !== prevCols ||
        candidate.rows !== prevRows ||
        candidate.matrix !== prevMatrix ||
        candidate.hitTest !== prevHitTest;
      const nowFill = candidate.size === 'fill';

      // Try the candidate before committing to anything: an invalid
      // `matrix` (or any other bad option) must leave this instance
      // exactly as it was — same `opts`, same canvas surface, same
      // sprite cache, same rendered frame, same animation state —
      // rather than getting bricked mid-merge. `resample()` — the only
      // step below that can throw from the candidate itself — runs
      // first and before anything else mutates the canvas or module
      // state, so every field this sequence can touch is snapshotted up
      // front, and the `try` covers the whole reconfigure-and-repaint
      // sequence — not just `resample()` — so a throw from it, or from
      // the caller's `brightness` (during `buildCache()`'s sprite-strip
      // rebuild, or during `blit()` when the cache is off), leaves
      // nothing half-migrated to the rejected configuration once the
      // snapshot is restored in the `catch`.
      const previous = opts;
      const prevStyleWidth = canvas.style.width;
      const prevStyleHeight = canvas.style.height;
      const prevCanvasWidth = canvas.width;
      const prevCanvasHeight = canvas.height;
      const prevW = W;
      const prevH = H;
      const prevCssW = cssW;
      const prevCssH = cssH;
      const prevDpr = dpr;
      const prevCells = cells;
      const prevSheet = sheet;
      const prevBuiltW = builtW;
      const prevBuiltH = builtH;
      const prevCurrentFrame = currentFrame;
      const prevReduced = reduced;
      const prevIsPaused = isPaused;
      const prevSizePx = sizePx;
      const prevDormant = dormant;
      const prevPendingRebuild = pendingRebuild;
      const prevFillArmed = fillArmed;
      const prevPreviousDisplay = previousDisplay;
      const prevObservedParent = observedParent;
      const prevWarnedNoParent = warnedNoParent;
      const prevWarnedCacheTooLarge = warnedCacheTooLarge;
      const wasScheduled = raf !== 0;

      opts = candidate;
      // Set only once `halt()` below has actually run, so the `catch` can
      // tell "resample()/applySurface()/buildCache() itself threw, the
      // loop was never touched" (no schedule() to restore) apart from
      // "blit() threw after halt() already cancelled the frame"
      // (schedule() must restore it).
      let haltedForRepaint = false;
      try {
        // Cells depend only on shape/cols/rows/hitTest/matrix (ADR 0011),
        // never on the (possibly currently absent) surface, so a resample
        // is safe and correct to run immediately regardless of dormancy —
        // deferring it would lose it permanently, since waking only re-runs
        // `applySurface()`/`buildCache()` (review finding 1, scenario A).
        if (doResample) resample();
        // The `'currentColor'` token, unlike every other option, can
        // resolve to a different value with no patch field of its own
        // changing at all (the canvas's computed color moved since the
        // last configure) — so whether the resolved palette actually
        // changed feeds into the repaint decision below the same as any
        // other cache-affecting field.
        const fgResolvedChanged = applyResolvedFg();

        const priorObservedParent = observedParent;
        if (nowFill) {
          // Idempotent — also recovers a canvas that had no parent to
          // observe yet at the last attempt.
          attachFillObserver();
        }
        // The observer's target moved -- either a genuine reparent, or the
        // very first time a parent became available to observe (previously
        // null). Either way there is no live delivery for it yet, so a
        // synchronous re-measure is the only way to get one.
        const reparented = nowFill && observedParent !== priorObservedParent;

        if (nowFill && !wasFill) {
          resolveFillSizeSync();
        } else if (!nowFill && wasFill) {
          detachFillObserver();
          sizePx = resolveSizePx(opts.size);
        } else if (nowFill && wasFill) {
          // 'fill' -> 'fill': re-measure synchronously only when it can
          // actually change the outcome -- reparented (above), the aspect
          // ratio changed, or there is no live `ResizeObserver` tracking
          // this instance at all (the documented recovery path for that
          // environment, gated on an explicit `size: 'fill'` patch so it
          // isn't triggered by every unrelated option). Otherwise the
          // observer-delivered `sizePx` -- more precise than this
          // synchronous `clientWidth`-based fit, and per the ADR "not
          // clobbered" -- is left alone. This is what lets a caller that
          // always resends `size: 'fill'` alongside every other prop
          // change (the React wrapper, which builds a full options object
          // every render) avoid clobbering a fractional RO-delivered size
          // with a coarser synchronous re-measurement on every unrelated
          // prop change (review finding 2).
          if (reparented || shapeChanged || (resizeObserver === null && patchHasSize)) {
            resolveFillSizeSync();
          }
        } else {
          sizePx = resolveSizePx(opts.size);
        }

        // `respectReducedMotion`/`prefers-reduced-motion` toggling into
        // effect has to force a repaint to `initialFrame` (the documented
        // "single static frame"), not leave whatever frame happened to be
        // showing when the loop halts. `initialFrame` itself changing is
        // also expected to still visibly repaint, matching the pre-split
        // `update()` behaviour, even though it typically doesn't change
        // *which* frame is shown against an already-running instance
        // (review finding 7).
        const nextReduced = prefersReducedMotion(opts);
        const reducedChanged = nextReduced !== wasReduced;
        const initialFrameChanged = opts.initialFrame !== prevInitialFrame;
        const forceRepaint = reducedChanged || initialFrameChanged;

        // `phase` — not `currentFrame` — is the source of truth for
        // what's displayed (see the field comment; `renderFrame()`/
        // `setTime()` both keep it in sync), so it naturally survives a
        // `frames` change through `frameForPhase` with the new count.
        // Captured before `buildCache()` clobbers `currentFrame` — see
        // the identical comment in `resizeTo` (review finding 2). While
        // reduced motion is (now) in effect, the frame shown is always
        // `initialFrame` — the documented single static frame.
        const frameToShow = nextReduced ? opts.initialFrame : frameForPhase(phase, opts.frames);
        // Also captured here, before `buildCache()` resets `currentFrame`
        // to -1: comparing `frameToShow` against the *live* `currentFrame`
        // after that reset would report every cache-affecting repaint as a
        // "new" frame to `onFrame`, even one that redraws the same index.
        const frameBeforeRepaint = currentFrame;

        // Run only the stages this patch actually touches (ADR 0011's
        // three-stage table), rather than unconditionally reapplying the
        // surface and rebuilding the sprite strip on every `update()` call
        // — which rebuilt the whole sprite strip for e.g.
        // `update({ paused: true })`, or every React prop change on a
        // cached instance (review finding 3).
        let repainted = false;
        if (dormant) {
          // Everything but the resample above needs a surface (brightness,
          // colors, frames, gap, radius -> the sprite cache): defer it,
          // forcing a full rebuild through on the next wake regardless of
          // the one-cell threshold (review finding 1, scenario B).
          pendingRebuild = true;
        } else {
          // The fill-state resolution above may have just woken the
          // instance out of dormancy (`detachFillObserver()` on 'fill' ->
          // number, or `resolveFillSizeSync()` on a reparent/shape change
          // while dormant). Neither of those is itself "the surface
          // changed" by the checks below when the size it wakes to
          // happens to equal the retained `sizePx` -- and dormancy always
          // leaves the canvas at CSS `0px`, so without this the canvas
          // would restart its animation loop at a correct backing-store
          // size but permanently zero CSS size (review finding 1).
          const wokeFromDormant = wasDormant && !dormant;
          // In an environment with no `matchMedia` (or one that throws),
          // `mql` never gets armed and there is no listener to catch a
          // DPR change — the ADR's documented "degrades to no DPR
          // tracking" fallback. Recover just that path here, gated on
          // `mql === null` so it's a no-op cost everywhere DPR tracking
          // is actually live (review finding 6).
          const dprMayHaveChanged =
            mql === null && effectiveDpr(rawDpr(), opts.maxDpr) !== lastEffectiveDpr;
          const surfaceChanged =
            shapeChanged ||
            opts.maxDpr !== prevMaxDpr ||
            sizePx !== prevSizePx ||
            wokeFromDormant ||
            dprMayHaveChanged;
          const cacheAffectingChanged =
            doResample ||
            surfaceChanged ||
            fgResolvedChanged ||
            opts.brightness !== prevBrightness ||
            opts.frames !== prevFrames ||
            opts.fg !== prevFg ||
            opts.bg !== prevBg ||
            opts.gap !== prevGap ||
            opts.radius !== prevRadius ||
            opts.cache !== prevCache;
          if (surfaceChanged) applySurface();
          if (cacheAffectingChanged) buildCache();
          repainted = surfaceChanged || cacheAffectingChanged || forceRepaint;
        }

        reduced = nextReduced;
        isPaused = opts.paused;

        // `halt()` only runs when there's actually a reason to — a
        // dormant/repaint transition that needs the canvas/loop settled
        // before touching it, or (below) a newly-blocking flag that must
        // cancel an in-flight `raf`. Calling it unconditionally on every
        // `update()` would reset `lastNow` to `null` on every call,
        // corrupting the next tick's `dt` for a patch that never touched
        // playback at all (e.g. `update({ speed })` — the very next tick
        // must still measure real elapsed time, not treat the clock as
        // freshly (re)started).
        if (dormant) {
          halt();
          haltedForRepaint = true;
          canvas.style.width = '0px';
          canvas.style.height = '0px';
        } else if (repainted) {
          halt();
          haltedForRepaint = true;
          // Always redraw when `repainted` — even a forced repaint whose
          // frame index happens to match what's already on screen (e.g.
          // `initialFrame` changing without `respectReducedMotion` active,
          // review finding 7) — but only report a new frame to `onFrame`
          // when the index actually moved, matching `paintForPhase`'s
          // "never redraw or report the same frame twice" contract.
          const frameChanged = frameToShow !== frameBeforeRepaint;
          blit(frameToShow);
          if (frameChanged) opts.onFrame?.(frameToShow, frameToShow / opts.frames);
        }

        // Cancels a RAF already in flight, not just future scheduling:
        // `schedule()` on its own only guards against scheduling a *new*
        // one, so an `update()` that newly forbids playback via `reduced`
        // (e.g. `respectReducedMotion` flipped back on while the media
        // query already matches) would otherwise leave the pending tick
        // to run once more before the next `schedule()` call finally bails.
        if (isPaused || driven || reduced || dormant) halt();
        else schedule();
      } catch (err) {
        opts = previous;
        if (canvas.style.width !== prevStyleWidth) canvas.style.width = prevStyleWidth;
        if (canvas.style.height !== prevStyleHeight) canvas.style.height = prevStyleHeight;
        if (canvas.width !== prevCanvasWidth) canvas.width = prevCanvasWidth;
        if (canvas.height !== prevCanvasHeight) canvas.height = prevCanvasHeight;
        W = prevW;
        H = prevH;
        cssW = prevCssW;
        cssH = prevCssH;
        dpr = prevDpr;
        cells = prevCells;
        sheet = prevSheet;
        builtW = prevBuiltW;
        builtH = prevBuiltH;
        currentFrame = prevCurrentFrame;
        reduced = prevReduced;
        isPaused = prevIsPaused;
        sizePx = prevSizePx;
        dormant = prevDormant;
        pendingRebuild = prevPendingRebuild;
        fillArmed = prevFillArmed;
        previousDisplay = prevPreviousDisplay;
        observedParent = prevObservedParent;
        warnedNoParent = prevWarnedNoParent;
        warnedCacheTooLarge = prevWarnedCacheTooLarge;
        if (haltedForRepaint && wasScheduled) schedule();
        throw err;
      }
    },

    renderFrame(frame: number) {
      // Kept in sync with `phase`, not just `currentFrame`: a later
      // resize, DPR change, or `update()` reconfigure all compute "what's
      // currently displayed" via `frameForPhase(phase, opts.frames)`
      // (see the `phase` field comment) — without this, a direct
      // `renderFrame()` call (e.g. a determinate `progress` render) would
      // repaint correctly now but snap back to a stale phase on the next
      // unrelated reconfigure. Does not fire `onFrame`/set `driven`,
      // matching "bypasses the animation loop" — this is a one-off
      // override, not a hand-off away from the internal clock.
      phase = opts.frames > 0 ? wrapFrame(frame, opts.frames) / opts.frames : 0;
      blit(frame);
    },

    refreshColors() {
      if (!applyResolvedFg()) return;
      buildCache();
      blit(frameForPhase(phase, opts.frames));
    },

    setTime(t: number) {
      // A non-finite `t` is ignored outright (ADR 0006 §3), not clamped
      // to frame 0 — `frameForPhase`'s totality is a backstop for
      // anything that slips past every driver, not license for a driver
      // to snap to frame 0 on its own. Left completely untouched: the
      // displayed frame holds, `onFrame` does not fire, and the
      // instance is exactly as driveable by a subsequent finite
      // `setTime` as it was before this call. This is the PRD's
      // flagship case: `time={scrollY / contentHeight}` is `NaN` on the
      // first render, before layout.
      if (!Number.isFinite(t)) return;
      driven = true;
      halt();
      phase = t;
      paintForPhase();
    },

    clearTime() {
      if (!driven) return;
      driven = false;
      lastNow = null;
      if (!isPaused) schedule();
    },

    destroy() {
      destroyed = true;
      halt();
      io?.disconnect();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      // Routed through `detachFillObserver()` (rather than disconnecting
      // `resizeObserver` directly) so `display` is restored to whatever it
      // was before fill mode set it to `block`, and `fillArmed`/
      // `previousDisplay` are cleared — otherwise a create -> destroy ->
      // create cycle on the same `<canvas>` node (React StrictMode's
      // double-invoked mount effect, or any remount) captures the *already
      // corrupted* `display: block` as the "previous" value on the next
      // create, permanently losing the real original (review finding 1).
      // Restore the last resolved CSS size before tearing down fill state:
      // dormancy writes `0px x 0px` and retains it until the next wake, so
      // a `destroy()` that happens to land while dormant would otherwise
      // leave the canvas permanently zero-sized for a caller who keeps the
      // node around after destroying the instance (review finding 11).
      // Checked before `detachFillObserver()`, which itself resets
      // `dormant` as part of leaving fill mode.
      if (dormant) {
        const css = surfaceSize(sizePx, opts.shape);
        canvas.style.width = css.width + 'px';
        canvas.style.height = css.height + 'px';
      }
      // Idempotent: a second `destroy()` finds `fillArmed` already false.
      if (fillArmed) {
        detachFillObserver();
      }
      disarmDpr();
    },
  };
}
