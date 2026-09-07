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
  reducedMotion = false,
}: UseDitheredTransitionOptions): DitheredTransitionPictures {
  const {
    shape: fromShape,
    brightness: fromBrightness,
    cells: fromProvidedCells,
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
    // web renderer (ADR 0004 §2).
    const rows = resolveRows(toOpts);
    const fromCells =
      fromProvidedCells ??
      sampleCells(fromOpts.shape, toOpts.cols, fromOpts.hitTest, rows, fromOpts.matrix);
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
      0,
      duration,
    );

    const steps = Math.min(240, Math.max(2, Math.round(duration / frameCadence(fromOpts))));

    const geometry = computeGeometry(toOpts, width, height);
    const bounds = Skia.XYWHRect(0, 0, width, height);
    const pictures = Array.from({ length: steps }, (_, i) => {
      const p = i / (steps - 1);
      // `p * duration` stands in for "elapsed ms since the morph started"
      // — a deterministic clock for `brightnessAt`'s per-side phases,
      // baked into the recording at record time rather than read from a
      // live clock during playback.
      return createPicture((canvas) => {
        paintFrame(
          skiaPaintContext(canvas),
          core.cellsAt(p),
          core.brightnessAt(p, p * duration),
          0,
          geometry,
        );
      }, bounds);
    });

    return { pictures, width, height };
  }, [
    fromShape,
    fromBrightness,
    fromProvidedCells,
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
    reducedMotion,
  ]);
}
