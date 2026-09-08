/**
 * The platform-free half of the library: option resolution, grid
 * geometry, frame quantization and painting. Nothing here touches the
 * DOM, so both `dithered` (canvas) and `dithered/react-native` (Skia) build on
 * it without dragging one platform's globals into the other's bundle.
 */
export type { Brightness, DitheredOptions, ResolvedOptions } from './options';
export {
  DEFAULTS,
  assignDefined,
  clonePaletteOption,
  resolveOptions,
  resolveRows,
  surfaceSize,
} from './options';
export type { PaintContext, PaintGeometry } from './paint';
export { computeGeometry, frameAt, paintFrame } from './paint';
export type { Palette } from './palette';
export { CURRENT_COLOR, hasCurrentColor, resolvePalette, toPalette, toneLevel } from './palette';
export type { DitherMatrix, ResolvedMatrix } from '../matrix';
export {
  BAYER_2,
  BAYER_4,
  BAYER_8,
  BLUE_NOISE_16,
  bayerMatrix,
  resolveMatrix,
  thresholdFor,
} from '../matrix';
export type { PathSegment } from './path';
export { arcToCubics, parsePath, serializePath, toAbsolute, transformSegments } from './path';
export type { Matrix } from './transform';
export { IDENTITY, apply, isIdentity, multiply, parseTransform } from './transform';
export type { AttrGetter } from './svg-shapes';
export { basicShapeToPath } from './svg-shapes';
export type { SvgNode } from './svg-tree';
export { collectGeometry } from './svg-tree';
// `Point`/`PathCommand`/`arcToCubics`/`parsePath`/`flattenPath`/`pathToPolygons`/
// `DEFAULT_TOLERANCE_DIVISOR` from `./path-geometry` are deliberately not
// re-exported here: `arcToCubics`/`parsePath` would collide with the
// same-named, differently-shaped exports from `./path` above. Nothing in
// the README documents these as public API (only `jsHitTester` is), so
// they stay internal to `path-hit-test.ts`/`static.ts`.
export type { JsHitTesterOptions } from './path-hit-test';
export { jsHitTester, pointInPolygons } from './path-hit-test';
export type { SvgPaintContext } from './svg-paint';
export { escapeXml, formatNumber, svgPaintContext } from './svg-paint';
export type { RenderToSvgOptions } from './static';
export { renderToDataURL, renderToSvg } from './static';
