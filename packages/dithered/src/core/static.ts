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
 * size at `devicePixelRatio` 1 — the same numbers the canvas renderer
 * draws at, so this is byte-comparable with the live output as well as
 * resolution independent. `hitTest` defaults to {@link jsHitTester}, like
 * `sampleCells`.
 */
export function renderToSvg(options: RenderToSvgOptions): string {
  const { frame = 0, precision = 3, title, ...ditheredOptions } = options;
  const opts = resolveOptions(ditheredOptions);
  const { width, height } = surfaceSize(opts);
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
 * Percent-encodes `%` first, then `#`, `<`, `>`, `"`, `'` and whitespace
 * — enough to survive interpolation into a CSS `url(...)` unquoted, and
 * to keep `fg`'s default `#` from being read as a URL fragment. A full
 * `encodeURIComponent` would also work but roughly triples the length of
 * a favicon-sized SVG.
 */
export function renderToDataURL(options: RenderToSvgOptions): string {
  const svg = renderToSvg(options);
  return `data:image/svg+xml;utf8,${encodeForDataUrl(svg)}`;
}

function encodeForDataUrl(svg: string): string {
  return svg.replace(/[%#<>"'\s]/g, (ch) => {
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
      default:
        return encodeURIComponent(ch);
    }
  });
}
