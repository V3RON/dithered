import { useMemo } from 'react';
import { Skia, createPicture, type SkPicture } from '@shopify/react-native-skia';
import {
  computeGeometry,
  paintFrame,
  resolveOptions,
  resolveRows,
  surfaceSize,
  type DitheredOptions,
} from '../core';
import { sampleCells, type Cell } from '../shape';
import { skiaHitTester } from './hit-test';
import { skiaPaintContext } from './paint-context';

export interface DitheredPicturesOptions extends DitheredOptions {
  /**
   * Pre-sampled cells, skipping the shape hit-test. Must match `cols` and
   * `rows` — see `sampleCells`.
   */
  cells?: readonly Cell[];
}

export interface DitheredPictures {
  /** One recording per frame of the loop, in order. */
  pictures: SkPicture[];
  /** Canvas width in dp. */
  width: number;
  /** Canvas height in dp. */
  height: number;
}

/**
 * Samples the shape and records every frame of the loop as an
 * `SkPicture`, the React Native counterpart to the web renderer's
 * sprite-strip cache.
 *
 * Unlike that cache this is unconditional, and `cache` is ignored:
 * pictures are display lists rather than bitmaps, so the memory pressure
 * that makes pre-rendering a trade-off on the web does not apply. Having
 * every frame ready up front is what lets playback run entirely on the UI
 * thread.
 *
 * Recordings are in dp — Skia scales to the device's pixel ratio itself,
 * and the output is vector, so there is nothing to re-record when the
 * ratio differs.
 */
export function useDitheredPictures(options: DitheredPicturesOptions): DitheredPictures {
  const {
    shape,
    brightness,
    cells: providedCells,
    size,
    cols,
    rows,
    frames,
    fg,
    bg,
    gap,
    radius,
  } = options;

  return useMemo(() => {
    const opts = resolveOptions({
      shape,
      brightness,
      size,
      cols,
      rows,
      frames,
      fg,
      bg,
      gap,
      radius,
    });
    const { width, height } = surfaceSize(opts);
    const frameCount = Math.max(1, opts.frames);

    const cells =
      providedCells ??
      sampleCells(opts.shape, opts.cols, skiaHitTester(opts.shape), resolveRows(opts));

    const geometry = computeGeometry(opts, width, height);
    const bounds = Skia.XYWHRect(0, 0, width, height);
    const pictures = Array.from({ length: frameCount }, (_, f) =>
      createPicture((canvas) => {
        paintFrame(skiaPaintContext(canvas), cells, opts.brightness, f / frameCount, geometry);
      }, bounds),
    );

    return { pictures, width, height };
    // `period`, `paused`, `progress` and friends deliberately absent:
    // none of them change what is drawn, only when.
  }, [shape, brightness, providedCells, size, cols, rows, frames, fg, bg, gap, radius]);
}
