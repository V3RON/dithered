import {
  assignDefined,
  clonePaletteOption,
  computeGeometry,
  frameAt,
  hasCurrentColor,
  paintFrame,
  resolveOptions,
  resolvePalette,
  resolveRows,
  surfaceSize,
  toPalette,
  type DitheredOptions,
  type PaintContext,
  type PaintGeometry,
  type Palette,
  type ResolvedOptions,
} from './core';
import { domHitTester } from './hit-test';
import { sampleCells, type Cell } from './shape';

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
   * `style`-keyed effect) is cheap. `configure()` already does this on
   * create and on every `update()`; call this directly for the case ADR
   * 0005 §5 leaves out of scope — an ambient theme change with no other
   * option change to trigger `update()`.
   */
  refreshColors(): void;
  /** Stops the loop and releases all listeners/observers. */
  destroy(): void;
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

  let W = 0;
  let H = 0;
  let cells: Cell[] = [];
  let sheet: HTMLCanvasElement | null = null;

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

  /** Rebuilds the sprite-strip cache (or clears it) from the current `cells`/`paintOpts`. */
  function buildCache(): void {
    const useCache = opts.cache === 'auto' ? opts.size <= 120 : opts.cache;
    if (useCache) {
      const strip = document.createElement('canvas');
      strip.width = W * opts.frames;
      strip.height = H;
      const sctx = strip.getContext('2d');
      if (sctx) {
        for (let f = 0; f < opts.frames; f++) {
          paintFrame(
            sctx,
            cells,
            opts.brightness,
            f / opts.frames,
            computeGeometry(paintOpts, W, H, f * W),
          );
        }
        sheet = strip;
      } else {
        sheet = null;
      }
    } else {
      sheet = null;
    }
  }

  function configure(): void {
    applyResolvedFg();

    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 3);
    const css = surfaceSize(opts);
    const device = surfaceSize(opts, dpr);
    const newW = Math.round(device.width);
    const newH = Math.round(device.height);

    // Sample first, before touching the canvas or any module state: an
    // invalid `matrix` (or any other bad option) throws here, and
    // `update()` relies on nothing having changed yet when that happens.
    const newCells = sampleCells(
      opts.shape,
      opts.cols,
      domHitTester(opts.shape, ctx),
      resolveRows(opts),
      opts.matrix,
    );

    canvas.style.width = css.width + 'px';
    canvas.style.height = css.height + 'px';
    W = canvas.width = newW;
    H = canvas.height = newH;
    cells = newCells;

    buildCache();

    currentFrame = -1;
  }

  function blit(f: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (sheet) {
      ctx.drawImage(sheet, f * W, 0, W, H, 0, 0, W, H);
    } else {
      paintFrame(ctx, cells, opts.brightness, f / opts.frames, computeGeometry(paintOpts, W, H));
    }
    currentFrame = f;
  }

  function schedule(): void {
    if (destroyed || isPaused || !visible || reduced) return;
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
  configure();

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

  blit(opts.initialFrame);
  schedule();

  return {
    setPaused(paused: boolean) {
      isPaused = paused;
      if (paused) halt();
      else schedule();
    },

    update(patch: Partial<DitheredOptions>) {
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

      // Try the candidate before committing to anything: an invalid
      // `matrix` (or any other bad option) must leave this instance
      // exactly as it was — same `opts`, same rendered frame, same
      // animation state — rather than getting bricked mid-merge. `opts`
      // is swapped in only for the duration of `configure()` (which reads
      // it via closure) and reverted if that throws, before the error
      // propagates.
      const previous = opts;
      opts = candidate;
      try {
        configure();
      } catch (err) {
        opts = previous;
        throw err;
      }

      reduced = prefersReducedMotion(opts);
      isPaused = opts.paused;
      halt();
      blit(currentFrame >= 0 ? currentFrame % opts.frames : opts.initialFrame);
      schedule();
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
    },
  };
}
