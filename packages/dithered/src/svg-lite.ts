import { collectGeometry, type SvgNode } from './core/svg-tree';
import type { Shape } from './shape';

/**
 * A DOM-free {@link shapeFromSvg}. Same contract — read the root
 * `viewBox`, walk the tree collecting `<path>`/`<rect>`/`<circle>`/
 * `<ellipse>`/`<polygon>`/`<polyline>` geometry (with `transform` baked
 * in) into one path string — implemented by scanning the source text
 * into a tree rather than parsing it with a real XML/DOM parser, so it
 * runs under React Native (and anywhere else without `DOMParser`). See
 * `shapeFromSvg`'s doc comment and `svg-tree.ts` for the shared rules.
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
  const root = buildTree(source);
  if (!root || root.tag !== 'svg') {
    throw new Error('shapeFromSvgLite: input does not contain an <svg> root element.');
  }

  const viewBoxAttr = root.attr('viewBox');
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

  const { path, fillRule } = collectGeometry(root, 'shapeFromSvgLite');

  return { path, viewBox: { x, y, width, height }, ...(fillRule ? { fillRule } : {}) };
}

/** Drops comments and CDATA so their contents can't be mistaken for markup. */
function stripNonMarkup(svg: string): string {
  return svg.replace(/<!--[\s\S]*?-->/g, '').replace(/<!\[CDATA\[[\s\S]*?\]\]>/g, '');
}

/** One element in the tree {@link buildTree} scans out of source text. */
class LiteSvgNode implements SvgNode {
  readonly children: LiteSvgNode[] = [];

  constructor(
    readonly tag: string,
    private readonly attrs: ReadonlyMap<string, string>,
  ) {}

  attr(name: string): string | null {
    return this.attrs.has(name) ? (this.attrs.get(name) as string) : null;
  }
}

// A start, self-closing, or end tag: `<`, optional `/`, a name, its
// attribute text (deliberately permissive — validated attribute-by-
// attribute in `parseAttrs`), an optional trailing `/`, then `>`.
const TAG_RE = /<(\/)?([a-zA-Z][\w:.-]*)([^>]*?)(\/)?>/g;

/**
 * Scans `source` into a tree of {@link LiteSvgNode}s with a start/end tag
 * stack, tolerating the same things `shapeFromSvgLite` always has: either
 * quote style, case-insensitive tag names. An unmatched end tag pops back
 * to the nearest ancestor with that name rather than throwing, since a
 * best-effort recovery is more useful here than a parse error over a
 * stray closing tag.
 */
function buildTree(source: string): LiteSvgNode | null {
  const stack: LiteSvgNode[] = [];
  let root: LiteSvgNode | null = null;

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(source))) {
    const [, closing, rawName, attrsText, selfClosing] = match;
    const tag = localName(rawName).toLowerCase();

    if (closing) {
      for (let i = stack.length - 1; i >= 0; i--) {
        if (stack[i].tag === tag) {
          stack.length = i;
          break;
        }
      }
      continue;
    }

    const node = new LiteSvgNode(tag, parseAttrs(attrsText));
    if (stack.length > 0) {
      stack[stack.length - 1].children.push(node);
    } else if (!root) {
      root = node;
    }
    if (!selfClosing) {
      stack.push(node);
    }
  }

  return root;
}

/** Strips a namespace prefix (`svg:path` -> `path`), as `SvgNode.tag` requires. */
function localName(rawName: string): string {
  const i = rawName.indexOf(':');
  return i === -1 ? rawName : rawName.slice(i + 1);
}

const ATTR_RE = /([:\w-]+)\s*=\s*("([^"]*)"|'([^']*)')/g;

/** Reads every `name="value"` (or `'value'`) pair out of a start tag's attribute text. */
function parseAttrs(text: string): Map<string, string> {
  const attrs = new Map<string, string>();
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(text))) {
    attrs.set(match[1], match[3] ?? match[4] ?? '');
  }
  return attrs;
}
