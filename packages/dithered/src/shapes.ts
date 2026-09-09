import type { Shape } from './shape';

/**
 * The Rozenite gem mark. Path `d` and viewBox lifted verbatim from
 * `packages/ui/src/rozenite-loader/rozenite-loader.tsx` (`PATH_D`/`VB`).
 */
export const rozenite: Shape = {
  path:
    'M17.333 5.333H20V10.667H22.667V16H25.333V24H22.667V26.667H20V29.333H12' +
    'V26.667H9.333V24H6.667V16H9.333V10.667H12V5.333H14.667V2.667H17.333V5.333Z',
  viewBox: { x: 6.67, y: 2.67, width: 18.67, height: 26.67 },
};

export const circle: Shape = {
  path: 'M10 50 A40 40 0 1 0 90 50 A40 40 0 1 0 10 50 Z',
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
};

export const square: Shape = {
  path: 'M10 10 H90 V90 H10 Z',
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
};

export const diamond: Shape = {
  path: 'M50 5 L95 50 L50 95 L5 50 Z',
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
};

export const heart: Shape = {
  path:
    'M50 88 C20 65 5 40 5 25 C5 10 15 0 30 0 C42 0 50 10 50 20 ' +
    'C50 10 58 0 70 0 C85 0 95 10 95 25 C95 40 80 65 50 88 Z',
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
};

/**
 * A checkmark ribbon (thick, filled — not a stroked polyline, so the
 * hit-test used to sample cells has area to test against). Shares its
 * viewBox with {@link cross} so `shapes.check` <-> `shapes.cross` is the
 * headline `transitionTo` pairing from ADR 0004: same aspect ratio means
 * the morph's grid never resizes.
 */
export const check: Shape = {
  path: 'M20 55 L35 70 L80 25 L72 17 L35 54 L28 45 Z',
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
};

/**
 * A cross/X mark: two diagonal bars, each its own closed subpath, wound
 * the same direction so their overlap at the centre still fills under the
 * nonzero rule. `0 0 100 100` viewBox, matching {@link check}.
 */
export const cross: Shape = {
  path:
    'M26.4 13.6 L86.4 73.6 L73.6 86.4 L13.6 26.4 Z ' +
    'M86.4 26.4 L26.4 86.4 L13.6 73.6 L73.6 13.6 Z',
  viewBox: { x: 0, y: 0, width: 100, height: 100 },
};

export const shapes = { rozenite, circle, square, diamond, heart, check, cross };
