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
 * may be single- or double-quoted, tag names are matched
 * case-insensitively, line endings are normalized and numeric/predefined
 * character references (`&#xA;`, `&amp;`, ...) are expanded in attribute
 * values, same as a real parser. It does *not* implement XML — a `>`
 * inside an attribute value will confuse it (harmless in practice: path
 * data and viewBox values never contain one). On the web, prefer
 * `shapeFromSvg`, which delegates to a real parser.
 *
 * @param svg An SVG source string.
 */
export function shapeFromSvgLite(svg: string): Shape {
  const source = stripNonMarkup(normalizeLineEndings(svg));
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

/**
 * XML's end-of-line handling (XML 1.0 §2.11): every CRLF pair, and every
 * lone CR, is normalized to a single LF *before* anything else parses the
 * document — including before attribute-value normalization. Applied here
 * to the whole source, up front, rather than inside `normalizeAttrValue`,
 * so it runs exactly once and in the right order: a real `DOMParser` folds
 * `\r\n` into one `\n`, not the two spaces a naive one-for-one
 * whitespace-to-space replacement of an unnormalized CRLF would produce.
 */
function normalizeLineEndings(svg: string): string {
  return svg.replace(/\r\n?/g, '\n');
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
    attrs.set(match[1], normalizeAttrValue(match[3] ?? match[4] ?? ''));
  }
  return attrs;
}

/** `&name;` -> character, for the five entities XML predefines without a DTD. */
const PREDEFINED_ENTITIES: Record<string, string> = {
  amp: '&',
  lt: '<',
  gt: '>',
  quot: '"',
  apos: "'",
};

/** `&#nn;` (decimal), `&#xNN;` (hex, lowercase `x` per the XML grammar), or `&name;`. */
const ENTITY_RE = /&(?:#x([0-9a-fA-F]+)|#([0-9]+)|([a-zA-Z]+));/g;

/**
 * XML attribute-value normalization (XML 1.0 §3.3.3), applied in the same
 * two steps and the same order a real `DOMParser` uses:
 *
 * 1. Every literal tab or newline in the attribute's raw text becomes a
 *    single space — not just whitespace-collapsing, a one-for-one
 *    replacement — so a multi-line `d` (routine in hand-written and
 *    Illustrator-exported SVG) reads the same path data through both
 *    loaders instead of `shapeFromSvgLite` leaking raw newlines that
 *    `shapeFromSvg` never sees. (A literal `\r` can't reach here: line-
 *    ending normalization already folded every `\r\n`/`\r` in the source
 *    to `\n` before tags were even found — see `normalizeLineEndings` —
 *    which is the order XML itself specifies. The pattern below still
 *    matches `\r` too, purely as a defensive no-op.)
 * 2. Character references (`&#nn;`, `&#xNN;`) and the five predefined
 *    entities are expanded *after* step 1, so a reference to a whitespace
 *    character — `&#xA;` is the one that actually shows up in hand-written
 *    `d` data — comes through as the literal character it names, not
 *    collapsed to a space the way a literal newline in the source is. An
 *    unrecognized named entity (there is no DTD here to define one), or a
 *    numeric reference to a code point outside Unicode's range, is left as
 *    written, rather than throwing, matching this scanner's general
 *    tolerance of malformed input.
 */
function normalizeAttrValue(value: string): string {
  const whitespaceNormalized = value.replace(/[\t\n\r]/g, ' ');
  return whitespaceNormalized.replace(ENTITY_RE, (match, hex, dec, name) => {
    const codePoint =
      hex !== undefined ? parseInt(hex, 16) : dec !== undefined ? parseInt(dec, 10) : undefined;
    if (codePoint !== undefined)
      return codePoint <= 0x10ffff ? String.fromCodePoint(codePoint) : match;
    return PREDEFINED_ENTITIES[name] ?? match;
  });
}
