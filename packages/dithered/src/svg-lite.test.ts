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

  it('agrees with shapeFromSvg when a d attribute is broken across multiple lines', () => {
    // XML attribute-value normalization (DOMParser's, and now the lite
    // scanner's) replaces every tab/newline/CR in an attribute value with
    // a space — routine formatting for hand-written and Illustrator SVG.
    const svg = `
      <svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100">
        <path d="M10 10
                 H90
                 V90
                 H10 Z" />
      </svg>
    `;
    expect(shapeFromSvgLite(svg)).toEqual(shapeFromSvg(svg));
  });

  it('agrees with shapeFromSvg on a CRLF-authored d attribute (regression: finding 2)', () => {
    // A real DOMParser folds "\r\n" to one "\n" before attribute-value
    // normalization even sees it, so it collapses to one space; without
    // that line-ending step first, the lite scanner's one-for-one
    // whitespace-to-space replacement would instead see "\r" and "\n" as
    // two separate characters and emit two spaces.
    const svg = '<svg viewBox="0 0 100 100">\r\n<path d="M10 10\r\nH90\r\nV90 H10 Z"/>\r\n</svg>';
    expect(shapeFromSvg(svg).path).toBe('M10 10 H90 V90 H10 Z');
    expect(shapeFromSvgLite(svg)).toEqual(shapeFromSvg(svg));
  });

  it('agrees with shapeFromSvg on a lone-CR-authored d attribute', () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M10 10\rH90 V90 H10 Z"/></svg>';
    expect(shapeFromSvgLite(svg)).toEqual(shapeFromSvg(svg));
  });

  it('expands numeric and predefined character references in attribute values, matching shapeFromSvg (regression: finding 3)', () => {
    const svg = '<svg viewBox="0 0 100 100"><path d="M10 10&#xA;H90 V90 H10 Z"/></svg>';
    expect(shapeFromSvg(svg).path).toBe('M10 10\nH90 V90 H10 Z');
    expect(shapeFromSvgLite(svg)).toEqual(shapeFromSvg(svg));
  });

  it('does not normalize a &#xA; character reference to a space, unlike a literal newline', () => {
    // Character references are expanded *after* whitespace normalization,
    // so the newline they name passes through verbatim rather than being
    // collapsed the way an actual newline byte in the source would be.
    const svg = '<svg viewBox="0 0 10 10"><path d="M1 1&#xA;Z"/></svg>';
    expect(shapeFromSvgLite(svg).path).toBe('M1 1\nZ');
  });

  it('expands a decimal character reference, matching shapeFromSvg', () => {
    // "&#48;" is '0'; a real parser splices it in before path parsing ever
    // sees the attribute value, so it merges into the "1" before it.
    const svg = '<svg viewBox="0 0 10 10"><path d="M1&#48; 10 Z"/></svg>';
    expect(shapeFromSvgLite(svg).path).toBe('M10 10 Z');
    expect(shapeFromSvgLite(svg)).toEqual(shapeFromSvg(svg));
  });

  it('expands the five predefined XML entities in attribute values, matching shapeFromSvg', () => {
    const svg = `<svg viewBox="0 0 10 10"><path d="M1 1 Z&amp;&lt;&gt;&quot;&apos;"/></svg>`;
    expect(shapeFromSvgLite(svg).path).toBe(`M1 1 Z&<>"'`);
    expect(shapeFromSvgLite(svg)).toEqual(shapeFromSvg(svg));
  });

  it('leaves an out-of-range numeric character reference unexpanded instead of throwing (regression: finding 2)', () => {
    // "&#x110000;" is one past 0x10FFFF, the highest Unicode code point —
    // String.fromCodePoint throws a RangeError for it, which must not
    // escape as a raw, unprefixed error the way it used to.
    const svg = '<svg viewBox="0 0 10 10"><path d="M0 0 Z&#x110000;"/></svg>';
    expect(() => shapeFromSvgLite(svg)).not.toThrow(RangeError);
    expect(shapeFromSvgLite(svg).path).toBe('M0 0 Z&#x110000;');
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

  it('throws a clear error when no drawable geometry is found', () => {
    // <rect> is itself supported (see svg-fixtures.test.ts); wrapping it in
    // <defs> is what makes this document empty of drawable geometry.
    expect(() =>
      shapeFromSvgLite(
        '<svg viewBox="0 0 10 10"><defs><rect width="10" height="10"/></defs></svg>',
      ),
    ).toThrow(/no drawable geometry/i);
  });

  it('converts a <rect> with rx/ry, and bakes an ancestor <g transform>', () => {
    const svg =
      '<svg viewBox="0 0 100 100"><g transform="translate(10 10)">' +
      '<rect width="20" height="20" rx="4" ry="4" /></g></svg>';
    // H/V fold into L, and the rounded corners' A arcs into C cubics, once
    // a transform is baked (transformSegments converts every arc under
    // any matrix, including a plain translation — see ADR 0010 §5).
    expect(shapeFromSvgLite(svg).path).toBe(
      'M 14 10 L 26 10 C 28.209139 10 30 11.790861 30 14 L 30 26 ' +
        'C 30 28.209139 28.209139 30 26 30 L 14 30 C 11.790861 30 10 28.209139 10 26 ' +
        'L 10 14 C 10 11.790861 11.790861 10 14 10 Z',
    );
  });

  it('sets fillRule when every contributing element declares evenodd', () => {
    const svg = '<svg viewBox="0 0 10 10"><path fill-rule="evenodd" d="M0 0 Z" /></svg>';
    expect(shapeFromSvgLite(svg).fillRule).toBe('evenodd');
  });

  it('omits fillRule when the document only uses the default (nonzero) rule', () => {
    expect(shapeFromSvgLite(TWO_PATH_SVG).fillRule).toBeUndefined();
  });

  it('throws when fill-rule disagrees across contributing elements', () => {
    const svg =
      '<svg viewBox="0 0 10 10"><path fill-rule="nonzero" d="M0 0 Z" />' +
      '<path fill-rule="evenodd" d="M1 1 Z" /></svg>';
    expect(() => shapeFromSvgLite(svg)).toThrow(/fill-rule/i);
  });

  it('throws the <use>/<text>-specific message when that is all the geometry there is', () => {
    const svg = '<svg viewBox="0 0 10 10"><text x="0" y="0">hi</text></svg>';
    expect(() => shapeFromSvgLite(svg)).toThrow(/<text>/);
    expect(() => shapeFromSvgLite(svg)).not.toThrow(/no drawable geometry/i);
  });

  it('throws the generic empty-document message for a truly empty <svg>', () => {
    expect(() => shapeFromSvgLite('<svg viewBox="0 0 10 10"></svg>')).toThrow(
      /no drawable geometry/i,
    );
  });
});
