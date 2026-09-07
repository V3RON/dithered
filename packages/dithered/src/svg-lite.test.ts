import { describe, expect, it } from 'vitest';
import { shapeFromSvg } from './svg';
import { shapeFromSvgLite } from './svg-lite';

const TWO_PATH_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">' +
  '<path d="M10 10 H90 V90 H10 Z" />' +
  '<path d="M20 20 L80 20 L50 80 Z" />' +
  '</svg>';

describe('shapeFromSvgLite', () => {
  it('agrees with the DOM-backed shapeFromSvg', () => {
    expect(shapeFromSvgLite(TWO_PATH_SVG)).toEqual(shapeFromSvg(TWO_PATH_SVG));
  });

  it('reads the viewBox', () => {
    expect(shapeFromSvgLite(TWO_PATH_SVG).viewBox).toEqual({
      x: 0,
      y: 0,
      width: 100,
      height: 100,
    });
  });

  it('concatenates path data in document order, space-joined', () => {
    expect(shapeFromSvgLite(TWO_PATH_SVG).path).toBe('M10 10 H90 V90 H10 Z M20 20 L80 20 L50 80 Z');
  });

  it('parses comma- and space-separated viewBox values alike', () => {
    const svg = '<svg viewBox="1, 2, 30, 40"><path d="M0 0 Z"/></svg>';
    expect(shapeFromSvgLite(svg).viewBox).toEqual({ x: 1, y: 2, width: 30, height: 40 });
  });

  it('accepts single-quoted attributes', () => {
    const svg = "<svg viewBox='0 0 10 10'><path d='M1 1 Z'/></svg>";
    expect(shapeFromSvgLite(svg).path).toBe('M1 1 Z');
  });

  it('tolerates attributes before and after the ones it reads', () => {
    const svg =
      '<svg id="a" viewBox="0 0 10 10" fill="none"><path fill="red" d="M1 1 Z" stroke="x"/></svg>';
    const shape = shapeFromSvgLite(svg);
    expect(shape.path).toBe('M1 1 Z');
    expect(shape.viewBox.width).toBe(10);
  });

  it('ignores paths inside comments', () => {
    const svg = '<svg viewBox="0 0 10 10"><!-- <path d="M9 9 Z"/> --><path d="M1 1 Z"/></svg>';
    expect(shapeFromSvgLite(svg).path).toBe('M1 1 Z');
  });

  it('ignores markup inside CDATA', () => {
    const svg =
      '<svg viewBox="0 0 10 10"><style><![CDATA[<path d="M9 9 Z"/>]]></style><path d="M1 1 Z"/></svg>';
    expect(shapeFromSvgLite(svg).path).toBe('M1 1 Z');
  });

  it('handles a self-closing path and a paired one', () => {
    const svg = '<svg viewBox="0 0 10 10"><path d="M1 1 Z"/><path d="M2 2 Z"></path></svg>';
    expect(shapeFromSvgLite(svg).path).toBe('M1 1 Z M2 2 Z');
  });

  it('skips <path> elements with no d attribute', () => {
    const svg = '<svg viewBox="0 0 10 10"><path fill="red"/><path d="M1 1 Z"/></svg>';
    expect(shapeFromSvgLite(svg).path).toBe('M1 1 Z');
  });

  it('does not match viewBox case-insensitively', () => {
    // SVG attribute names are case-sensitive; `viewbox` is not a viewBox.
    const svg = '<svg viewbox="0 0 10 10"><path d="M1 1 Z"/></svg>';
    expect(() => shapeFromSvgLite(svg)).toThrow(/viewBox/i);
  });

  it('throws a clear error when there is no <svg> root', () => {
    expect(() => shapeFromSvgLite('<div></div>')).toThrow(/svg/i);
  });

  it('throws a clear error when viewBox is missing', () => {
    expect(() => shapeFromSvgLite('<svg><path d="M0 0 Z"/></svg>')).toThrow(/viewBox/i);
  });

  it('throws a clear error when viewBox is malformed', () => {
    expect(() => shapeFromSvgLite('<svg viewBox="0 0 10"><path d="M0 0 Z"/></svg>')).toThrow(
      /viewBox/i,
    );
  });

  it('throws a clear error when no <path> elements are found', () => {
    expect(() =>
      shapeFromSvgLite('<svg viewBox="0 0 10 10"><rect width="10" height="10"/></svg>'),
    ).toThrow(/path/i);
  });
});
