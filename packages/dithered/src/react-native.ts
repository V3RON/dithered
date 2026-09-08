/**
 * React Native entry point, rendering through
 * `@shopify/react-native-skia`. Requires `@shopify/react-native-skia`,
 * `react-native-reanimated` and `react-native` as peers.
 *
 * Nothing here is reachable from `dithered` or `dithered/react`, so web
 * consumers never resolve a native module.
 */
export type { Shape, Cell, HitTester } from './shape';
export { BAYER_4, aspectOf, defaultRowsFor, sampleCells } from './shape';
export { hash, valueNoise, fbm } from './noise';
export type { Brightness, DitheredOptions, PaintContext, PaintGeometry } from './core';
export { computeGeometry, frameAt, paintFrame, resolveOptions, resolveRows } from './core';
export { presets, gem, sweep, pulse, rain, wave, fill, gameOfLife } from './presets';
export { shapes, rozenite, circle, square, diamond, heart } from './shapes';
export { shapeFromSvgLite } from './svg-lite';

export { Dithered } from './react-native/Dithered';
export type { DitheredProps } from './react-native/Dithered';
export { useDitheredPictures } from './react-native/pictures';
export type { DitheredPictures, DitheredPicturesOptions } from './react-native/pictures';
export { skiaPaintContext } from './react-native/paint-context';
export { skiaHitTester } from './react-native/hit-test';
