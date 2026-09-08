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
    expect(() => shapeFromSvg(svg)).toThrow(/no drawable geometry/i);
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
        <g transform="translate(10 10)"><rect width="20" height="20" rx="4" ry="4" /></g>
      </svg>
    `;
    // H/V fold into L, and the rounded corners' A arcs into C cubics, once
    // a transform is baked (transformSegments converts every arc under
    // any matrix, including a plain translation — see ADR 0010 §5).
    expect(shapeFromSvg(svg).path).toBe(
      'M 14 10 L 26 10 C 28.209139 10 30 11.790861 30 14 L 30 26 ' +
        'C 30 28.209139 28.209139 30 26 30 L 14 30 C 11.790861 30 10 28.209139 10 26 ' +
        'L 10 14 C 10 11.790861 11.790861 10 14 10 Z',
    );
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
