import type { FillRule } from '../shape';
import { parsePath, readNumberToken, serializePath, toAbsolute, transformSegments } from './path';
import { basicShapeToPath } from './svg-shapes';
import { IDENTITY, isIdentity, multiply, parseTransform, type Matrix } from './transform';

/**
 * A read-only view of one SVG element, decoupled from any particular
 * parser. `svg.ts` wraps DOM `Element`s in one of these; `svg-lite.ts`
 * builds a tree of them by scanning source text. {@link collectGeometry}
 * is the only thing that walks this tree, so the two loaders share every
 * rule after they produce one.
 */
export interface SvgNode {
  /** Lower-cased local name, namespace prefix stripped. */
  tag: string;
  /** Attribute lookup; names are case-sensitive, as in SVG. */
  attr(name: string): string | null;
  children: readonly SvgNode[];
}

/** Elements whose geometry is a definition or metadata, never painted where it stands. */
const NON_RENDERED_CONTAINERS = new Set([
  'defs',
  'clippath',
  'mask',
  'symbol',
  'pattern',
  'marker',
  'style',
  'script',
  'title',
  'desc',
  'metadata',
  // Its children are XHTML, not SVG geometry — descending into it would
  // leak foreign markup the same way <defs> would leak a definition.
  'foreignobject',
]);

/** Drawable in SVG, but out of scope here — recorded so the "nothing found" error can name them. */
const UNSUPPORTED_DRAWABLES = new Set(['use', 'text', 'image']);

/** Geometry elements this loader knows how to turn into path data. */
const GEOMETRY_TAGS = new Set(['path', 'rect', 'circle', 'ellipse', 'polygon', 'polyline', 'line']);

interface Inherited {
  ctm: Matrix;
  fill: string;
  stroke: string;
  fillRule: FillRule;
}

interface Walked {
  paths: string[];
  fillRules: Set<FillRule>;
  unsupportedTags: Set<string>;
}

/**
 * Walks an `SvgNode` tree and concatenates its geometry into one path
 * string, applying the skip rules and transform baking from ADR 0010:
 * `<defs>`/`<clipPath>`/`<mask>`/... and `display="none"` subtrees are
 * skipped, basic shapes are converted to path data, ancestor `transform`s
 * are composed and baked into coordinates, and `fill-rule` is resolved
 * across every contributing element.
 *
 * @param root The document's root `<svg>` element. Its own `transform`
 *   (if present — design tools do not emit one) is ignored; its `fill`
 *   and `stroke` still apply, since Figma commonly declares `fill="none"`
 *   on the root and sets it per-element.
 * @param label The caller's function name, used to prefix error messages
 *   (`shapeFromSvg:` / `shapeFromSvgLite:`).
 */
export function collectGeometry(
  root: SvgNode,
  label: string,
): { path: string; fillRule?: FillRule } {
  const walked: Walked = { paths: [], fillRules: new Set(), unsupportedTags: new Set() };

  // A display="none" root hides the entire document, same as it would on
  // any descendant (ADR §7.2) — `walk` never sees the root itself to
  // apply that rule to, so it's checked here instead.
  if (root.attr('display') !== 'none') {
    const base: Inherited = {
      ctm: IDENTITY,
      fill: root.attr('fill') ?? 'black',
      stroke: root.attr('stroke') ?? 'none',
      fillRule: root.attr('fill-rule') === 'evenodd' ? 'evenodd' : 'nonzero',
    };
    for (const child of root.children) {
      walk(child, base, walked, label);
    }
  }

  if (walked.paths.length === 0) {
    if (walked.unsupportedTags.size > 0) {
      const tags = [...walked.unsupportedTags].sort().map((t) => `<${t}>`);
      throw new Error(
        `${label}: this SVG's geometry is all ${tags.join('/')}, which is not supported. ` +
          'Expand symbols and convert text to outlines in your editor, then re-export.',
      );
    }
    throw new Error(
      `${label}: no drawable geometry was found ` +
        '(supported: <path>, <rect>, <circle>, <ellipse>, <polygon>, <polyline>).',
    );
  }

  if (walked.fillRules.size > 1) {
    const rules = [...walked.fillRules].sort().join('" and "');
    throw new Error(
      `${label}: this SVG mixes fill-rule "${rules}" across elements, which can't be represented ` +
        'in one Shape. Split the file, or normalize fill-rule in your editor, then re-export.',
    );
  }

  const fillRule = walked.fillRules.has('evenodd') ? ('evenodd' as const) : undefined;
  return { path: walked.paths.join(' '), ...(fillRule ? { fillRule } : {}) };
}

function walk(node: SvgNode, inherited: Inherited, walked: Walked, label: string): void {
  const tag = node.tag;

  if (node.attr('display') === 'none') return; // hidden container, whole subtree skipped
  if (NON_RENDERED_CONTAINERS.has(tag)) return; // definition/metadata subtree, never painted

  const ctm = multiply(inherited.ctm, parseNodeTransform(node, label));
  const fill = node.attr('fill') ?? inherited.fill;
  const stroke = node.attr('stroke') ?? inherited.stroke;
  const fillRuleAttr = node.attr('fill-rule');
  const fillRule: FillRule =
    fillRuleAttr === 'evenodd'
      ? 'evenodd'
      : fillRuleAttr === 'nonzero'
        ? 'nonzero'
        : inherited.fillRule;
  const state: Inherited = { ctm, fill, stroke, fillRule };

  if (UNSUPPORTED_DRAWABLES.has(tag)) {
    walked.unsupportedTags.add(tag);
    return;
  }

  if (GEOMETRY_TAGS.has(tag)) {
    if (fill === 'none' && stroke === 'none') return; // paint-invisible leaf
    const d = geometryPath(tag, node);
    if (d === null) return; // zero-area / degenerate, not an error
    walked.paths.push(bakeTransform(forceAbsoluteLeadingMoveto(d), ctm, label));
    walked.fillRules.add(fillRule);
    return;
  }

  // `<g>`, `<a>`, `<switch>`, the root `<svg>` nested elsewhere, and any
  // unrecognized container: descend, carrying the composed state down.
  for (const child of node.children) {
    walk(child, state, walked, label);
  }
}

function geometryPath(tag: string, node: SvgNode): string | null {
  if (tag === 'path') {
    const d = node.attr('d');
    return d && d.trim() ? d : null;
  }
  if (tag === 'line') return null; // zero area: can never add a cell
  return basicShapeToPath(tag, (name) => node.attr(name));
}

/**
 * Rewrites `d`'s leading moveto to absolute `M`, if it was written as a
 * relative `m`. In the source document an element's path data starts its
 * own path, and SVG treats a leading `m` as identical to `M` there (there
 * is no current point yet — the implicit start is `(0,0)`, same as right
 * after an absolute `M 0 0`). Spliced into the concatenated output that
 * same `m` would instead resolve against the *previous* element's current
 * point, displacing the whole subpath (see ADR 0010's Consequences).
 *
 * Per SVG 1.1 §8.3.2, though, only that first coordinate pair is absolute:
 * any further pairs following a lone leading `m` are an *implicit repeat*,
 * read as relative linetos. Simply swapping the command letter to `M`
 * would silently make those absolute too, so when such a repeat is
 * present an explicit `l` is inserted right after the leading pair —
 * `l`'s own implicit repeats stay relative, so this preserves every later
 * pair's original (relative) meaning. Everything else — the coordinates
 * themselves, and every command after the first — is untouched, so
 * already-absolute path data (what `basicShapeToPath` emits, and what
 * most design tools emit) round-trips byte-identical, and so does a
 * leading `m` with only a single pair.
 */
function forceAbsoluteLeadingMoveto(d: string): string {
  const leading = d.match(/^\s*/)?.[0].length ?? 0;
  if (d[leading] !== 'm') return d;

  const isSeparator = (ch: string | undefined) =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',';
  const skipSeparators = (i: number) => {
    while (isSeparator(d[i])) i++;
    return i;
  };

  // Locate the end of the leading pair so an "l" can be inserted after it
  // if an implicit repeat follows. Malformed data (too few numbers) is
  // left to fail later, in `parsePath`, exactly as an `M`-leading path
  // with the same problem already does — this rewrite doesn't validate.
  const first = readNumberToken(d, skipSeparators(leading + 1));
  const second = first && readNumberToken(d, skipSeparators(first.end));
  if (!second) return d.slice(0, leading) + 'M' + d.slice(leading + 1);

  const afterPair = skipSeparators(second.end);
  const hasImplicitRepeat = readNumberToken(d, afterPair) !== null;
  return (
    d.slice(0, leading) +
    'M' +
    d.slice(leading + 1, afterPair) +
    (hasImplicitRepeat ? 'l' : '') +
    d.slice(afterPair)
  );
}

function parseNodeTransform(node: SvgNode, label: string): Matrix {
  const raw = node.attr('transform');
  if (!raw) return IDENTITY;
  try {
    return parseTransform(raw);
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}

/**
 * Bakes `ctm` into `d`'s coordinates. An identity matrix returns `d`
 * unchanged — no re-parse, no re-serialize — so untransformed geometry
 * (the common case) keeps today's output byte-identical.
 */
function bakeTransform(d: string, ctm: Matrix, label: string): string {
  if (isIdentity(ctm)) return d;
  try {
    const segments = transformSegments(toAbsolute(parsePath(d)), ctm);
    return serializePath(segments);
  } catch (err) {
    throw new Error(`${label}: ${(err as Error).message}`);
  }
}
