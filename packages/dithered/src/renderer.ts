import {
  DEFAULTS,
  assignDefined,
  clonePaletteOption,
  computeGeometry,
  effectiveDpr,
  fitSize,
  frameAt,
  hasCurrentColor,
  paintFrame,
  resolveOptions,
  resolvePalette,
  resolveRows,
  resolveSizePx,
  surfaceSize,
  toPalette,
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
  /** Stops the loop and releases all listeners/observers. */
  destroy(): void;
}

/** Wraps a frame index into `[0, count)`, matching `wrapFrame`'s semantics in `core/static.ts`. */
function wrapFrame(frame: number, count: number): number {
  return ((Math.round(frame) % count) + count) % count;
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

  // --- DPR tracking ------------------------------------------------------
  let mql: MediaQueryList | null = null;
  let lastEffectiveDpr = 1;

  let raf = 0;
  let currentFrame = -1;
  let isPaused = opts.paused;
  let visible = true;
  let destroyed = false;

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

  /** Extracts a `{width, height}` box from a `ResizeObserverEntry`. */
  function boxFromEntry(entry: ResizeObserverEntry): MeasuredBox {
    const boxes = entry.contentBoxSize;
    if (boxes) {
      const box = Array.isArray(boxes) ? boxes[0] : boxes;
      if (box) return { width: box.inlineSize, height: box.blockSize };
    }
    const rect = entry.contentRect;
    return { width: rect.width, height: rect.height };
  }

  /**
   * Idempotent: creates the observer once ('fill' -> 'fill' keeps the same
   * instance) and (re-)observes the current parent every time it's called,
   * so a canvas that had no parent yet at the last attempt recovers the
   * moment `update()` runs again after it's mounted.
   */
  function attachFillObserver(): void {
    if (!fillArmed) {
      fillArmed = true;
      previousDisplay = canvas.style.display;
      canvas.style.display = 'block';
      if (typeof ResizeObserver !== 'undefined') {
        resizeObserver = new ResizeObserver((entries) => {
          if (destroyed || !isFillMode()) return;
          const entry = entries[entries.length - 1];
          if (!entry) return;
          applyMeasurement(boxFromEntry(entry));
        });
      }
      // else: documented — no ResizeObserver means one sync measurement
      // that stays put until the next update().
    }
    const parent = canvas.parentElement;
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
    // Captured *before* `buildCache()` runs: it always resets `currentFrame`
    // to -1, which would otherwise make this ternary dead and silently
    // snap a paused/determinate instance back to `initialFrame` on every
    // resize that crosses a cell boundary (see review finding 2).
    const frameToShow = currentFrame >= 0 ? currentFrame % opts.frames : opts.initialFrame;
    applySurface();
    const cellThreshold = builtW > 0 ? builtW / opts.cols : 0;
    // `pendingRebuild` forces this even under the threshold: a resample or
    // an option change (e.g. `fg`) picked up while dormant has no surface
    // to apply to yet, and waking at the *same* device size would otherwise
    // never rebuild the now-stale cache (see review finding 1, scenario B).
    if (pendingRebuild || builtW === 0 || Math.abs(W - builtW) >= cellThreshold) {
      buildCache();
    }
    blit(frameToShow);
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
    const useCache = opts.cache === 'auto' ? sizePx <= 120 : opts.cache;
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

  function schedule(): void {
    if (destroyed || isPaused || !visible || reduced || dormant) return;
    if (typeof document !== 'undefined' && document.hidden) return;
    if (raf) return;
    raf = requestAnimationFrame(tick);
  }

  function halt(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
  }

  function tick(now: number): void {
    raf = 0;
    const f = frameAt(now, opts.period, opts.frames);
    if (f !== currentFrame) blit(f);
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
    blit(opts.initialFrame);
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
    const frameToShow = currentFrame >= 0 ? currentFrame % opts.frames : opts.initialFrame;
    applySurface();
    buildCache();
    blit(frameToShow);
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
      isPaused = paused;
      if (paused) halt();
      else schedule();
    },

    update(patch: Partial<DitheredOptions>) {
      const prevShape = opts.shape;
      const prevCols = opts.cols;
      const prevRows = opts.rows;
      const prevMatrix = opts.matrix;
      const prevHitTest = opts.hitTest;
      const wasFill = isFillMode();
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
        applyResolvedFg();

        if (nowFill) {
          // Idempotent — also recovers a canvas that had no parent to
          // observe yet at the last attempt.
          attachFillObserver();
        }

        if (nowFill && !wasFill) {
          resolveFillSizeSync();
        } else if (!nowFill && wasFill) {
          detachFillObserver();
          sizePx = resolveSizePx(opts.size);
        } else if (nowFill && wasFill) {
          // 'fill' -> 'fill': re-measure only when asked to (an explicit
          // `size: 'fill'` patch) or when the aspect ratio changed; any
          // other option change leaves the derived `sizePx` untouched.
          if (patchHasSize || shapeChanged) {
            resolveFillSizeSync();
          }
        } else {
          sizePx = resolveSizePx(opts.size);
        }

        // Captured before `buildCache()` clobbers `currentFrame` — see the
        // identical comment in `resizeTo` (review finding 2).
        const frameToShow = currentFrame >= 0 ? currentFrame % opts.frames : opts.initialFrame;

        if (dormant) {
          // Everything but the resample above needs a surface (brightness,
          // colors, frames, gap, radius -> the sprite cache): defer it,
          // forcing a full rebuild through on the next wake regardless of
          // the one-cell threshold (review finding 1, scenario B).
          pendingRebuild = true;
        } else {
          applySurface();
          buildCache();
        }

        reduced = prefersReducedMotion(opts);
        isPaused = opts.paused;
        halt();
        haltedForRepaint = true;

        if (dormant) {
          canvas.style.width = '0px';
          canvas.style.height = '0px';
        } else {
          blit(frameToShow);
        }
        schedule();
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
        if (haltedForRepaint && wasScheduled) schedule();
        throw err;
      }
    },

    renderFrame(frame: number) {
      blit(frame);
    },

    refreshColors() {
      if (!applyResolvedFg()) return;
      buildCache();
      blit(currentFrame >= 0 ? currentFrame : opts.initialFrame);
    },

    destroy() {
      destroyed = true;
      halt();
      io?.disconnect();
      if (typeof document !== 'undefined') {
        document.removeEventListener('visibilitychange', onVisibility);
      }
      if (resizeObserver) {
        resizeObserver.disconnect();
        resizeObserver = null;
      }
      disarmDpr();
    },
  };
}
