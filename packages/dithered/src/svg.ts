import { collectGeometry, type SvgNode } from './core/svg-tree';
import type { Shape } from './shape';

/**
 * Builds a {@link Shape} from an SVG document: reads the root `viewBox`
 * attribute, then walks the tree collecting geometry in document order —
 * `<path>` verbatim, `<rect>` (including `rx`/`ry`), `<circle>`,
 * `<ellipse>`, `<polygon>` and `<polyline>` converted to path data — and
 * concatenates it all into one path string.
 *
 * `transform` on an element or an ancestor `<g>` is composed and baked
 * into that element's coordinates. `<defs>`, `<clipPath>`, `<mask>` and
 * similar non-rendered containers are skipped, as is anything hidden via
 * `display="none"` or paint-invisible (`fill="none"` with no stroke).
 * `fill-rule="evenodd"` is carried onto the resulting `Shape` when every
 * contributing element agrees on it; a document that mixes the two rules
 * throws, since one `Shape` can't represent both.
 *
 * `<use>`, `<text>` and `<image>` are not supported — see `svg-tree.ts`
 * for the full set of rules, shared verbatim with `shapeFromSvgLite`.
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

  const { path, fillRule } = collectGeometry(new DomSvgNode(root), 'shapeFromSvg');

  return { path, viewBox: { x, y, width, height }, ...(fillRule ? { fillRule } : {}) };
}

/** Adapts a DOM `Element` to the parser-agnostic {@link SvgNode} `collectGeometry` walks. */
class DomSvgNode implements SvgNode {
  constructor(private readonly el: Element) {}

  get tag(): string {
    return this.el.localName.toLowerCase();
  }

  attr(name: string): string | null {
    return this.el.getAttribute(name);
  }

  get children(): readonly SvgNode[] {
    return Array.from(this.el.children).map((child) => new DomSvgNode(child));
  }
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
