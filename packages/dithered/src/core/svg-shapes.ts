/**
 * Converts one SVG basic-shape element to path data. Platform-free: the
 * element is read through a plain attribute getter rather than a DOM
 * node, so this works identically for the DOM (`svg.ts`) and text-scanned
 * (`svg-lite.ts`) loaders — see `svg-tree.ts`, which calls this per
 * element during the shared traversal.
 *
 * Geometry rules follow SVG 2's "equivalent path" definitions rather
 * than being invented, including its degenerate-input handling: an
 * invalid or non-positive dimension is not an error, it just means the
 * element paints nothing, so this returns `null` (skip) rather than
 * throwing.
 */
export type AttrGetter = (name: string) => string | null;

/**
 * @param tag Lower-cased element name — see `SvgNode.tag` in `svg-tree.ts`.
 * @returns Path `d` data, or `null` if the element is degenerate (zero
 *   area, missing required attributes) and should be skipped.
 */
export function basicShapeToPath(tag: string, attr: AttrGetter): string | null {
  switch (tag) {
    case 'rect':
      return rectToPath(attr);
    case 'circle':
      return circleToPath(attr);
    case 'ellipse':
      return ellipseToPath(attr);
    case 'polygon':
      return polyPointsToPath(attr, true);
    case 'polyline':
      return polyPointsToPath(attr, false);
    default:
      return null;
  }
}

/** A numeric attribute; `null` for missing, blank, `"auto"`, or unparseable. */
function numAttr(attr: AttrGetter, name: string): number | null {
  const raw = attr(name);
  if (raw === null) return null;
  const trimmed = raw.trim();
  if (trimmed === '' || trimmed.toLowerCase() === 'auto') return null;
  const value = Number(trimmed);
  return Number.isNaN(value) ? null : value;
}

function rectToPath(attr: AttrGetter): string | null {
  const x = numAttr(attr, 'x') ?? 0;
  const y = numAttr(attr, 'y') ?? 0;
  const width = numAttr(attr, 'width');
  const height = numAttr(attr, 'height');
  if (width === null || height === null || width <= 0 || height <= 0) return null;

  // rx/ry: absent or negative -> "auto" (falls back to the other, or 0);
  // present on one but not the other -> mirrored, then each clamped to
  // half its side, which is what keeps a pill-shaped `rect rx="999"`
  // from producing self-crossing corners.
  let rx = numAttr(attr, 'rx');
  let ry = numAttr(attr, 'ry');
  if (rx !== null && rx < 0) rx = null;
  if (ry !== null && ry < 0) ry = null;
  if (rx === null && ry !== null) rx = ry;
  if (ry === null && rx !== null) ry = rx;
  rx = Math.min(rx ?? 0, width / 2);
  ry = Math.min(ry ?? 0, height / 2);

  if (rx === 0 || ry === 0) {
    return `M ${x} ${y} H ${x + width} V ${y + height} H ${x} Z`;
  }

  // Clockwise from just right of the top-left corner (SVG 2's equivalent path).
  return (
    `M ${x + rx} ${y} ` +
    `H ${x + width - rx} ` +
    `A ${rx} ${ry} 0 0 1 ${x + width} ${y + ry} ` +
    `V ${y + height - ry} ` +
    `A ${rx} ${ry} 0 0 1 ${x + width - rx} ${y + height} ` +
    `H ${x + rx} ` +
    `A ${rx} ${ry} 0 0 1 ${x} ${y + height - ry} ` +
    `V ${y + ry} ` +
    `A ${rx} ${ry} 0 0 1 ${x + rx} ${y} Z`
  );
}

function circleToPath(attr: AttrGetter): string | null {
  const cx = numAttr(attr, 'cx') ?? 0;
  const cy = numAttr(attr, 'cy') ?? 0;
  const r = numAttr(attr, 'r');
  if (r === null || r <= 0) return null;
  return twoArcCircle(cx, cy, r, r);
}

function ellipseToPath(attr: AttrGetter): string | null {
  const cx = numAttr(attr, 'cx') ?? 0;
  const cy = numAttr(attr, 'cy') ?? 0;
  let rx = numAttr(attr, 'rx');
  let ry = numAttr(attr, 'ry');
  // A single resolved radius applies to both axes (SVG 2's `rx`/`ry` auto rule).
  if (rx === null && ry !== null) rx = ry;
  if (ry === null && rx !== null) ry = rx;
  if (rx === null || ry === null || rx <= 0 || ry <= 0) return null;
  return twoArcCircle(cx, cy, rx, ry);
}

/** `M cx+rx,cy A rx,ry 0 0 1 cx-rx,cy A rx,ry 0 0 1 cx+rx,cy Z` — two half-arcs. */
function twoArcCircle(cx: number, cy: number, rx: number, ry: number): string {
  return (
    `M ${cx + rx} ${cy} ` +
    `A ${rx} ${ry} 0 0 1 ${cx - rx} ${cy} ` +
    `A ${rx} ${ry} 0 0 1 ${cx + rx} ${cy} Z`
  );
}

function polyPointsToPath(attr: AttrGetter, closed: boolean): string | null {
  const raw = attr('points');
  if (!raw) return null;

  const tokens = raw
    .trim()
    .split(/[\s,]+/)
    .filter((s) => s.length > 0);
  // A trailing odd coordinate is dropped, same as a renderer parsing up to the error.
  const coordCount = tokens.length - (tokens.length % 2);
  if (coordCount < 4) return null;

  const numbers: number[] = [];
  for (let i = 0; i < coordCount; i++) {
    const value = Number(tokens[i]);
    if (Number.isNaN(value)) return null;
    numbers.push(value);
  }

  let d = `M ${numbers[0]} ${numbers[1]}`;
  for (let i = 2; i < numbers.length; i += 2) {
    d += ` L ${numbers[i]} ${numbers[i + 1]}`;
  }
  if (closed) d += ' Z';
  return d;
}
