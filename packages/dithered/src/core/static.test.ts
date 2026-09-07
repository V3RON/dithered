import { describe, expect, it, vi } from 'vitest';
import { createDithered } from '../renderer';
import { sampleCells } from '../shape';
import { shapes } from '../shapes';
import { makeFakeCanvas, stubAnimationGlobals } from '../test-utils';
import { computeGeometry, paintFrame } from './paint';
import { resolveOptions, resolveRows, surfaceSize } from './options';
import { svgPaintContext } from './svg-paint';
import { renderToDataURL, renderToSvg, type RenderToSvgOptions } from './static';

function parseSvg(markup: string): SVGSVGElement {
  const doc = new DOMParser().parseFromString(markup, 'image/svg+xml');
  const parserError = doc.querySelector('parsererror');
  expect(parserError, parserError?.textContent ?? '').toBeNull();
  return doc.documentElement as unknown as SVGSVGElement;
}

const ALL_ON: RenderToSvgOptions['brightness'] = () => true;

const BASE: RenderToSvgOptions = {
  shape: shapes.square,
  brightness: ALL_ON,
  cols: 4,
  size: 40,
  fg: '#8232ff',
};

describe('renderToSvg', () => {
  it('emits a well-formed <svg> root with the expected viewBox/width/height', () => {
    const svg = renderToSvg(BASE);
    const root = parseSvg(svg);
    const { width, height } = surfaceSize(resolveOptions(BASE));

    expect(root.tagName.toLowerCase()).toBe('svg');
    expect(root.getAttribute('viewBox')).toBe(`0 0 ${width} ${height}`);
    expect(root.getAttribute('width')).toBe(String(width));
    expect(root.getAttribute('height')).toBe(String(height));
  });

  it('emits exactly one <rect> per drawn cell, matching paintFrame driven into a recording context directly', () => {
    const opts = resolveOptions(BASE);
    const { width, height } = surfaceSize(opts);
    const cells = sampleCells(opts.shape, opts.cols, opts.hitTest, resolveRows(opts));
    const geometry = computeGeometry(opts, width, height);
    const expectedCtx = svgPaintContext();
    paintFrame(expectedCtx, cells, opts.brightness, 0, geometry);

    const svg = renderToSvg(BASE);
    const root = parseSvg(svg);

    expect(root.querySelectorAll('rect').length).toBe(cells.length);
    // The recording context driven directly and renderToSvg's own call
    // must produce byte-identical markup — same paintFrame, same inputs.
    expect(svg).toContain(expectedCtx.toMarkup());
  });

  it('emits no background rect when bg is "transparent" (the default)', () => {
    const svg = renderToSvg({ ...BASE, bg: 'transparent' });
    const root = parseSvg(svg);
    // Every rect must be a foreground (fg-colored) cell; none spans the
    // full surface at (0,0).
    for (const rect of Array.from(root.querySelectorAll('rect'))) {
      expect(!(rect.getAttribute('x') === '0' && rect.getAttribute('y') === '0')).toBe(true);
    }
  });

  it('emits one full-surface background rect when bg is set', () => {
    const opts = resolveOptions({ ...BASE, bg: '#fff' });
    const { width, height } = surfaceSize(opts);
    const svg = renderToSvg({ ...BASE, bg: '#fff' });
    const root = parseSvg(svg);
    const bgRect = Array.from(root.querySelectorAll('rect')).find(
      (r) => r.getAttribute('x') === '0' && r.getAttribute('y') === '0',
    );
    expect(bgRect).toBeDefined();
    expect(bgRect!.getAttribute('width')).toBe(String(width));
    expect(bgRect!.getAttribute('height')).toBe(String(height));
    expect(bgRect!.getAttribute('fill')).toBe('#fff');
  });

  it('different frame values produce different output for a frame-varying brightness', () => {
    const options: RenderToSvgOptions = {
      ...BASE,
      brightness: (cell, t) => cell.u < t - 0.5,
      frames: 4,
    };
    const frame0 = renderToSvg({ ...options, frame: 0 });
    const frame2 = renderToSvg({ ...options, frame: 2 });
    expect(frame0).not.toBe(frame2);
  });

  it('takes frame modulo frames', () => {
    const options: RenderToSvgOptions = {
      ...BASE,
      brightness: (cell, t) => cell.u < t - 0.5,
      frames: 4,
    };
    // frame 1 and frame 5 both land on phase 1/4; frame -1 and frame 3 both
    // land on phase 3/4; the two pairs differ from each other.
    expect(renderToSvg({ ...options, frame: 1 })).toBe(renderToSvg({ ...options, frame: 5 }));
    expect(renderToSvg({ ...options, frame: -1 })).toBe(renderToSvg({ ...options, frame: 3 }));
    expect(renderToSvg({ ...options, frame: 1 })).not.toBe(renderToSvg({ ...options, frame: 3 }));
  });

  it('renders <title> when given, escaped, and omits it otherwise', () => {
    const withTitle = renderToSvg({ ...BASE, title: 'A & B' });
    expect(withTitle).toContain('<title>A &amp; B</title>');

    const withoutTitle = renderToSvg(BASE);
    expect(withoutTitle).not.toContain('<title>');
  });

  it('is byte-identical across two calls with the same options', () => {
    expect(renderToSvg(BASE)).toBe(renderToSvg(BASE));
  });
});

describe('renderToDataURL', () => {
  it('starts with the expected prefix', () => {
    expect(renderToDataURL(BASE).startsWith('data:image/svg+xml;utf8,')).toBe(true);
  });

  it('percent-encodes # from a hex fg default', () => {
    const url = renderToDataURL(BASE);
    const payload = url.slice('data:image/svg+xml;utf8,'.length);
    expect(payload).toContain('%23');
    expect(payload).not.toContain('#');
  });

  it('decoding the payload reproduces renderToSvg output exactly', () => {
    const url = renderToDataURL(BASE);
    const payload = url.slice('data:image/svg+xml;utf8,'.length);
    expect(decodeURIComponent(payload)).toBe(renderToSvg(BASE));
  });

  it('survives interpolation into a CSS url(...) unquoted', () => {
    const url = renderToDataURL(BASE);
    // None of the characters that would end an unquoted CSS url(...) token
    // early (whitespace, parens implicitly via # 'fragment', quotes) may
    // appear unescaped in the payload.
    const payload = url.slice('data:image/svg+xml;utf8,'.length);
    expect(payload).not.toMatch(/[\s"'#]/);
    const css = `background-image: url(${url});`;
    expect(css).toContain(url);
  });
});

describe('no drift between createDithered and renderToSvg', () => {
  // Deliberately the library's own defaults (`shapes.rozenite`, `size:
  // 48`, `cols: 16`), not `shapes.square` at `size: 40, cols: 4`: that
  // fixture is aspect-ratio 1 with an integer surface width, so it is
  // exactly the one configuration where `Math.round`'s rounding and the
  // gap floor's unit both happen to be no-ops — the assertion below would
  // pass unconditionally on it even with the pre-fix absolute 0.6px
  // floor. `rozenite` is non-square (aspect != 1) and its surface width
  // at `size: 48` (33.60179977502813) is not an integer, so both of those
  // effects are actually exercised, at every `devicePixelRatio` the web
  // renderer can run at.
  it.each([1, 2, 3])(
    'draws the same cell rects, scaled by devicePixelRatio, for identical options (the no-drift guarantee) at dpr=%s',
    (dpr) => {
      const options: RenderToSvgOptions = {
        shape: shapes.rozenite,
        brightness: ALL_ON,
        size: 48,
        cols: 16,
      };
      const env = stubAnimationGlobals();
      vi.stubGlobal('devicePixelRatio', dpr);
      try {
        const { canvas, ctx } = makeFakeCanvas();
        // `createDithered` already blits `initialFrame` (0) synchronously on
        // create, so no explicit `renderFrame` call is needed here.
        createDithered(canvas, { ...options, cache: false });

        // `make2dCtx` has no `roundRect`, so `paintFrame` falls back to
        // `rect()` — the per-cell squares createDithered actually drew, in
        // device px. Divide by `dpr` to compare against the SVG's CSS px.
        const round = (n: number) => Math.round(n * 1000) / 1000;
        const canvasRects = ctx.rect.mock.calls
          .map(
            ([x, y, w, h]: number[]) =>
              `${round(x / dpr)},${round(y / dpr)},${round(w / dpr)},${round(h / dpr)}`,
          )
          .sort();

        const root = parseSvg(renderToSvg(options));
        const svgRects = Array.from(root.querySelectorAll('rect'))
          .map((r) => {
            const n = (attr: string) => round(Number(r.getAttribute(attr)));
            return `${n('x')},${n('y')},${n('width')},${n('height')}`;
          })
          .sort();

        expect(canvasRects).toEqual(svgRects);
        expect(canvasRects.length).toBeGreaterThan(0);
      } finally {
        env.restore();
      }
    },
  );
});
