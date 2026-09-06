import { aspectOf, sampleCells, type Cell, type Shape } from './shape';

/**
 * Per-cell, per-frame brightness. `t` is the loop phase in `[0, 1)`.
 *
 * A `number` is compared against `cell.threshold` (drawn when
 * `brightness > threshold`), giving an ordered-dither look. A `boolean`
 * draws or skips the cell outright, bypassing the dither entirely.
 */
export type Brightness = (cell: Cell, t: number) => number | boolean;

export interface DitheredOptions {
  shape: Shape;
  brightness: Brightness;
  /** CSS px height; width follows the shape's aspect ratio. Default 48. */
  size?: number;
  /** Grid columns. Default 16. */
  cols?: number;
  /** Grid rows. Defaults to a value derived from the shape's aspect ratio. */
  rows?: number;
  /** Frames per loop. Default 48. */
  frames?: number;
  /** Loop duration in ms. Default 2000. */
  period?: number;
  /** Fill color for drawn cells. Default '#000'. */
  fg?: string;
  /** Background fill, or 'transparent'. Default 'transparent'. */
  bg?: string;
  /** Pre-render the loop into a sprite strip. 'auto' = on for size <= 120. Default 'auto'. */
  cache?: boolean | 'auto';
  /** Freeze the animation. Default false. */
  paused?: boolean;
  /** Gap between cells, as a fraction of cell size (min 0.6px). Default 0.09. */
  gap?: number;
  /** Corner radius, as a fraction of cell size. Default 0.14. */
  radius?: number;
  /** Render a single static frame under `prefers-reduced-motion`. Default true. */
  respectReducedMotion?: boolean;
  /** Frame drawn synchronously on create, so there is no blank flash. Default 0. */
  initialFrame?: number;
}

export interface DitheredInstance {
  setPaused(paused: boolean): void;
  /** Re-configures the instance; may resample cells and/or rebuild the sprite cache. */
  update(options: Partial<DitheredOptions>): void;
  /** Draws a specific frame directly, bypassing the animation loop. */
  renderFrame(frame: number): void;
  /** Stops the loop and releases all listeners/observers. */
  destroy(): void;
}

type ResolvedOptions = Required<DitheredOptions>;

const DEFAULTS: Omit<ResolvedOptions, 'shape' | 'brightness'> = {
  size: 48,
  cols: 16,
  rows: 0, // 0 means "derive from aspect ratio" (see resolveRows)
  frames: 48,
  period: 2000,
  fg: '#000',
  bg: 'transparent',
  cache: 'auto',
  paused: false,
  gap: 0.09,
  radius: 0.14,
  respectReducedMotion: true,
  initialFrame: 0,
};

/**
 * Merges `patch` onto `base`, skipping any key whose value is `undefined`.
 *
 * A plain `{ ...base, ...patch }` spread would let an explicitly-passed
 * `undefined` (e.g. `{ fg: undefined }` — common when a caller forwards
 * an options object built from optional props) clobber a real value with
 * `undefined`, silently breaking rendering (an `undefined` `fg`/`bg`
 * leaves canvas `fillStyle` unset, which paints black; an `undefined`
 * `cols` makes cell size `NaN`, drawing nothing). Only an *absent* key
 * should fall through to `base`.
 */
function assignDefined<T extends object>(base: T, patch: Partial<T>): T {
  const result = { ...base };
  for (const key of Object.keys(patch) as (keyof T)[]) {
    const value = patch[key];
    if (value !== undefined) {
      result[key] = value as T[keyof T];
    }
  }
  return result;
}

function resolveOptions(options: DitheredOptions): ResolvedOptions {
  return assignDefined(DEFAULTS as ResolvedOptions, options);
}

function resolveRows(opts: ResolvedOptions): number {
  return opts.rows > 0 ? opts.rows : Math.max(1, Math.round(opts.cols / aspectOf(opts.shape)));
}

/**
 * Quantizes wall-clock time to a frame index in `[0, frames)`, looping
 * every `period` ms.
 */
export function frameAt(nowMs: number, period: number, frames: number): number {
  const phase = ((nowMs % period) + period) % period; // guard negative nowMs
  return Math.floor((phase / period) * frames) % frames;
}

/** The tiny slice of CanvasRenderingContext2D that painting needs. */
export interface PaintContext {
  fillStyle: string | CanvasGradient | CanvasPattern;
  fillRect(x: number, y: number, w: number, h: number): void;
  beginPath(): void;
  roundRect?(x: number, y: number, w: number, h: number, radius: number): void;
  rect(x: number, y: number, w: number, h: number): void;
  fill(): void;
}

export interface PaintGeometry {
  /** Cell size in device pixels. */
  cellSize: number;
  /** Gap on each side of a cell, in device pixels (already floored to a minimum). */
  gap: number;
  /** Corner radius, in device pixels. */
  radius: number;
  fg: string;
  bg: string;
  /** Canvas (or sprite-strip frame) width/height in device pixels. */
  width: number;
  height: number;
  /** Horizontal offset to draw at, used when painting into a sprite strip. */
  ox?: number;
}

/**
 * Paints one frame's worth of cells: an optional background fill, then a
 * rounded square (or plain rect, if `roundRect` is unsupported) per cell
 * whose brightness clears its Bayer threshold.
 */
export function paintFrame(
  ctx: PaintContext,
  cells: readonly Cell[],
  brightness: Brightness,
  phase: number,
  geometry: PaintGeometry,
): void {
  const { cellSize: s, gap, radius, fg, bg, width, height, ox = 0 } = geometry;

  if (bg !== 'transparent') {
    ctx.fillStyle = bg;
    ctx.fillRect(ox, 0, width, height);
  }

  ctx.fillStyle = fg;
  for (const cell of cells) {
    const b = brightness(cell, phase);
    const draw = typeof b === 'boolean' ? b : b > cell.threshold;
    if (!draw) continue;

    const w = s - gap * 2;
    const x = ox + cell.i * s + gap;
    const y = cell.j * s + gap;
    ctx.beginPath();
    if (typeof ctx.roundRect === 'function') {
      ctx.roundRect(x, y, w, w, radius);
    } else {
      ctx.rect(x, y, w, w);
    }
    ctx.fill();
  }
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

  function geometryFor(ox: number): PaintGeometry {
    const s = W / opts.cols;
    return {
      cellSize: s,
      gap: Math.max(0.6, s * opts.gap),
      radius: s * opts.radius,
      fg: opts.fg,
      bg: opts.bg,
      width: W,
      height: H,
      ox,
    };
  }

  function configure(): void {
    const aspect = aspectOf(opts.shape);
    const dpr = Math.min((typeof window !== 'undefined' ? window.devicePixelRatio : 1) || 1, 3);
    canvas.style.width = opts.size * aspect + 'px';
    canvas.style.height = opts.size + 'px';
    W = canvas.width = Math.round(opts.size * aspect * dpr);
    H = canvas.height = Math.round(opts.size * dpr);

    cells = sampleCells(opts.shape, opts.cols, resolveRows(opts), ctx);

    const useCache = opts.cache === 'auto' ? opts.size <= 120 : opts.cache;
    if (useCache) {
      const strip = document.createElement('canvas');
      strip.width = W * opts.frames;
      strip.height = H;
      const sctx = strip.getContext('2d');
      if (sctx) {
        for (let f = 0; f < opts.frames; f++) {
          paintFrame(sctx, cells, opts.brightness, f / opts.frames, geometryFor(f * W));
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
      paintFrame(ctx, cells, opts.brightness, f / opts.frames, geometryFor(0));
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
