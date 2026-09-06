import type { Shape } from './shape';

/**
 * Builds a {@link Shape} from an SVG document: reads the root `viewBox`
 * attribute and concatenates the `d` attribute of every `<path>`
 * descendant into a single path string.
 *
 * Concatenation assumes each `<path>`'s `d` starts with an absolute
 * moveto (`M`/`m`), which is how SVG authoring tools normally emit
 * paths — joining such strings with whitespace produces one valid
 * multi-subpath `d`. Only `<path>` elements are read; other shape
 * elements (`<circle>`, `<rect>`, `<polygon>`, ...) are ignored for now.
 *
 * @param svg An SVG source string, or an already-parsed `<svg>` element.
 */
export function shapeFromSvg(svg: string | SVGSVGElement): Shape {
  const root = typeof svg === 'string' ? parseSvgString(svg) : svg;

  const viewBoxAttr = root.getAttribute('viewBox');
  if (!viewBoxAttr) {
    throw new Error('shapeFromSvg: <svg> is missing a viewBox attribute.');
  }
  const parts = viewBoxAttr
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`shapeFromSvg: could not parse viewBox "${viewBoxAttr}".`);
  }
  const [x, y, width, height] = parts as [number, number, number, number];

  const pathEls = root.querySelectorAll('path');
  const path = Array.from(pathEls)
    .map((el) => el.getAttribute('d') ?? '')
    .filter((d) => d.length > 0)
    .join(' ');

  if (!path) {
    throw new Error(
      'shapeFromSvg: no <path> elements with a `d` attribute were found (only <path> is supported).',
    );
  }

  return { path, viewBox: { x, y, width, height } };
}

function parseSvgString(svg: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(svg, 'image/svg+xml');
  const parserError = doc.querySelector('parsererror');
  if (parserError) {
    throw new Error(`shapeFromSvg: failed to parse SVG string: ${parserError.textContent ?? ''}`);
  }
  const root = doc.documentElement;
  if (!root || root.tagName.toLowerCase() !== 'svg') {
    throw new Error('shapeFromSvg: input does not contain an <svg> root element.');
  }
  return root as unknown as SVGSVGElement;
}
