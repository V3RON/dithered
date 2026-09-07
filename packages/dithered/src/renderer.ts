import {
  assignDefined,
  computeGeometry,
  frameAt,
  paintFrame,
  resolveOptions,
  resolveRows,
  surfaceSize,
  type DitheredOptions,
  type PaintContext,
  type PaintGeometry,
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

  function configure(): void {
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 3);
    const css = surfaceSize(opts);
    canvas.style.width = css.width + 'px';
    canvas.style.height = css.height + 'px';
    const device = surfaceSize(opts, dpr);
    W = canvas.width = Math.round(device.width);
    H = canvas.height = Math.round(device.height);

    cells = sampleCells(opts.shape, opts.cols, domHitTester(opts.shape, ctx), resolveRows(opts));

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
            computeGeometry(opts, W, H, f * W),
          );
        }
        sheet = strip;
      } else {
        sheet = null;
      }
    } else {
      sheet = null;
    }

    currentFrame = -1;
  }

  function blit(f: number): void {
    ctx.setTransform(1, 0, 0, 1, 0, 0);
    ctx.clearRect(0, 0, W, H);
    if (sheet) {
      ctx.drawImage(sheet, f * W, 0, W, H, 0, 0, W, H);
    } else {
      paintFrame(ctx, cells, opts.brightness, f / opts.frames, computeGeometry(opts, W, H));
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

  configure();
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
      // leaves the current value in place instead of resetting it.
      opts = assignDefined<ResolvedOptions>(opts, patch);
      reduced = prefersReducedMotion(opts);
      isPaused = opts.paused;
      halt();
      configure();
      blit(currentFrame >= 0 ? currentFrame % opts.frames : opts.initialFrame);
      schedule();
    },

    renderFrame(frame: number) {
      blit(frame);
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
