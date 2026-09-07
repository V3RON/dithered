export type { Shape, Cell, FillRule, HitTester } from './shape';
export { BAYER_4, aspectOf, defaultRowsFor, sampleCells } from './shape';
export { domHitTester } from './hit-test';
export { hash, valueNoise, fbm } from './noise';
export type {
  Brightness,
  DitheredOptions,
  PaintContext,
  PaintGeometry,
  Palette,
  Size,
} from './core';
export {
  advancePhase,
  computeGeometry,
  frameAt,
  frameForPhase,
  loopsAt,
  paintFrame,
  phaseForFrame,
  resolveOptions,
  resolveRows,
  wrapPhase,
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
// `blend`/`blendPhases` from `./core` (the transition machinery's own
// crossfade helpers) are deliberately not re-exported here: `blend`
// would collide with `./compose`'s public `blend` below, which already
// covers the same "linear mix of two brightnesses" job (and more —
// `MixAmount` also accepts a per-cell function). Both are internal to
// `transitionTo`'s implementation, not documented as public API.
export type {
  CellDiff,
  ResolvedTransitionOptions,
  Transition,
  TransitionOptions,
  TransitionSide,
} from './core';
export { ENTER_START, EXIT_END, TRANSITION_DEFAULTS, createTransition, diffCells } from './core';
export type { DitheredInstance } from './renderer';
export { createDithered } from './renderer';
export { presets, gem, sweep, pulse, rain, wave, fill, gameOfLife } from './presets';
export type { MixAmount, CellPredicate } from './compose';
export { compose, blend, mask, timeScale, reverse, offset, invert, clamp } from './compose';
export { shapes, rozenite, circle, square, diamond, heart, check, cross } from './shapes';
export { shapeFromSvg } from './svg';
export { shapeFromSvgLite } from './svg-lite';
