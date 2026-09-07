/**
 * The platform-free half of the library: option resolution, grid
 * geometry, frame quantization and painting. Nothing here touches the
 * DOM, so both `dithered` (canvas) and `dithered/react-native` (Skia) build on
 * it without dragging one platform's globals into the other's bundle.
 */
export type { Brightness, DitheredOptions, ResolvedOptions } from './options';
export { DEFAULTS, assignDefined, resolveOptions, resolveRows, surfaceSize } from './options';
export type { PaintContext, PaintGeometry } from './paint';
export { computeGeometry, frameAt, paintFrame } from './paint';
export type { Palette } from './palette';
export { CURRENT_COLOR, hasCurrentColor, resolvePalette, toPalette, toneLevel } from './palette';
