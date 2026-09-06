export type { Shape, Cell } from './shape';
export { BAYER_4, aspectOf, sampleCells } from './shape';
export { hash, valueNoise, fbm } from './noise';
export type {
  Brightness,
  DitheredOptions,
  DitheredInstance,
  PaintContext,
  PaintGeometry,
} from './renderer';
export { createDithered, frameAt, paintFrame } from './renderer';
