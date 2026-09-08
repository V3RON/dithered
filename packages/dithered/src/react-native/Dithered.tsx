import { useEffect, useState } from 'react';
import { AppState, type StyleProp, type ViewStyle } from 'react-native';
import { Canvas, Picture } from '@shopify/react-native-skia';
import { useFrameCallback, useReducedMotion, useSharedValue } from 'react-native-reanimated';
import type { Brightness, DitheredOptions } from '../core';
import { gem } from '../presets';
import type { Cell, Shape } from '../shape';
import { useDitheredPictures } from './pictures';

export interface DitheredProps extends Omit<
  DitheredOptions,
  'shape' | 'brightness' | 'cache' | 'paused'
> {
  shape: Shape;
  /** Per-cell, per-frame brightness. Default `presets.gem()`. */
  brightness?: Brightness;
  /** Freeze the animation on the current frame. Default false. */
  paused?: boolean;
  /**
   * Determinate progress in `[0, 1]`. When set, the animation is paused
   * and the frame corresponding to `progress` is shown.
   */
  progress?: number;
  /**
   * Pre-sampled cells, skipping the shape hit-test on mount. Must match
   * `cols`, `rows` and `matrix` — see `sampleCells`. When set, `matrix`
   * is ignored: the thresholds are already baked into those cells. A
   * `matrix` change still re-records every frame in this case (for
   * byte-identical output) — see `useDitheredPictures`'s `cells` doc.
   */
  cells?: readonly Cell[];
  /** Accessible label. Set to '' to hide from assistive tech entirely. Default 'Loading'. */
  label?: string;
  style?: StyleProp<ViewStyle>;
}

// Stable across renders so an un-memoized caller (the common case: nobody
// passes `brightness` at all) doesn't re-record every picture on render.
const DEFAULT_BRIGHTNESS = gem();

/** True while the app is foregrounded; recordings keep playing only then. */
function useAppActive(): boolean {
  const [active, setActive] = useState(() => AppState.currentState === 'active');
  useEffect(() => {
    const subscription = AppState.addEventListener('change', (next) =>
      setActive(next === 'active'),
    );
    return () => subscription.remove();
  }, []);
  return active;
}

function wrapFrame(frame: number, count: number): number {
  return ((Math.round(frame) % count) + count) % count;
}

/**
 * React Native counterpart to `dithered/react`'s `<Dithered>`, rendering
 * through `@shopify/react-native-skia`.
 *
 * Every frame of the loop is recorded once as an `SkPicture`
 * (see {@link useDitheredPictures}); playback then only swaps which
 * recording the canvas draws, from a Reanimated frame callback. That
 * keeps the whole animation on the UI thread — no JS work, and no bridge
 * traffic, per frame.
 *
 * Playback stops while the app is backgrounded, while `paused` is set,
 * while `progress` is controlled, and — unless `respectReducedMotion` is
 * false — while the OS reports a reduced-motion preference.
 */
export function Dithered({
  shape,
  brightness = DEFAULT_BRIGHTNESS,
  size,
  cols,
  rows,
  matrix,
  frames,
  period = 2000,
  fg,
  bg,
  gap,
  radius,
  paused = false,
  initialFrame = 0,
  respectReducedMotion = true,
  progress,
  cells,
  label = 'Loading',
  style,
}: DitheredProps) {
  const { pictures, width, height } = useDitheredPictures({
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
    cells,
  });
  const frameCount = pictures.length;

  const reducedMotion = useReducedMotion();
  const appActive = useAppActive();

  const currentFrame = useSharedValue(wrapFrame(initialFrame, frameCount));
  const picture = useSharedValue(pictures[wrapFrame(initialFrame, frameCount)]);

  // Re-point at the new recordings whenever they are rebuilt, so an
  // option change is visible even while playback is halted.
  useEffect(() => {
    const frame = wrapFrame(currentFrame.value, frameCount);
    currentFrame.value = frame;
    picture.value = pictures[frame];
  }, [pictures, frameCount, currentFrame, picture]);

  const holding =
    paused ||
    progress !== undefined ||
    !appActive ||
    (respectReducedMotion && reducedMotion === true);

  const loop = useFrameCallback((info) => {
    'worklet';
    // `frameAt` from the core, inlined: a worklet cannot call an ordinary
    // imported function, and repeating two lines of arithmetic here is
    // cheaper than making the shared core depend on Reanimated's babel
    // plugin having processed it.
    const phase = ((info.timeSinceFirstFrame % period) + period) % period;
    const frame = Math.floor((phase / period) * frameCount) % frameCount;
    if (frame !== currentFrame.value) {
      currentFrame.value = frame;
      picture.value = pictures[frame];
    }
  }, false);

  useEffect(() => {
    loop.setActive(!holding);
    // `loop` is a fresh object each render; keying the effect on it would
    // cross to the UI thread on every render for no benefit.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [holding]);

  // Determinate progress: pin the matching frame directly.
  useEffect(() => {
    if (typeof progress !== 'number') return;
    const clamped = Math.min(1, Math.max(0, progress));
    const frame = Math.round(clamped * (frameCount - 1));
    currentFrame.value = frame;
    picture.value = pictures[frame];
  }, [progress, pictures, frameCount, currentFrame, picture]);

  return (
    <Canvas
      style={[{ width, height }, style]}
      accessible={label !== ''}
      accessibilityLabel={label || undefined}
      accessibilityRole="progressbar"
      accessibilityValue={
        progress === undefined
          ? undefined
          : { min: 0, max: 100, now: Math.round(Math.min(1, Math.max(0, progress)) * 100) }
      }
      importantForAccessibility={label ? 'yes' : 'no-hide-descendants'}
    >
      <Picture picture={picture} />
    </Canvas>
  );
}
