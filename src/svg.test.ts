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

  it('throws a clear error when no <path> elements are found', () => {
    const svg =
      '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10"/></svg>';
    expect(() => shapeFromSvg(svg)).toThrow(/path/i);
  });

  it('accepts an already-parsed SVGSVGElement', () => {
    const doc = new DOMParser().parseFromString(TWO_PATH_SVG, 'image/svg+xml');
    const root = doc.documentElement as unknown as SVGSVGElement;
    const shape = shapeFromSvg(root);
    expect(shape.viewBox).toEqual({ x: 0, y: 0, width: 100, height: 100 });
    expect(shape.path).toBe('M10 10 H90 V90 H10 Z M20 20 L80 20 L50 80 Z');
  });
});
