import { describe, expect, it, vi } from 'vitest';
import { createDithered } from '../renderer';
import { sampleCells } from '../shape';
import { shapes } from '../shapes';
import { make2dCtx, makeFakeCanvas, stubAnimationGlobals, stubGetContext } from '../test-utils';
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

  it('throws a named error on a degenerate viewBox rather than emitting an invalid document', () => {
    // A zero-height viewBox makes `aspectOf` (width / height) return
    // `Infinity`, which would otherwise flow straight into
    // `viewBox="0 0 Infinity 40"`.
    const zeroHeight = {
      ...BASE,
      shape: { path: 'M0 0 H10 Z', viewBox: { x: 0, y: 0, width: 10, height: 0 } },
    };
    expect(() => renderToSvg(zeroHeight)).toThrow(/degenerate viewBox/);

    const zeroWidth = {
      ...BASE,
      shape: { path: 'M0 0 V10 Z', viewBox: { x: 0, y: 0, width: 0, height: 10 } },
    };
    expect(() => renderToSvg(zeroWidth)).toThrow(/degenerate viewBox/);
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
    // early (whitespace, parens, '&' before an HTML parser gets to it,
    // quotes) may appear unescaped in the payload.
    const payload = url.slice('data:image/svg+xml;utf8,'.length);
    expect(payload).not.toMatch(/[\s"'#()&]/);
    const css = `background-image: url(${url});`;
    expect(css).toContain(url);
  });

  it('escapes parentheses in fg and & in title, so both round-trip through url(...) and HTML unescaping', () => {
    // BASE's only colour is the hex literal '#8232ff' — no fixture whose
    // colours are hex-only can ever contain a paren or an '&', so this
    // exercises both with values that actually do.
    const options: RenderToSvgOptions = {
      ...BASE,
      fg: 'rgb(130, 50, 255)',
      title: 'a & b',
    };
    const url = renderToDataURL(options);
    const payload = url.slice('data:image/svg+xml;utf8,'.length);

    // The negative character class here must include '(', ')' and '&':
    // a fixture whose only colour is a hex literal (as the old version
    // of the test above used) can never fail on any of them.
    expect(payload).not.toMatch(/[\s"'#()&]/);
    expect(decodeURIComponent(payload)).toBe(renderToSvg(options));

    // An unquoted CSS url() token ends at the first raw ')' — the data
    // URL must appear whole inside it.
    const css = `background-image: url(${url});`;
    expect(css).toContain(url);

    // Pasted into an HTML attribute, an unescaped '&' in the payload
    // would be decoded to '&' by the HTML parser before the data URL
    // itself is decoded, corrupting the XML. Simulate that decode step.
    const htmlDecoded = url.replace(/&amp;/g, '&');
    expect(htmlDecoded).toBe(url); // no raw '&amp;' substring to decode
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
  const FIXTURE = { shape: shapes.rozenite, size: 48, cols: 16, frames: 8 } as const;

  // Frame-varying, unlike `ALL_ON`: with every cell drawn on every phase,
  // a uniform phase offset between `createDithered` and `renderToSvg`
  // (e.g. `renderToSvg` rendering the *next* frame's phase) draws the
  // exact same cells at every frame and passes unnoticed. `cell.u` ranges
  // over [-0.5, 0.5) and phase `t` over [0, 1), so this threshold sweeps
  // a genuinely different subset of cells in as `t` increases, making
  // cell *selection* — not just geometry — comparable across frames.
  const VARYING: RenderToSvgOptions['brightness'] = (cell, t) => cell.u < t - 0.5;
  const FRAMES_TO_CHECK = [1, 4, 7];

  function svgRectsOf(svg: string): string[] {
    const round = (n: number) => Math.round(n * 1000) / 1000;
    return Array.from(parseSvg(svg).querySelectorAll('rect'))
      .map((r) => {
        const n = (attr: string) => round(Number(r.getAttribute(attr)));
        return `${n('x')},${n('y')},${n('width')},${n('height')}`;
      })
      .sort();
  }

  it.each([1, 2, 3])(
    'draws the same cell rects (in displayed CSS px), at several frames, for identical options (the no-drift guarantee) at dpr=%s',
    (dpr) => {
      const options: RenderToSvgOptions = { ...FIXTURE, brightness: VARYING };
      const env = stubAnimationGlobals();
      vi.stubGlobal('devicePixelRatio', dpr);
      try {
        const { canvas, ctx } = makeFakeCanvas();
        const instance = createDithered(canvas, { ...options, cache: false });

        for (const frame of FRAMES_TO_CHECK) {
          ctx.rect.mockClear();
          instance.renderFrame(frame);

          // `make2dCtx` has no `roundRect`, so `paintFrame` falls back to
          // `rect()` — the per-cell squares createDithered actually drew,
          // in backing-store (device) px. Compare *displayed* coordinates
          // — multiplied by `cssW / W`, the ratio the browser actually
          // stretches the backing store into its CSS box by — never
          // backing-store rects divided by `dpr`, which is the one unit
          // system in which the backing-store-rounding mismatch this
          // guards against is invisible by construction.
          const cssW = parseFloat(canvas.style.width as string);
          const factor = cssW / canvas.width;
          const round = (n: number) => Math.round(n * 1000) / 1000;
          const canvasRects = ctx.rect.mock.calls
            .map(
              ([x, y, w, h]: number[]) =>
                `${round(x * factor)},${round(y * factor)},${round(w * factor)},${round(h * factor)}`,
            )
            .sort();

          const svgRects = svgRectsOf(renderToSvg({ ...options, frame }));

          expect(canvasRects).toEqual(svgRects);
          expect(canvasRects.length).toBeGreaterThan(0);
        }
      } finally {
        env.restore();
      }
    },
  );

  // `cache` defaults to `'auto'`, which resolves to `true` at `size: 48`
  // — the sprite-strip path above (`cache: false`) is therefore *not*
  // what a default web render actually uses. Cover that path too.
  it('also holds for the sprite-strip cache path (cache: "auto", on by default at size: 48)', () => {
    const options: RenderToSvgOptions = { ...FIXTURE, brightness: VARYING };
    const env = stubAnimationGlobals();
    vi.stubGlobal('devicePixelRatio', 2);
    // The sprite strip is a real `document.createElement('canvas')`
    // under jsdom, whose `getContext('2d')` returns `null` unless
    // stubbed — hence `stubGetContext`, on top of `makeFakeCanvas`'s own
    // plain-object canvas for the visible one.
    const strip = stubGetContext(make2dCtx());
    try {
      const { canvas } = makeFakeCanvas();
      createDithered(canvas, options);
      const stripCtx = strip.stub.mock.results[0]!.value as ReturnType<typeof make2dCtx>;

      const W = canvas.width;
      const cssW = parseFloat(canvas.style.width as string);
      const factor = cssW / W;
      const allRectCalls = stripCtx.rect.mock.calls as number[][];
      expect(allRectCalls.length).toBeGreaterThan(0);

      // Each frame's content must stay inside its own `W`-wide slot —
      // not the unrounded device width, which would overrun the slot by
      // a fraction of a device pixel and rely on the gap floor to hide
      // it (see finding 5): with geometry derived from the rounded `W`
      // (finding 1's fix), a frame's painted width is exactly `W`, flush
      // against `ox = f * W`.
      for (const [x, , w] of allRectCalls) {
        const frame = Math.floor((x + 1e-6) / W);
        expect(x).toBeGreaterThanOrEqual(frame * W - 1e-6);
        expect(x + w).toBeLessThanOrEqual((frame + 1) * W + 1e-6);
      }

      // And, per frame, the drawn cells (read back through the strip,
      // translated out of its `ox` offset and into displayed CSS px)
      // match `renderToSvg`'s exactly — the same no-drift guarantee as
      // the direct-paint path above, for the path a default web render
      // actually takes.
      const round = (n: number) => Math.round(n * 1000) / 1000;
      for (const frame of FRAMES_TO_CHECK) {
        const frameRects = allRectCalls
          .filter(([x]) => Math.floor((x + 1e-6) / W) === frame)
          .map(
            ([x, y, w, h]) =>
              `${round((x - frame * W) * factor)},${round(y * factor)},${round(w * factor)},${round(h * factor)}`,
          )
          .sort();
        const svgRects = svgRectsOf(renderToSvg({ ...options, frame }));

        expect(frameRects).toEqual(svgRects);
        expect(frameRects.length).toBeGreaterThan(0);
      }
    } finally {
      strip.restore();
      env.restore();
    }
  });
});
