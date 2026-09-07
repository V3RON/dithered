import type { Shape } from './shape';

/**
 * A DOM-free {@link shapeFromSvg}. Same contract — read the root
 * `viewBox`, concatenate every `<path>`'s `d` — implemented by scanning
 * the source text rather than parsing it, so it runs under React Native
 * (and anywhere else without `DOMParser`).
 *
 * The trade-off is strictness. This handles well-formed SVG as emitted by
 * design tools: comments and CDATA sections are skipped, attribute values
 * may be single- or double-quoted, and tag names are matched
 * case-insensitively. It does *not* implement XML — entity references are
 * not expanded, and a `>` inside an attribute value will confuse it
 * (harmless in practice: path data and viewBox values never contain one).
 * On the web, prefer `shapeFromSvg`, which delegates to a real parser.
 *
 * @param svg An SVG source string.
 */
export function shapeFromSvgLite(svg: string): Shape {
  const source = stripNonMarkup(svg);

  const rootTag = /<svg\b[^>]*>/i.exec(source);
  if (!rootTag) {
    throw new Error('shapeFromSvgLite: input does not contain an <svg> root element.');
  }

  const viewBoxAttr = readAttribute(rootTag[0], 'viewBox');
  if (!viewBoxAttr) {
    throw new Error('shapeFromSvgLite: <svg> is missing a viewBox attribute.');
  }
  const parts = viewBoxAttr
    .trim()
    .split(/[\s,]+/)
    .map(Number);
  if (parts.length !== 4 || parts.some((n) => Number.isNaN(n))) {
    throw new Error(`shapeFromSvgLite: could not parse viewBox "${viewBoxAttr}".`);
  }
  const [x, y, width, height] = parts as [number, number, number, number];

  const paths: string[] = [];
  for (const match of source.matchAll(/<path\b[^>]*>/gi)) {
    const d = readAttribute(match[0], 'd');
    if (d) paths.push(d);
  }
  const path = paths.join(' ');

  if (!path) {
    throw new Error(
      'shapeFromSvgLite: no <path> elements with a `d` attribute were found (only <path> is supported).',
    );
  }

  return { path, viewBox: { x, y, width, height } };
}

/** Drops comments and CDATA so their contents can't be mistaken for markup. */
function stripNonMarkup(svg: string): string {
  return svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
}

/**
 * Reads one attribute out of a start tag. Attribute names in SVG are
 * case-sensitive (`viewBox`, not `viewbox`), so the match is too.
 */
function readAttribute(tag: string, name: string): string | null {
  const match = new RegExp(`\\b${name}\\s*=\\s*("([^"]*)"|'([^']*)')`).exec(tag);
  if (!match) return null;
  return match[2] ?? match[3] ?? null;
}
