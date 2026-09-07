import {
  DEFAULTS,
  advancePhase,
  assignDefined,
  clonePaletteOption,
  computeGeometry,
  createTransition,
  effectiveDpr,
  fitSize,
  frameAt,
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
  type Transition,
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
  /**
   * Like `update()`, but morphs into the new shape/brightness over
   * `transition.duration` (see ADR 0004) instead of cutting to it. The
   * target options are computed exactly as `update(patch)` would.
   *
   * Resolves once the target is the new steady state. Never rejects: a
   * transition that is interrupted (by `destroy()`, a pause, the tab
   * going hidden, the canvas leaving the viewport, or another
   * `transitionTo` call) completes immediately instead of hanging, and
   * `prefers-reduced-motion` skips the morph and cuts straight to the
   * target.
   */
  transitionTo(patch: Partial<DitheredOptions>): Promise<void>;
  /**
   * Resolves the next time playback wraps back to loop phase 0. Also
   * resolves — early — if the loop stops advancing before that happens
   * (paused, tab hidden, canvas off-screen, reduced motion, or
   * `destroy()`) or if it is already stopped when called: a promise that
   * settles early is preferable to one that hangs forever. Resolution
   * means "the loop is not mid-cycle any more", not "a full cycle played".
   */
  finishLoop(): Promise<void>;
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

/** `performance.now()` where available, falling back to `Date.now()`. */
function now(): number {
  if (typeof performance !== 'undefined' && typeof performance.now === 'function') {
    return performance.now();
  }
  return Date.now();
}

/** A morph in progress: the pure "what to draw" core plus what it's morphing into. */
interface ActiveTransition {
  core: Transition;
  targetOpts: ResolvedOptions;
  /**
   * The patch that started this morph (or, if it superseded a queued
   * `onLoopEnd` transition, that one's patch). Kept around — rather than
   * just `targetOpts` — so completion can tell whether the caller actually
   * meant to touch `paused`: see `applyPausedPatch`.
   */
  patch: Partial<DitheredOptions>;
  /** `transitionTo`'s resolver(s) — one per call, drained on completion. */
  resolvers: Array<() => void>;
}

/**
 * A `transitionTo()` call deferred by `transition.onLoopEnd`, waiting for
 * the loop to wrap before it becomes an {@link ActiveTransition}.
 *
 * Deliberately stores the *patch* the caller passed, not a precomputed
 * `ResolvedOptions` snapshot: the loop may take a long time to wrap, and in
 * the meantime another `update()`/`transitionTo()` call may have changed
 * options this patch doesn't touch. Recomputing the target from the patch
 * against whatever `opts` happens to be *when the wait ends* — rather than
 * replaying a stale full snapshot over it — is what keeps those
 * intervening changes from being silently undone (see finding 2 in the
 * review this fixes, and ADR 0004 §1: `transitionTo` "computes the target
 * options exactly as `update(patch)` would").
 */
interface PendingTransition {
  patch: Partial<DitheredOptions>;
  /** This call's `transitionTo` resolver. */
  resolve: () => void;
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
 *
 * `transitionTo`/`finishLoop` (ADR 0004) layer a time-boxed morph on top
 * of that same loop rather than replacing it: a transition frame is
 * painted directly every tick (never through the sprite cache — see
 * `paintTransitionFrame`), and completion runs through the same
 * resample/applySurface/buildCache reconfigure the plain `update()` path
 * uses, so there is no separate post-transition state to keep consistent.
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
  // The wall-clock timestamp `checkWrap` last compared against, tracked
  // independently of `currentFrame` — see `checkWrap` for why the two
  // cannot be the same variable.
  let lastWrapCheckMs: number | null = null;
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

  // A morph in progress (ADR 0004), and the `finishLoop()`/`onLoopEnd`
  // waiters pending a loop wrap.

  /**
   * Applies `patch.paused` to the imperative `isPaused` flag, but only
   * when `patch` actually specifies it.
   *
   * `paused` is a declarative option carried on `opts`, while `isPaused`
   * is the imperative flag `setPaused()` writes directly — the two are
   * related but not interchangeable. Because `assignDefined` always
   * carries the previous value of an omitted field forward, a resolved
   * `ResolvedOptions.paused` can never tell you whether *this* call meant
   * to touch pause state or is just echoing whatever was already there.
   * Reading it unconditionally (as `cutToTarget`/`finishTransitionNow`
   * used to) meant every transition landing or being cut short replayed
   * that stale echo over whatever `setPaused()` had last set — silently
   * resuming a `setPaused(true)` instance when a morph completed, or
   * silently freezing a running one when a morph completed with a stale
   * `paused: true` still sitting in the options it started from. Reading
   * `patch.paused` instead — `undefined` unless the caller wrote it
   * *this* time — makes "did this call mean to change pause state" the
   * only thing that can move `isPaused`.
   */
  function applyPausedPatch(patch: Partial<DitheredOptions> | undefined): void {
    if (patch?.paused !== undefined) isPaused = patch.paused;
  }

  let transition: ActiveTransition | null = null;
  let loopEndResolvers: Array<() => void> = [];
  // A `transitionTo({ transition: { onLoopEnd: true } })` call waiting for
  // the loop to wrap — see `PendingTransition`. At most one at a time:
  // starting a real transition, settling this one, or a plain `update()`
  // all clear it first (ADR 0004 §7 — blends, and the queue in front of
  // them, are never nested).
  let pendingTransition: PendingTransition | null = null;

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
    // A reconfigure (new shape/size, or a steady state just adopted from
    // a completed transition) starts a fresh loop from the wrap
    // detector's point of view too, for the same reason `currentFrame`
    // resets: whatever `period` boundaries existed under the old
    // configuration say nothing about the new one.
    lastWrapCheckMs = null;
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

  /**
   * Paints one frame of a morph directly — never through `sheet`, per ADR
   * 0004 §5: a transition is played once, so caching it would cost a
   * synchronous build to save a single repaint each. `currentFrame` is
   * left at -1 (not a valid steady-state frame index) so the first
   * post-transition `blit()` never mistakes a stale index for a match.
   */
  function paintTransitionFrame(t: ActiveTransition, p: number, nowMs: number): void {
    ctx.setTransform(W / cssW, 0, 0, H / cssH, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);
    paintFrame(
      ctx,
      t.core.cellsAt(p),
      t.core.brightnessAt(p, nowMs),
      0, // phase unused: brightnessAt's function already carries both sides' phases
      computeGeometry(t.targetOpts, cssW, cssH),
    );
    currentFrame = -1;
  }

  function drainLoopEnd(): void {
    const resolvers = loopEndResolvers;
    loopEndResolvers = [];
    for (const resolve of resolvers) resolve();
  }

  /**
   * Recomputes a `transitionTo` patch's target against the *current* live
   * `opts` — the merge `update(patch)` would do. Always reading `opts`
   * fresh (rather than a value captured earlier) is what lets a deferred
   * `onLoopEnd` transition, when it finally starts or is settled, land on
   * top of whatever happened while it was waiting instead of reverting it
   * (finding 2).
   */
  function computeTargetOpts(patch: Partial<DitheredOptions>): ResolvedOptions {
    const previousTransition = opts.transition;
    const target = assignDefined<ResolvedOptions>(
      opts,
      patch as Partial<ResolvedOptions>,
    ) as ResolvedOptions;
    target.transition = mergeTransitionOption(previousTransition, patch);
    return target;
  }

  /**
   * Cuts straight to `targetOpts`: adopts it as the steady state, resamples
   * and rebuilds the cache, and repaints — holding the loop's current phase
   * rather than resetting it to `initialFrame`. Used for reduced motion, a
   * halted loop, and settling a pending or active transition that's being
   * cut short.
   *
   * `sourcePatch` is whatever caller-supplied patch produced `targetOpts`
   * (`undefined` when there wasn't one, e.g. cutting to reduced motion) —
   * threaded through to `applyPausedPatch` so a `transitionTo()` that
   * never mentioned `paused` cannot silently resume (or freeze) playback
   * by echoing `targetOpts.paused` over an imperative `setPaused()` call.
   * `schedule()` below is a no-op while `isPaused` stays true, which is
   * exactly what keeps a halted instance halted here.
   */
  function cutToTarget(
    targetOpts: ResolvedOptions,
    targetReduced: boolean,
    sourcePatch: Partial<DitheredOptions> | undefined,
  ): void {
    opts = targetOpts;
    reduced = targetReduced;
    applyPausedPatch(sourcePatch);
    // The phase clock resumes fresh, same reasoning as `finishTransitionNow`
    // — see its comment on `lastNow`.
    lastNow = null;
    halt();
    resample();
    applyResolvedFg();
    applySurface();
    buildCache();
    paintForPhase();
    schedule();
  }

  /**
   * Settles a queued `onLoopEnd` transition immediately, without ever
   * playing its morph: recomputes its target against the live `opts` (see
   * `computeTargetOpts`) and cuts straight to it. Used both when a newer
   * `update()`/`transitionTo()` call supersedes it (ADR 0004 §7 — a
   * queued-but-not-yet-started morph is "in flight" for that rule too) and
   * when playback halts before it ever gets to fire (finding 1: without
   * this, the deferred `.then(begin)` continuation calls `startTransition`
   * on a loop that isn't advancing, whose `schedule()` is then a no-op —
   * the instance is stranded on the *old* options and the promise never
   * settles).
   */
  function settlePendingNow(): void {
    if (!pendingTransition) return;
    const { patch, resolve } = pendingTransition;
    pendingTransition = null;
    const target = computeTargetOpts(patch);
    cutToTarget(target, prefersReducedMotion(target), patch);
    resolve();
  }

  /**
   * Same as `settlePendingNow`, but for `destroy()`: adopts the target
   * options without painting — the canvas is going away — mirroring
   * `finishTransitionSilently`.
   */
  function settlePendingSilently(): void {
    if (!pendingTransition) return;
    const { patch, resolve } = pendingTransition;
    pendingTransition = null;
    opts = computeTargetOpts(patch);
    resolve();
  }

  /**
   * Releases a queued `onLoopEnd` transition when the loop actually wraps:
   * starts its real morph. Recomputes the target from the live `opts` at
   * this instant (finding 2) and re-checks reduced motion/`loopAdvancing`
   * (rather than trusting the state from whenever `transitionTo` was
   * originally called) in case either changed while it was waiting.
   */
  function releasePendingTransition(): void {
    if (!pendingTransition) return;
    const { patch, resolve } = pendingTransition;
    pendingTransition = null;
    const target = computeTargetOpts(patch);
    const targetReduced = prefersReducedMotion(target);
    if (targetReduced || !loopAdvancing()) {
      cutToTarget(target, targetReduced, patch);
      resolve();
    } else {
      startTransition(target, resolve, patch);
    }
  }

  /**
   * The loop wrapping back to phase 0: drains plain `finishLoop()`
   * resolvers and releases any transition queued behind `onLoopEnd`.
   */
  function onLoopWrap(): void {
    drainLoopEnd();
    releasePendingTransition();
  }

  /**
   * Ends the in-progress morph (if any) exactly like a plain `update()`
   * would: adopts the target as the new steady state, resamples, rebuilds
   * the sprite cache, repaints, and resolves the transition's promise(s).
   * Used both for a morph completing naturally (`p >= 1`) and for cutting
   * one short (reduced motion, a halt, a superseding `transitionTo`) — ADR
   * 0004 §1/§7: completion is a single code path either way.
   *
   * `applyPausedPatch(t.patch)` — not `isPaused = opts.paused` — is what
   * keeps this from re-applying a stale `paused` the moment a morph that
   * never mentioned it lands: `t.patch` is the exact patch that started
   * (or superseded into) this morph, so `isPaused` only moves when that
   * patch actually asked it to.
   */
  function finishTransitionNow(): void {
    if (!transition) return;
    const t = transition;
    transition = null;
    opts = t.targetOpts;
    reduced = prefersReducedMotion(opts);
    applyPausedPatch(t.patch);
    // The phase clock was frozen for the morph's duration (see `tick`),
    // not advanced against wall-clock time like the old frame-index
    // model — resuming with a fresh `dt` of 0 on the next tick avoids a
    // discontinuous jump forward by however long the morph took, rather
    // than trying to reconstruct where a continuously-running clock
    // would have ended up.
    lastNow = null;
    resample();
    applyResolvedFg();
    applySurface();
    buildCache();
    paintForPhase();
    for (const resolve of t.resolvers) resolve();
  }

  /**
   * Same as `finishTransitionNow`, but never paints — `destroy()`'s
   * canvas is going away, so there is nothing to resample or draw onto
   * (ADR 0004 §7). The promise still resolves; it never rejects.
   */
  function finishTransitionSilently(): void {
    if (!transition) return;
    const t = transition;
    transition = null;
    opts = t.targetOpts;
    for (const resolve of t.resolvers) resolve();
  }

  function loopAdvancing(): boolean {
    if (destroyed || isPaused || reduced || !visible || dormant || driven) return false;
    if (typeof document !== 'undefined' && document.hidden) return false;
    return true;
  }

  function schedule(): void {
    if (!loopAdvancing()) return;
    if (raf) return;
    raf = requestAnimationFrame(tick);
  }

  function halt(): void {
    if (raf) cancelAnimationFrame(raf);
    raf = 0;
    lastNow = null;
  }

  /**
   * Stops playback from advancing (setPaused(true), tab hidden, canvas
   * off-screen): finishes any in-progress morph immediately so no
   * half-morphed frame is left sitting in the backing store for whenever
   * playback resumes, cancels the loop, then drains `finishLoop()` —
   * ADR 0004 §6/§7.
   */
  function haltPlayback(): void {
    finishTransitionNow();
    settlePendingNow();
    halt();
    drainLoopEnd();
  }

  /**
   * Resolves the next time playback wraps to phase 0 — or immediately if
   * the loop isn't currently advancing at all, so a caller can never
   * `await` a promise that was already doomed to hang. Shared by the
   * public `finishLoop()` and by `transition.onLoopEnd` inside
   * `transitionTo`, so neither has to go through `this`.
   */
  function finishLoopPromise(): Promise<void> {
    if (!loopAdvancing()) return Promise.resolve();
    return new Promise<void>((resolve) => {
      loopEndResolvers.push(resolve);
    });
  }

  /**
   * Detects a `period` boundary crossed since the previous tick, purely
   * from the wall clock — never from `currentFrame`.
   *
   * `currentFrame` is a *painted frame index*: `update()` holds it across
   * a phase it doesn't reset, `cutToTarget()`/`finishTransitionNow()`
   * carry it over from before a morph, and `renderFrame()` sets it to
   * whatever the caller asked for. None of those writes mean "a loop
   * wrapped", so comparing them (`f < currentFrame`, the previous
   * approach) both fires on decreases that were never a wrap — e.g.
   * `update({ period: 500 })` shortening the period mid-frame — and, per
   * finding 4, never fires at all during a morph, because the morph's
   * paint path doesn't touch `currentFrame`.
   *
   * Comparing `Math.floor(nowMs / period)` between ticks sidesteps both:
   * it only asks "did wall-clock time cross a `period`-multiple boundary
   * since the last time this ran", independent of whatever got painted
   * (or didn't) in between, and it runs on every tick — including ticks
   * inside a morph, whose frame branch below never executes.
   */
  function checkWrap(nowMs: number): boolean {
    const previous = lastWrapCheckMs;
    lastWrapCheckMs = nowMs;
    if (previous === null) return false; // first tick after create()/configure(): nothing to compare against
    return Math.floor(nowMs / opts.period) > Math.floor(previous / opts.period);
  }

  function tick(nowMs: number): void {
    raf = 0;
    // Defensive: a stale callback slipping through after destroy() (this
    // is what cancelAnimationFrame guards against in a real browser)
    // must not paint onto — or resample against — a canvas that's gone.
    if (destroyed) return;

    // Checked unconditionally — before the branch below — so a wrap that
    // falls inside a morph's `duration` window is still seen (finding 4).
    const wrapped = checkWrap(nowMs);

    if (transition) {
      const p = transition.core.progressAt(nowMs);
      paintTransitionFrame(transition, p, nowMs);
      if (wrapped) onLoopWrap();
      // Every tick repaints during a morph (p is continuous — the
      // repeated-frame-index shortcut below doesn't apply), so this can
      // only run *after* that paint, exactly like a plain update()'s.
      if (p >= 1) finishTransitionNow();
    } else {
      // The phase clock is frozen for a morph's duration (see
      // `finishTransitionNow`) rather than advanced underneath it, so
      // `dt` is only ever computed here, on the steady-state branch. Wrap
      // detection here stays phase-based (`loopsAt`), not the wall-clock
      // `wrapped` computed above: `loopsAt` already accounts for `speed`,
      // while `checkWrap`'s raw `floor(nowMs / period)` does not — it
      // exists only to catch a wrap that falls *inside* a morph's window,
      // where there is no live phase to derive it from (finding 4/5).
      const dt = lastNow === null ? 0 : nowMs - lastNow;
      lastNow = nowMs;

      const loopsBefore = loopsAt(phase);
      phase = advancePhase(phase, dt, opts.period, opts.speed);
      const loopsAfter = loopsAt(phase);
      if (loopsAfter !== loopsBefore) {
        opts.onLoop?.(loopsAfter);
        onLoopWrap();
      }

      paintForPhase();
    }
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
          else haltPlayback();
        })
      : null;
  io?.observe(canvas);

  const onVisibility = () => {
    if (typeof document === 'undefined') return;
    if (document.hidden) haltPlayback();
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

  /** Merges `patch` onto `base`'s *resolved* transition, filling gaps from it rather than TRANSITION_DEFAULTS. */
  function mergeTransitionOption(
    base: ResolvedOptions['transition'],
    patch: Partial<DitheredOptions>,
  ): ResolvedOptions['transition'] {
    return assignDefined(base, patch.transition ?? {});
  }

  /**
   * Starts a new morph toward `targetOpts`, resolving `resolve` when it
   * completes (naturally, or because something cut it short). Any morph
   * already running is finished instantly first — ADR 0004 §7: blends
   * are never nested.
   *
   * `patch` is the caller-supplied patch that produced `targetOpts` —
   * stored on the resulting `ActiveTransition` (see its doc comment) so
   * completion can tell whether `paused` was actually part of this call.
   */
  function startTransition(
    targetOpts: ResolvedOptions,
    resolve: () => void,
    patch: Partial<DitheredOptions>,
  ): void {
    if (destroyed) {
      resolve();
      return;
    }

    const nowMs = now();
    finishTransitionNow();

    const fromOpts = opts;
    // Both shapes are sampled onto the *target's* grid — ADR 0004 §2 — so
    // a diff by (i, j) is meaningful even when the shapes' own aspect
    // ratios differ.
    const rows = resolveRows(targetOpts);
    const fromCells = sampleCells(
      fromOpts.shape,
      targetOpts.cols,
      fromOpts.hitTest,
      rows,
      fromOpts.matrix,
    );
    const toCells = sampleCells(
      targetOpts.shape,
      targetOpts.cols,
      targetOpts.hitTest,
      rows,
      targetOpts.matrix,
    );

    const core = createTransition(
      {
        cells: fromCells,
        brightness: fromOpts.brightness,
        period: fromOpts.period,
        frames: fromOpts.frames,
      },
      {
        cells: toCells,
        brightness: targetOpts.brightness,
        period: targetOpts.period,
        frames: targetOpts.frames,
      },
      nowMs,
      targetOpts.transition.duration,
    );

    // Resize onto the target surface and drop the sprite strip *before*
    // the first paint below, so the resize never shows through as a
    // blank frame — ADR 0004 §5. Written out rather than reusing
    // `applySurface()`: that function reads `opts`/`sizePx` from the
    // closure, and `opts` doesn't switch to `targetOpts` until the morph
    // actually completes (`finishTransitionNow`) — see the field comment
    // on `transition`. `sizePx`/`cssW`/`cssH`/`dpr` are still written
    // through to the shared state (not kept purely local) so that later
    // `applySurface()` call recomputes idempotently from the same values.
    if (targetOpts.size !== 'fill') {
      sizePx = resolveSizePx(targetOpts.size);
    }
    const targetDpr = effectiveDpr(rawDpr(), targetOpts.maxDpr);
    lastEffectiveDpr = targetDpr;
    const css = surfaceSize(sizePx, targetOpts.shape);
    canvas.style.width = css.width + 'px';
    canvas.style.height = css.height + 'px';
    const device = surfaceSize(sizePx, targetOpts.shape, targetDpr);
    W = canvas.width = Math.round(device.width);
    H = canvas.height = Math.round(device.height);
    cssW = css.width;
    cssH = css.height;
    dpr = targetDpr;
    sheet = null;

    transition = { core, targetOpts, patch, resolvers: [resolve] };

    halt();
    paintTransitionFrame(transition, core.progressAt(nowMs), nowMs);
    schedule();
  }

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
      if (paused) haltPlayback();
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

      // Whatever's already in flight is a hard-cut override: settle a
      // transition merely *queued* behind `onLoopEnd` (finding 2 — an
      // `update()` must not be silently undone by a deferred morph that
      // fires a loop later) and finish one actually *running*, so this
      // update() layers onto a consistent steady state either way, rather
      // than onto a half-morphed or stale one.
      settlePendingNow();
      finishTransitionNow();

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
      } as Partial<ResolvedOptions>);
      // `assignDefined` above treats `transition` like any other key: a
      // provided object would replace the current one wholesale, dropping
      // an unset `onLoopEnd`/`duration` rather than filling it from the
      // existing value (mirrors `resolveOptions`'s identical fix-up).
      candidate.transition = mergeTransitionOption(opts.transition, patch);

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
        applyPausedPatch(patch);

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

    transitionTo(patch: Partial<DitheredOptions>): Promise<void> {
      if (destroyed) return Promise.resolve();

      // Same "settle whatever's in flight first" rule as `update()` above,
      // and for the same reason (ADR 0004 §7: blends are never nested,
      // and neither is the queue in front of them) — this also means
      // `computeTargetOpts` below merges `patch` onto an `opts` that
      // already reflects anything the settled call had committed to.
      settlePendingNow();
      finishTransitionNow();

      const targetOpts = computeTargetOpts(patch);
      const targetReduced = prefersReducedMotion(targetOpts);

      // Reduced motion (ADR 0004 §7), or a loop that isn't advancing
      // anyway (paused/hidden/off-screen/destroyed): there is no loop to
      // morph in front of, so cut straight to the target through the same
      // path `update()` uses, and resolve immediately. `onLoopEnd` is
      // ignored here too — "wait for the loop to end" is meaningless when
      // there's no loop running.
      if (targetReduced || !loopAdvancing()) {
        cutToTarget(targetOpts, targetReduced, patch);
        return Promise.resolve();
      }

      if (targetOpts.transition.onLoopEnd) {
        // Queue it — released by `onLoopWrap` on the next wrap, or settled
        // immediately by a halt or a superseding call (finding 1). Note
        // this stores `patch`, not `targetOpts`: see `PendingTransition`.
        return new Promise<void>((resolve) => {
          pendingTransition = { patch, resolve };
        });
      }

      return new Promise<void>((resolve) => startTransition(targetOpts, resolve, patch));
    },

    finishLoop(): Promise<void> {
      return finishLoopPromise();
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
      // Calling `setTime` at all is the statement that this instance is
      // externally driven, so `driven`/`halt()` come first and apply
      // even to a non-finite `t`. Otherwise the PRD's flagship case —
      // `time={scrollY / contentHeight}`, which is `NaN` on the first
      // render, before layout — would leave the internal clock running
      // and the indicator animating freely until a finite ratio
      // arrived, which is neither what the README promises ("the
      // displayed frame just holds") nor what native does (it treats a
      // non-finite `time` as driving, and holds).
      driven = true;
      halt();
      // The *value* is then ignored (ADR 0006 §3) rather than clamped to
      // frame 0: `frameForPhase`'s totality is a backstop for anything
      // that slips past every driver, not license for a driver to snap
      // to frame 0 on its own. The phase is left where it was, so the
      // displayed frame holds and `onFrame` does not fire.
      if (!Number.isFinite(t)) return;
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
      finishTransitionSilently();
      settlePendingSilently();
      halt();
      drainLoopEnd();
      // Release the sprite strip (and the sampled cells) for GC rather
      // than leaving the last steady state's — or a half-morphed
      // transition's — canvas sitting around referenced.
      sheet = null;
      cells = [];
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
