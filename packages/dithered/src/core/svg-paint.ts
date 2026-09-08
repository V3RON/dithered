import type { PaintContext } from './paint';

/**
 * A {@link PaintContext} that records `<rect>` elements instead of
 * rasterizing them, so `paintFrame` — the single source of truth for
 * what a frame looks like — can drive static SVG output as well as a
 * live canvas/Skia surface.
 */
export interface SvgPaintContext extends PaintContext {
  /** Serialized child elements, in paint order. */
  toMarkup(): string;
}

interface PendingShape {
  x: number;
  y: number;
  w: number;
  h: number;
  /** Present (possibly 0) only when the shape came from `roundRect`. */
  rx?: number;
}

interface FillRun {
  fill: string;
  shapes: PendingShape[];
}

/**
 * Rounds `n` to `precision` decimals and strips trailing zeros, so output
 * is compact and byte-stable across runs.
 *
 * Throws rather than emitting `NaN`/`Infinity` verbatim into an
 * attribute, which `toFixed` would otherwise happily stringify into an
 * invalid document (e.g. a degenerate viewBox making `aspectOf` return
 * `Infinity`). Callers with a more specific diagnosis — `renderToSvg`'s
 * own degenerate-viewBox check — should throw first, so this is a last
 * line of defense, not the primary error message.
 */
export function formatNumber(n: number, precision: number): string {
  if (!Number.isFinite(n)) {
    throw new Error(`formatNumber: cannot format a non-finite number (${n}).`);
  }
  let s = (n === 0 ? 0 : n).toFixed(Math.max(0, precision));
  if (s.includes('.')) {
    s = s.replace(/0+$/, '').replace(/\.$/, '');
  }
  return s === '-0' || s === '' ? '0' : s;
}

/** Escapes the four characters that can break an XML/SVG attribute value: `&`, `<`, `>`, `"`. */
export function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function fillOf(style: string | object): string {
  return typeof style === 'string' ? style : '#000';
}

function pushShape(runs: FillRun[], shape: PendingShape, fill: string): void {
  const last = runs[runs.length - 1];
  if (last && last.fill === fill) {
    last.shapes.push(shape);
  } else {
    runs.push({ fill, shapes: [shape] });
  }
}

function rectMarkup(shape: PendingShape, precision: number, fillAttr: string | null): string {
  const fmt = (n: number) => formatNumber(n, precision);
  const attrs = [
    `x="${fmt(shape.x)}"`,
    `y="${fmt(shape.y)}"`,
    `width="${fmt(shape.w)}"`,
    `height="${fmt(shape.h)}"`,
  ];
  if (shape.rx !== undefined) attrs.push(`rx="${fmt(shape.rx)}"`);
  if (fillAttr !== null) attrs.push(`fill="${escapeXml(fillAttr)}"`);
  return `<rect ${attrs.join(' ')}/>`;
}

function serialize(runs: FillRun[], precision: number): string {
  return runs
    .map((run) => {
      if (run.shapes.length === 1) {
        return rectMarkup(run.shapes[0], precision, run.fill);
      }
      const inner = run.shapes.map((s) => rectMarkup(s, precision, null)).join('');
      return `<g fill="${escapeXml(run.fill)}">${inner}</g>`;
    })
    .join('');
}

/**
 * A recording {@link PaintContext}: `fillRect` emits a `<rect>`
 * immediately (this is how `paintFrame` paints `bg`), `beginPath` clears
 * the pending shape, `rect`/`roundRect` record it, and `fill` emits it
 * with the fill style current at that moment. `roundRect` is
 * implemented, so SVG output always takes the rounded-rect branch.
 *
 * Consecutive elements sharing a fill are wrapped in one `<g fill>`,
 * shrinking output and grouping tones for the palette work; a run of one
 * gets its `fill` attribute directly on the `<rect>` instead.
 */
export function svgPaintContext(options: { precision?: number } = {}): SvgPaintContext {
  const precision = options.precision ?? 3;
  const runs: FillRun[] = [];
  let pending: PendingShape | null = null;

  const ctx: SvgPaintContext = {
    fillStyle: '#000',
    fillRect(x, y, w, h) {
      pushShape(runs, { x, y, w, h }, fillOf(ctx.fillStyle));
    },
    beginPath() {
      pending = null;
    },
    rect(x, y, w, h) {
      pending = { x, y, w, h };
    },
    roundRect(x, y, w, h, radius) {
      pending = { x, y, w, h, rx: radius };
    },
    fill() {
      if (!pending) return;
      pushShape(runs, pending, fillOf(ctx.fillStyle));
      pending = null;
    },
    toMarkup() {
      return serialize(runs, precision);
    },
  };

  return ctx;
}
