import { useMemo } from 'react';
import { Skia, createPicture, type SkPicture } from '@shopify/react-native-skia';
import {
  computeGeometry,
  createTransition,
  paintFrame,
  resolveOptions,
  resolveRows,
  resolveSizePx,
  surfaceSize,
  type DitheredOptions,
} from '../core';
import { sampleCells, type Cell } from '../shape';
import { skiaPaintContext } from './paint-context';

/**
 * One side of a native morph, plus optional pre-sampled cells — the same
 * shape `useDitheredPictures` takes, so a caller can share one options
 * object between the steady-state hook and this one.
 */
export interface DitheredTransitionSide extends DitheredOptions {
  cells?: readonly Cell[];
}

export interface UseDitheredTransitionOptions {
  /** The loop currently playing — the morph's outgoing side. */
  from: DitheredTransitionSide;
  /** The loop being morphed to — the morph's incoming side, and whose grid/surface the morph adopts (ADR 0004 §2). */
  to: DitheredTransitionSide;
  /** Duration of the morph in ms. */
  duration: number;
  /**
   * The wall-clock instant (matching the clock `from`'s steady loop
   * computes its own phase from — see `Dithered.tsx`'s `MorphState`) at
   * which the morph begins. Fed into each side's `frameAt(startAt + p *
   * duration, period, frames)` (see `createTransition`), so both sides
   * keep ticking on the same clock the steady loop was already on rather
   * than restarting at phase 0 (ADR 0004 §4; finding 4). Default 0 —
   * matches the previous, buggy always-restart-at-0 behavior only when
   * the caller genuinely wants the morph to start at that clock's origin
   * (as every existing test recording from a fresh clock does).
   */
  startAt?: number;
  /**
   * Skip recording entirely — `prefers-reduced-motion` (ADR 0004 §7). The
   * caller cuts straight to `to`'s steady-state pictures; `pictures` here
   * is just `[]`.
   */
  reducedMotion?: boolean;
}

export interface DitheredTransitionPictures {
  /** One recording per step, in playback order. Empty under reduced motion. */
  pictures: SkPicture[];
  /** Canvas width in dp — `to`'s, since the morph runs on the target surface. */
  width: number;
  /** Canvas height in dp. */
  height: number;
}

/** Cadence (ms/frame) of a loop's steady-state playback. */
function frameCadence(opts: { period: number; frames: number }): number {
  return opts.period / Math.max(1, opts.frames);
}

/**
 * The React Native counterpart to the web renderer's transition frames
 * (ADR 0004 §5): records a morph from `from` to `to` up front as an array
 * of `SkPicture`s, using the same `paintFrame`/`skiaPaintContext` path
 * `useDitheredPictures` records the steady state with, so playback stays
 * on the UI thread the same way.
 *
 * Step count follows the steady-state cadence of the loop it interrupts —
 * `from`'s — clamped to `[2, 240]`, so a morph ticks at roughly the same
 * rate as ordinary playback without letting a long `duration` record an
 * unbounded number of pictures.
 *
 * The recordings are meant to be played once, in order, then dropped —
 * this hook only records them; `Dithered` owns advancing through them and
 * handing off to the steady-state array once they're exhausted.
 */
export function useDitheredTransition({
  from,
  to,
  duration,
  startAt = 0,
  reducedMotion = false,
}: UseDitheredTransitionOptions): DitheredTransitionPictures {
  const {
    shape: fromShape,
    brightness: fromBrightness,
    size: fromSize,
    cols: fromCols,
    rows: fromRows,
    matrix: fromMatrix,
    frames: fromFrames,
    period: fromPeriod,
    fg: fromFg,
    bg: fromBg,
    gap: fromGap,
    radius: fromRadius,
    hitTest: fromHitTest,
  } = from;
  const {
    shape: toShape,
    brightness: toBrightness,
    cells: toProvidedCells,
    size: toSize,
    cols: toCols,
    rows: toRows,
    matrix: toMatrix,
    frames: toFrames,
    period: toPeriod,
    fg: toFg,
    bg: toBg,
    gap: toGap,
    radius: toRadius,
    hitTest: toHitTest,
  } = to;

  return useMemo(() => {
    const fromOpts = resolveOptions({
      shape: fromShape,
      brightness: fromBrightness,
      size: fromSize,
      cols: fromCols,
      rows: fromRows,
      matrix: fromMatrix,
      frames: fromFrames,
      period: fromPeriod,
      fg: fromFg,
      bg: fromBg,
      gap: fromGap,
      radius: fromRadius,
      hitTest: fromHitTest,
    });
    const toOpts = resolveOptions({
      shape: toShape,
      brightness: toBrightness,
      size: toSize,
      cols: toCols,
      rows: toRows,
      matrix: toMatrix,
      frames: toFrames,
      period: toPeriod,
      fg: toFg,
      bg: toBg,
      gap: toGap,
      radius: toRadius,
      hitTest: toHitTest,
    });
    const { width, height } = surfaceSize(resolveSizePx(toOpts.size), toOpts.shape);

    if (reducedMotion) {
      return { pictures: [], width, height };
    }

    // Both shapes are sampled onto the *target's* grid — same rule as the
    // web renderer (ADR 0004 §2). Unlike `to`, `from`'s cells are always
    // resampled here rather than trusting a caller-supplied `cells` (see
    // `DitheredTransitionSide`): a pre-sampled `from.cells` was sampled
    // for *its own* options, and there is no way to tell from here whether
    // that happens to already be the target's grid. `to.cells`, in
    // contrast, is exactly what a caller would sample for the target grid
    // in the first place, so it's trusted the same way `useDitheredPictures`
    // trusts its own `cells` prop (finding 9).
    const rows = resolveRows(toOpts);
    const fromCells = sampleCells(
      fromOpts.shape,
      toOpts.cols,
      fromOpts.hitTest,
      rows,
      fromOpts.matrix,
    );
    const toCells =
      toProvidedCells ??
      sampleCells(toOpts.shape, toOpts.cols, toOpts.hitTest, rows, toOpts.matrix);

    const core = createTransition(
      {
        cells: fromCells,
        brightness: fromOpts.brightness,
        period: fromOpts.period,
        frames: fromOpts.frames,
      },
      {
        cells: toCells,
        brightness: toOpts.brightness,
        period: toOpts.period,
        frames: toOpts.frames,
      },
      startAt,
      duration,
    );

    const steps = Math.min(240, Math.max(2, Math.round(duration / frameCadence(fromOpts))));

    const geometry = computeGeometry(toOpts, width, height);
    const bounds = Skia.XYWHRect(0, 0, width, height);
    // Deliberately no explicit `.dispose()` on the *previous* recording
    // here (or anywhere else in this hook): every morph replaces this
    // array wholesale via `useMemo`'s recomputation, so the old array is
    // simply dropped and its `SkPicture`s are released whenever the JS
    // GC gets to them. That is a real, bounded cost — up to 240 pictures
    // abandoned per completed morph, on top of `useDitheredPictures`'
    // own re-recording on the same prop change — but disposing a picture
    // the UI thread might still be reading from (`Dithered.tsx`'s
    // `<Picture picture={picture} />` holds whichever step's `SkPicture`
    // is currently on screen in a Reanimated shared value, read directly
    // by the UI-thread frame callback, not by this JS-thread hook) would
    // be worse than the leak: a `dispose()` racing that read is a
    // use-after-free of native memory, not a slow one to reclaim. Proving
    // "the UI thread is definitely done with every entry of the old
    // array" would require reasoning about Reanimated's cross-thread
    // hand-off timing this hook has no visibility into, and getting it
    // wrong is a crash rather than a memory-pressure regression — so
    // this trade-off (bounded per-morph leak, GC-reclaimed) is accepted
    // rather than risked.
    const pictures = Array.from({ length: steps }, (_, i) => {
      const p = i / (steps - 1);
      // `startAt + p * duration` is "wall-clock ms at this step" on the
      // *same* clock `from`'s (and, prospectively, `to`'s) steady phase is
      // computed from — not a clock that restarts at 0 for every morph.
      // Baked into the recording at record time rather than read from a
      // live clock during playback. Getting this right (rather than
      // `p * duration`, which always restarts both sides at phase 0 — see
      // finding 4) is what keeps neither side visibly jumping at either
      // end of the morph, per ADR 0004 §4.
      const now = startAt + p * duration;
      return createPicture((canvas) => {
        paintFrame(
          skiaPaintContext(canvas),
          core.cellsAt(p),
          core.brightnessAt(p, now),
          0,
          geometry,
        );
      }, bounds);
    });

    return { pictures, width, height };
  }, [
    fromShape,
    fromBrightness,
    fromSize,
    fromCols,
    fromRows,
    fromMatrix,
    fromFrames,
    fromPeriod,
    fromFg,
    fromBg,
    fromGap,
    fromRadius,
    fromHitTest,
    toShape,
    toBrightness,
    toProvidedCells,
    toSize,
    toCols,
    toRows,
    toMatrix,
    toFrames,
    toPeriod,
    toFg,
    toBg,
    toGap,
    toRadius,
    toHitTest,
    duration,
    startAt,
    reducedMotion,
  ]);
}
