import { useMemo } from 'react';
import { Skia, createPicture, type SkPicture } from '@shopify/react-native-skia';
import {
  computeGeometry,
  hasCurrentColor,
  paintFrame,
  resolveOptions,
  resolveRows,
  surfaceSize,
  toPalette,
  type DitheredOptions,
} from '../core';
import { sampleCells, type Cell } from '../shape';
import { skiaHitTester } from './hit-test';
import { skiaPaintContext } from './paint-context';

export interface DitheredPicturesOptions extends DitheredOptions {
  /**
   * Pre-sampled cells, skipping the shape hit-test. Must match `cols`,
   * `rows` and `matrix` — see `sampleCells`. When `cells` is supplied,
   * `matrix` is ignored: the thresholds are already baked into those
   * cells, the same way `cols`/`rows` already behave alongside `cells`.
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

/** A palette joined by value, for identity-insensitive memo dependencies. */
function paletteKey(fg: string | readonly string[] | undefined): string | undefined {
  return fg === undefined ? undefined : typeof fg === 'string' ? fg : fg.join(' ');
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
 *
 * `fg`'s `'currentColor'` token is web-only (there is no cascade to
 * resolve it against on native) and throws here, during render, at the
 * point the bad prop is passed — rather than reaching `Skia.Color`
 * (`'currentcolor'` is not a Skia color) and failing far from the cause.
 */
export function useDitheredPictures(options: DitheredPicturesOptions): DitheredPictures {
  const {
    shape,
    brightness,
    cells: providedCells,
    size,
    cols,
    rows,
    matrix,
    frames,
    fg,
    bg,
    gap,
    radius,
  } = options;

  // Joined by value rather than depended on by identity: an inline
  // palette literal (`fg={['#a', '#b']}`) is a fresh array every render
  // for an unmemoized caller, and keying the memo on `fg` directly would
  // re-record every picture on every render.
  const fgKey = paletteKey(fg);

  return useMemo(() => {
    if (fg !== undefined && hasCurrentColor(toPalette(fg))) {
      throw new Error(
        "dithered: 'currentColor' is not supported on native — pass an explicit color.",
      );
    }

    const opts = resolveOptions({
      shape,
      brightness,
      size,
      cols,
      rows,
      matrix,
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
      sampleCells(opts.shape, opts.cols, skiaHitTester(opts.shape), resolveRows(opts), opts.matrix);

    const geometry = computeGeometry(opts, width, height);
    const bounds = Skia.XYWHRect(0, 0, width, height);
    const pictures = Array.from({ length: frameCount }, (_, f) =>
      createPicture((canvas) => {
        paintFrame(skiaPaintContext(canvas), cells, opts.brightness, f / frameCount, geometry);
      }, bounds),
    );

    return { pictures, width, height };
    // `period`, `paused`, `progress` and friends deliberately absent:
    // none of them change what is drawn, only when. `fg` is also absent —
    // `fgKey` (its value, not its identity) is the real dependency.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [shape, brightness, providedCells, size, cols, rows, matrix, frames, fgKey, bg, gap, radius]);
}
