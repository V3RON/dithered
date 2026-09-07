import { describe, expect, it } from 'vitest';
import { shapeFromSvg } from './svg';

const TWO_PATH_SVG = `
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
  <path d="M10 10 H90 V90 H10 Z" />
  <path d="M20 20 L80 20 L50 80 Z" />
</svg>
`;

describe('shapeFromSvg', () => {
  it('parses an inline SVG string with multiple paths', () => {
    const shape = shapeFromSvg(TWO_PATH_SVG);
    expect(shape.viewBox).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(shape.path).toContain('M10 10 H90 V90 H10 Z');
    expect(shape.path).toContain('M20 20 L80 20 L50 80 Z');
  });

  it('concatenates path data in document order, space-joined', () => {
    const shape = shapeFromSvg(TWO_PATH_SVG);
    expect(shape.path).toBe('M10 10 H90 V90 H10 Z M20 20 L80 20 L50 80 Z');
  });

  it('throws a clear error when viewBox is missing', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><path d="M0 0 L10 10 Z" /></svg>';
    expect(() => shapeFromSvg(svg)).toThrow(/viewBox/i);
  });

  it('throws a clear error when no drawable geometry is found', () => {
    // <rect> is itself supported (see svg-fixtures.test.ts); wrapping it in
    // <defs> is what makes this document empty of drawable geometry.
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><defs><rect width="10" height="10"/></defs></svg>';
    expect(() => shapeFromSvg(svg)).toThrow(/path/i);
  });

  it('accepts an already-parsed SVGSVGElement', () => {
    const doc = new DOMParser().parseFromString(TWO_PATH_SVG, 'image/svg+xml');
    const root = doc.documentElement as unknown as SVGSVGElement;
    const shape = shapeFromSvg(root);
    expect(shape.viewBox).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(shape.path).toBe('M10 10 H90 V90 H10 Z M20 20 L80 20 L50 80 Z');
  });

  it('converts a <rect> with rx/ry, and bakes an ancestor <g transform>', () => {
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <g transform="translate(10 10)"><rect width="20" height="20" /></g>
      </svg>
    `;
    // H/V fold into L once a transform is baked (toAbsolute normalizes to L before transforming).
    expect(shapeFromSvg(svg).path).toBe('M 10 10 L 30 10 L 30 30 L 10 30 Z');
  });

  it('sets fillRule when every contributing element declares evenodd', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<path fill-rule="evenodd" d="M0 0 Z" /></svg>';
    expect(shapeFromSvg(svg).fillRule).toBe('evenodd');
  });

  it('omits fillRule when the document only uses the default (nonzero) rule', () => {
    expect(shapeFromSvg(TWO_PATH_SVG).fillRule).toBeUndefined();
  });

  it('throws when fill-rule disagrees across contributing elements', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<path fill-rule="nonzero" d="M0 0 Z" /><path fill-rule="evenodd" d="M1 1 Z" /></svg>';
    expect(() => shapeFromSvg(svg)).toThrow(/fill-rule/i);
  });

  it('throws the <use>/<text>-specific message when that is all the geometry there is', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10">' +
      '<text x="0" y="0">hi</text></svg>';
    expect(() => shapeFromSvg(svg)).toThrow(/<text>/);
    expect(() => shapeFromSvg(svg)).not.toThrow(/no drawable geometry/i);
  });

  it('throws the generic empty-document message for a truly empty <svg>', () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"></svg>';
    expect(() => shapeFromSvg(svg)).toThrow(/no drawable geometry/i);
  });
});
