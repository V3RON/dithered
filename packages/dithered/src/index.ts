export type { Shape, Cell, FillRule, HitTester } from './shape';
export { BAYER_4, aspectOf, defaultRowsFor, sampleCells } from './shape';
export { domHitTester } from './hit-test';
export { hash, valueNoise, fbm } from './noise';
export type { Brightness, DitheredOptions, PaintContext, PaintGeometry, Palette } from './core';
export {
  computeGeometry,
  frameAt,
  paintFrame,
  resolveOptions,
  resolveRows,
  CURRENT_COLOR,
  hasCurrentColor,
  resolvePalette,
  toPalette,
  toneLevel,
} from './core';
export type { DitherMatrix, ResolvedMatrix } from './matrix';
export {
  BAYER_2,
  BAYER_8,
  BLUE_NOISE_16,
  bayerMatrix,
  resolveMatrix,
  thresholdFor,
} from './matrix';
export type { PathSegment } from './core';
export { arcToCubics, parsePath, serializePath, toAbsolute, transformSegments } from './core';
export type { RenderToSvgOptions, SvgPaintContext } from './core';
export { jsHitTester, renderToDataURL, renderToSvg, svgPaintContext } from './core';
export type { DitheredInstance } from './renderer';
export { createDithered } from './renderer';
export { presets, gem, sweep, pulse, rain, wave, fill, gameOfLife } from './presets';
export type { MixAmount, CellPredicate } from './compose';
export { compose, blend, mask, timeScale, reverse, offset, invert, clamp } from './compose';
export { shapes, rozenite, circle, square, diamond, heart } from './shapes';
export { shapeFromSvg } from './svg';
export { shapeFromSvgLite } from './svg-lite';
