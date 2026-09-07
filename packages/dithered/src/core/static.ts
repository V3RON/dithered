import { sampleCells } from '../shape';
import { jsHitTester } from './path-hit-test';
import type { DitheredOptions } from './options';
import { resolveOptions, resolveRows, surfaceSize } from './options';
import { computeGeometry, paintFrame } from './paint';
import { escapeXml, formatNumber, svgPaintContext } from './svg-paint';

export interface RenderToSvgOptions extends DitheredOptions {
  /** Frame index to render, taken modulo `frames`. Default 0. */
  frame?: number;
  /** Decimal places in emitted coordinates. Default 3. */
  precision?: number;
  /** Emitted as `<title>`, for accessible inline SVG. Omitted when unset. */
  title?: string;
}

function wrapFrame(frame: number, count: number): number {
  return ((Math.round(frame) % count) + count) % count;
}

/**
 * Renders one frame of `options.shape` to a standalone SVG string, with
 * no DOM, canvas or Skia — running under plain Node, a Web Worker or an
 * edge runtime. Draws through the same {@link paintFrame} that the live
 * canvas/Skia renderers use (via {@link svgPaintContext}), so static and
 * live output cannot drift apart.
 *
 * The `viewBox` is `0 0 W H`, where `W`/`H` are `surfaceSize`'s CSS-pixel
 * size at `devicePixelRatio` 1 — the same CSS-pixel geometry the canvas
 * renderer displays (see `createDithered`'s scale-by-the-backing-store
 * derivation), so this matches the live output up to the half device
 * pixel that rounding the canvas's backing store can introduce, as well
 * as being resolution independent. `hitTest` defaults to {@link jsHitTester}, like
 * `sampleCells`.
 *
 * Throws if `options.shape`'s viewBox is degenerate (zero width or
 * height, making the aspect ratio non-finite) rather than emitting an
 * invalid `viewBox="0 0 Infinity …"` document.
 */
export function renderToSvg(options: RenderToSvgOptions): string {
  const { frame = 0, precision = 3, title, ...ditheredOptions } = options;
  const opts = resolveOptions(ditheredOptions);
  const { width, height } = surfaceSize(opts);
  if (!Number.isFinite(width) || width <= 0 || !Number.isFinite(height) || height <= 0) {
    const { width: vbWidth, height: vbHeight } = opts.shape.viewBox;
    throw new Error(
      `renderToSvg: shape has a degenerate viewBox (width ${vbWidth}, height ${vbHeight}); ` +
        'both must be finite and positive.',
    );
  }
  const rows = resolveRows(opts);
  const cells = sampleCells(opts.shape, opts.cols, opts.hitTest ?? jsHitTester(opts.shape), rows);
  const geometry = computeGeometry(opts, width, height);
  const frameCount = Math.max(1, opts.frames);
  const phase = wrapFrame(frame, frameCount) / frameCount;

  const ctx = svgPaintContext({ precision });
  paintFrame(ctx, cells, opts.brightness, phase, geometry);

  const fmt = (n: number) => formatNumber(n, precision);
  const titleMarkup = title ? `<title>${escapeXml(title)}</title>` : '';

  return (
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${fmt(width)} ${fmt(height)}" ` +
    `width="${fmt(width)}" height="${fmt(height)}">${titleMarkup}${ctx.toMarkup()}</svg>`
  );
}

/**
 * `renderToSvg`'s output as a `data:image/svg+xml;utf8,...` URL, ready to
 * use as a favicon `href`, an `<img src>`, or a CSS `background-image`.
 *
 * Percent-encodes `%` first, then `#`, `<`, `>`, `"`, `'`, `(`, `)`, `&`
 * and whitespace — enough to survive interpolation into a CSS `url(...)`
 * unquoted, and to keep `fg`'s default `#` from being read as a URL
 * fragment. The parentheses matter as much as `#` does: an unquoted CSS
 * `url()` token ends at the first `)`, so an `fg`/`bg` of e.g.
 * `rgb(130, 50, 255)` would otherwise truncate the declaration. `&`
 * matters for the other advertised use: pasted into an HTML `href`/`src`,
 * an unescaped `&` in the payload is decoded by the HTML parser (as
 * `&amp;` → `&`) before the data URL itself is decoded, leaving malformed
 * XML behind. A full `encodeURIComponent` would also work but roughly
 * triples the length of a favicon-sized SVG.
 */
export function renderToDataURL(options: RenderToSvgOptions): string {
  const svg = renderToSvg(options);
  return `data:image/svg+xml;utf8,${encodeForDataUrl(svg)}`;
}

function encodeForDataUrl(svg: string): string {
  return svg.replace(/[%#<>"'()&\s]/g, (ch) => {
    switch (ch) {
      case '%':
        return '%25';
      case '#':
        return '%23';
      case '<':
        return '%3C';
      case '>':
        return '%3E';
      case '"':
        return '%22';
      case "'":
        return '%27';
      case '(':
        return '%28';
      case ')':
        return '%29';
      case '&':
        return '%26';
      default:
        return encodeURIComponent(ch);
    }
  });
}
