import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Wraps the real `sampleCells` in a spy so resize/DPR tests can assert it's
// *not* called, without changing its behaviour for anything else in this
// file (including the existing `createDithered` tests above).
vi.mock('./shape', async () => {
  const actual = await vi.importActual<typeof import('./shape')>('./shape');
  return { ...actual, sampleCells: vi.fn(actual.sampleCells) };
});

// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import { createDithered, frameAt, paintFrame, type DitheredOptions } from './renderer';
// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import { computeGeometry, resolveOptions, resolveRows } from './core';
// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import { sampleCells, type Cell, type Shape } from './shape';
// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import { rozenite, shapes } from './shapes';
// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import {
  SQUARE_SHAPE,
  make2dCtx,
  makeCanvasWithParent,
  makeFakeCanvas,
  setClientBox,
  stubAnimationGlobals,
  stubGetContext,
} from './test-utils';

const mockedSampleCells = sampleCells as unknown as ReturnType<typeof vi.fn<typeof sampleCells>>;

/** A 2:1 wide shape, for tests that care that width follows the aspect ratio. */
const WIDE_SHAPE: Shape = {
  path: 'M0 0 H20 V10 H0 Z',
  viewBox: { x: 0, y: 0, width: 20, height: 10 },
};

describe('frameAt', () => {
  it('quantizes time into [0, frames)', () => {
    expect(frameAt(0, 1000, 10)).toBe(0);
    expect(frameAt(500, 1000, 10)).toBe(5);
    expect(frameAt(999, 1000, 10)).toBe(9);
  });

  it('wraps around at the period boundary', () => {
    expect(frameAt(1000, 1000, 10)).toBe(0);
    expect(frameAt(1500, 1000, 10)).toBe(5);
    expect(frameAt(3500, 1000, 10)).toBe(5);
  });

  it('handles a frame count that does not evenly divide 1', () => {
    // frames=48 -> each frame is 1000/48 * period wide.
    expect(frameAt(0, 2000, 48)).toBe(0);
    expect(frameAt(1999, 2000, 48)).toBe(47);
  });

  // ADR 0006 test 46 / finding 3. `frameAt` keeps its pre-ADR-0006 body
  // verbatim rather than delegating to `frameForPhase`: `(nowMs % period)
  // / period` and `(nowMs / period) % 1` are not the same computation in
  // floating point, and diverge at `Date.now()` magnitudes — the
  // existing tests above use timestamps of at most a few thousand ms and
  // cannot see it. This pins the original arithmetic against a large,
  // deterministic sample of `Date.now()`-magnitude timestamps (a fixed
  // seed, not `Date.now()` itself, so the test is reproducible), over
  // periods that include 333 (where the two formulations diverge at a
  // real rate) and 2000 (where, per the ADR, they happen not to).
  it('agrees with its pre-refactor implementation over a large sample of Date.now()-magnitude timestamps', () => {
    // The exact original body (see ADR 0006 §1 and the commit history),
    // duplicated here rather than imported, so this test pins `frameAt`
    // against an independent reference rather than restating its own
    // implementation.
    function referenceFrameAt(nowMs: number, period: number, frames: number): number {
      const phase = ((nowMs % period) + period) % period;
      return Math.floor((phase / period) * frames) % frames;
    }

    // The ADR's own worked example: frameAt(1352750077665.375, 333, 48)
    // is 26 under the original body and 25 under a `frameForPhase`
    // delegation.
    expect(frameAt(1352750077665.375, 333, 48)).toBe(26);
    expect(frameAt(1352750077665.375, 333, 48)).toBe(referenceFrameAt(1352750077665.375, 333, 48));

    // A small deterministic PRNG (mulberry32) rather than Math.random(),
    // so a failure is reproducible without recording the seed elsewhere.
    function mulberry32(seed: number) {
      let a = seed;
      return () => {
        a |= 0;
        a = (a + 0x6d2b79f5) | 0;
        let t = Math.imul(a ^ (a >>> 15), 1 | a);
        t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
      };
    }
    const rand = mulberry32(0xd17ee7ed);

    const periods = [333, 2000, 700, 1000, 4001];
    const frameCounts = [48, 24, 60, 10];
    let sampled = 0;
    for (let i = 0; i < 500; i++) {
      // Date.now()-magnitude: current era is ~1.7-1.8e12 ms.
      const nowMs = 1_700_000_000_000 + rand() * 1e11;
      const period = periods[i % periods.length]!;
      const frames = frameCounts[i % frameCounts.length]!;
      expect(frameAt(nowMs, period, frames)).toBe(referenceFrameAt(nowMs, period, frames));
      sampled++;
    }
    expect(sampled).toBe(500);
  });
});

function makeCells(n: number): Cell[] {
  return Array.from({ length: n }, (_, k) => ({
    i: k,
    j: 0,
    u: k / n - 0.5,
    v: 0,
    threshold: 0.5,
  }));
}

function makeRecordingCtx() {
  const calls: string[] = [];
  const ctx = {
    fillStyle: '' as string,
    fillRect: vi.fn((...args: number[]) => calls.push(`fillRect(${args.join(',')})`)),
    beginPath: vi.fn(() => calls.push('beginPath')),
    rect: vi.fn((...args: number[]) => calls.push(`rect(${args.join(',')})`)),
    fill: vi.fn(() => calls.push('fill')),
  };
  return { ctx, calls };
}

/**
 * Like `makeRecordingCtx`, but also logs `fillStyle` assignments into the
 * same sequence — needed to pin the exact interleaving of color switches
 * and draws that a multi-tone palette produces.
 */
function makeSequenceCtx() {
  const calls: string[] = [];
  let fillStyleValue: string | object = '';
  const ctx = {
    get fillStyle() {
      return fillStyleValue;
    },
    set fillStyle(value: string | object) {
      fillStyleValue = value;
      calls.push(`fillStyle=${String(value)}`);
    },
    fillRect: vi.fn((...args: number[]) => calls.push(`fillRect(${args.join(',')})`)),
    beginPath: vi.fn(() => calls.push('beginPath')),
    rect: vi.fn((...args: number[]) => calls.push(`rect(${args.join(',')})`)),
    fill: vi.fn(() => calls.push('fill')),
  };
  return { ctx, calls };
}

/**
 * Records, in draw order, the `fillStyle` in effect at the moment each
 * cell is committed (`fill()` following a `rect()`) — separately from
 * `bg`'s own fill (via `fillRect`). Used to compare the colors a palette
 * actually painted, independent of the exact call sequence.
 */
function makeColorRecordingCtx() {
  const cellColors: (string | object)[] = [];
  const bgColors: (string | object)[] = [];
  let pendingRect = false;
  const ctx = {
    fillStyle: '' as string | object,
    fillRect: vi.fn(() => bgColors.push(ctx.fillStyle)),
    beginPath: vi.fn(() => {
      pendingRect = false;
    }),
    rect: vi.fn(() => {
      pendingRect = true;
    }),
    fill: vi.fn(() => {
      if (pendingRect) cellColors.push(ctx.fillStyle);
    }),
    clearRect: vi.fn(),
    setTransform: vi.fn(),
    drawImage: vi.fn(),
    isPointInPath: vi.fn(() => true),
  };
  return { ctx, cellColors, bgColors };
}

describe('paintFrame', () => {
  const geometry = {
    cellSize: 10,
    gap: 1,
    radius: 2,
    fg: '#111',
    bg: 'transparent',
    width: 100,
    height: 10,
  };

  it('draws every cell when brightness is always 1 (above any threshold)', () => {
    const { ctx } = makeRecordingCtx();
    const cells = makeCells(5);
    paintFrame(ctx, cells, () => 1, 0, geometry);
    expect(ctx.fill).toHaveBeenCalledTimes(5);
    expect(ctx.beginPath).toHaveBeenCalledTimes(5);
  });

  it('draws nothing when brightness is always 0', () => {
    const { ctx } = makeRecordingCtx();
    const cells = makeCells(5);
    paintFrame(ctx, cells, () => 0, 0, geometry);
    expect(ctx.fill).not.toHaveBeenCalled();
    expect(ctx.beginPath).not.toHaveBeenCalled();
  });

  it('bypasses the dither threshold for boolean brightness: true draws, false skips', () => {
    const { ctx } = makeRecordingCtx();
    const cells = makeCells(3);
    // threshold is 0.5 on every cell; boolean true must draw regardless.
    paintFrame(ctx, cells, () => true, 0, geometry);
    expect(ctx.fill).toHaveBeenCalledTimes(3);

    const { ctx: ctx2 } = makeRecordingCtx();
    paintFrame(ctx2, cells, () => false, 0, geometry);
    expect(ctx2.fill).not.toHaveBeenCalled();
  });

  it('fills the background only when bg is not "transparent"', () => {
    const { ctx: transparentCtx } = makeRecordingCtx();
    paintFrame(transparentCtx, makeCells(1), () => false, 0, geometry);
    expect(transparentCtx.fillRect).not.toHaveBeenCalled();

    const { ctx: opaqueCtx } = makeRecordingCtx();
    paintFrame(opaqueCtx, makeCells(1), () => false, 0, { ...geometry, bg: '#fff' });
    expect(opaqueCtx.fillRect).toHaveBeenCalledTimes(1);
  });

  it('falls back to rect() when roundRect is unavailable', () => {
    const { ctx } = makeRecordingCtx();
    expect((ctx as { roundRect?: unknown }).roundRect).toBeUndefined();
    paintFrame(ctx, makeCells(1), () => true, 0, geometry);
    expect(ctx.rect).toHaveBeenCalledTimes(1);
  });

  it('uses roundRect when available', () => {
    const { ctx } = makeRecordingCtx();
    const roundRect = vi.fn();
    (ctx as unknown as { roundRect: typeof roundRect }).roundRect = roundRect;
    paintFrame(ctx, makeCells(1), () => true, 0, geometry);
    expect(roundRect).toHaveBeenCalledTimes(1);
    expect(ctx.rect).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// paintFrame: single-color output is byte-identical (ADR 0005 §2)
//
// A committed expected-call-log fixture for `fg: '#8232ff'`: the exact
// sequence of PaintContext calls this produces today, with and without any
// cells drawn. If multi-tone palettes ever changed a single-color call
// sequence, this is what would catch it.
// ---------------------------------------------------------------------------

describe('paintFrame: single-color call-sequence snapshot', () => {
  const geometry = {
    cellSize: 10,
    gap: 1,
    radius: 2,
    fg: '#8232ff',
    bg: 'transparent',
    width: 100,
    height: 10,
  };

  it('draws every other cell in a fixed, unconditional-fillStyle sequence', () => {
    const { ctx, calls } = makeSequenceCtx();
    const cells = makeCells(4);
    paintFrame(ctx, cells, (cell) => cell.i % 2 === 0, 0, geometry);

    expect(calls).toEqual([
      'fillStyle=#8232ff',
      'beginPath',
      'rect(1,1,8,8)',
      'fill',
      'beginPath',
      'rect(21,1,8,8)',
      'fill',
    ]);
  });

  it('still assigns fillStyle once even when no cell is drawn', () => {
    const { ctx, calls } = makeSequenceCtx();
    paintFrame(ctx, makeCells(2), () => false, 0, geometry);

    expect(calls).toEqual(['fillStyle=#8232ff']);
  });
});

// ---------------------------------------------------------------------------
// paintFrame: numeric brightness straddling the threshold
//
// Both the `fg: string` fast path (paint.ts's first branch) and the
// one-entry-array fast path (the `tones === 1` branch) hand-duplicate `b >
// cell.threshold` rather than calling `toneLevel`. Nothing that only
// exercises `toneLevel` directly (see palette.test.ts) or boolean
// brightness (the call-sequence snapshot above, and the "always 1"/
// "always 0" tests) pins that predicate down for either branch — this
// does, for both, and asserts they agree with each other.
// ---------------------------------------------------------------------------

describe('paintFrame: numeric brightness straddling the threshold', () => {
  const threshold = 0.5;
  const cell: Cell = { i: 0, j: 0, u: 0, v: 0, threshold };
  const EPS = 1e-9;

  function drewCell(fg: string | string[], b: number): boolean {
    const { ctx } = makeRecordingCtx();
    paintFrame(ctx, [cell], () => b, 0, {
      cellSize: 10,
      gap: 1,
      radius: 2,
      fg,
      bg: 'transparent',
      width: 10,
      height: 10,
    });
    return ctx.fill.mock.calls.length > 0;
  }

  const branches: Array<{ label: string; fg: string | string[] }> = [
    { label: 'fg: string', fg: '#000' },
    { label: 'fg: [one color]', fg: ['#000'] },
  ];

  for (const { label, fg } of branches) {
    it(`${label}: does not draw when b === cell.threshold`, () => {
      expect(drewCell(fg, threshold)).toBe(false);
    });

    it(`${label}: draws when b is just above cell.threshold`, () => {
      expect(drewCell(fg, threshold + EPS)).toBe(true);
    });

    it(`${label}: does not draw when b is just below cell.threshold`, () => {
      expect(drewCell(fg, threshold - EPS)).toBe(false);
    });
  }

  it('the string and one-entry-array branches agree cell-for-cell across a brightness sweep', () => {
    const sweep = [0, 0.1, 0.25, threshold - EPS, threshold, threshold + EPS, 0.75, 0.9, 1];
    for (const b of sweep) {
      expect(drewCell('#000', b)).toBe(drewCell(['#000'], b));
    }
  });
});

// ---------------------------------------------------------------------------
// paintFrame: multi-tone palettes
// ---------------------------------------------------------------------------

describe('paintFrame: multi-tone palettes', () => {
  const geometry = {
    cellSize: 10,
    gap: 1,
    radius: 2,
    fg: ['#a00', '#0a0', '#00a'],
    bg: 'transparent',
    width: 100,
    height: 10,
  };

  it('paints each cell in the tone its quantized level selects', () => {
    // threshold is 0.5 on every cell (see makeCells): b=0 skips; b=0.4
    // (level 1.2 -> base 1, frac .2 <= .5) paints tone 1; b=0.6 (level 1.8
    // -> base 1, frac .8 > .5) paints tone 2; b=0.95 (>= 1 after rounding
    // is not needed here, level 2.85 -> base 2, frac .85 > .5) paints tone 3.
    const cells = makeCells(4);
    const brightnessByCell = [0, 0.4, 0.6, 0.95];
    const brightness = vi.fn((cell: Cell) => brightnessByCell[cell.i]);

    const { ctx, cellColors } = makeColorRecordingCtx();
    paintFrame(ctx, cells, brightness, 0, geometry);

    expect(cellColors).toEqual(['#a00', '#0a0', '#00a']);
    expect(brightness).toHaveBeenCalledTimes(4); // exactly once per cell
  });

  it('assigns fillStyle at most once per non-empty tone, plus once for bg', () => {
    const cells = makeCells(4);
    const brightnessByCell = [0, 0.4, 0.6, 0.95];
    const { ctx, calls } = makeSequenceCtx();

    paintFrame(ctx, cells, (cell) => brightnessByCell[cell.i], 0, { ...geometry, bg: '#fff' });

    const fillStyleAssignments = calls.filter((c) => c.startsWith('fillStyle='));
    // one for bg, plus one per tone (3 tones, each with exactly one cell)
    expect(fillStyleAssignments).toEqual([
      'fillStyle=#fff',
      'fillStyle=#a00',
      'fillStyle=#0a0',
      'fillStyle=#00a',
    ]);
  });

  it('keeps cells in their original relative order within a tone', () => {
    // Two cells (i=1 and i=3) share tone 3 (brightness >= 1); they must
    // still be drawn in ascending index order, not reversed.
    const cells = makeCells(4);
    const { ctx, calls } = makeSequenceCtx();
    paintFrame(ctx, cells, (cell) => (cell.i === 1 || cell.i === 3 ? 1 : 0), 0, geometry);

    expect(calls).toEqual([
      'fillStyle=#00a',
      'beginPath',
      'rect(11,1,8,8)', // i=1, drawn first
      'fill',
      'beginPath',
      'rect(31,1,8,8)', // i=3, drawn second
      'fill',
    ]);
  });

  it('boolean brightness bypasses the dither: true paints the last tone, false skips', () => {
    const cells = makeCells(2);
    const { ctx, cellColors } = makeColorRecordingCtx();
    paintFrame(ctx, cells, (cell) => cell.i === 0, 0, geometry);

    expect(cellColors).toEqual(['#00a']);
  });

  it('an empty palette falls back to the default fg color', () => {
    const { ctx, cellColors } = makeColorRecordingCtx();
    paintFrame(ctx, makeCells(1), () => true, 0, { ...geometry, fg: [] });

    expect(cellColors).toEqual(['#000']);
  });

  it('a one-entry palette takes the same fast path as a plain string fg', () => {
    const { ctx, calls } = makeSequenceCtx();
    paintFrame(ctx, makeCells(2), () => true, 0, { ...geometry, fg: ['#8232ff'] });

    expect(calls).toEqual([
      'fillStyle=#8232ff',
      'beginPath',
      'rect(1,1,8,8)',
      'fill',
      'beginPath',
      'rect(11,1,8,8)',
      'fill',
    ]);
  });
});

// ---------------------------------------------------------------------------
// createDithered
// ---------------------------------------------------------------------------

describe('createDithered', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;

  beforeEach(() => {
    env = stubAnimationGlobals();
  });

  afterEach(() => {
    env.restore();
  });

  function baseOptions(overrides: Partial<DitheredOptions> = {}): DitheredOptions {
    return {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
      ...overrides,
    };
  }

  it('draws the initial frame synchronously on create', () => {
    const { canvas, ctx } = makeFakeCanvas();
    createDithered(canvas, baseOptions());
    expect(ctx.clearRect).toHaveBeenCalled();
    // At least one cell should have been painted since brightness is always true.
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('schedules an animation frame when not paused', () => {
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions());
    expect(env.rafCallbacks.length).toBe(1);
  });

  it('does not schedule when created paused', () => {
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ paused: true }));
    expect(env.rafCallbacks.length).toBe(0);
  });

  it('does not schedule under prefers-reduced-motion', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions());
    expect(env.rafCallbacks.length).toBe(0);
  });

  it('setPaused(true) cancels the scheduled frame', () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    expect(env.rafCallbacks.length).toBe(1);
    instance.setPaused(true);
    expect(cancelAnimationFrame).toHaveBeenCalled();
  });

  it('setPaused(false) resumes scheduling', () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ paused: true }));
    expect(env.rafCallbacks.length).toBe(0);
    instance.setPaused(false);
    expect(env.rafCallbacks.length).toBe(1);
  });

  it('destroy cancels the loop and disconnects the intersection observer', () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    expect(env.ioInstances).toHaveLength(1);
    instance.destroy();
    expect(cancelAnimationFrame).toHaveBeenCalled();
    expect(env.ioInstances[0].disconnect).toHaveBeenCalled();
  });

  it('destroy removes the visibilitychange listener', () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    instance.destroy();
    expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    removeSpy.mockRestore();
  });

  it('update({ fg }) redraws using the new fill color', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    ctx.fill.mockClear();
    instance.update({ fg: '#ff00ff' });
    expect(ctx.fillStyle).toBe('#ff00ff');
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('renderFrame draws a specific frame directly', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    ctx.clearRect.mockClear();
    instance.renderFrame(3);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);
  });

  // ADR item 13: `blit` re-establishes the device transform (not the
  // identity) before painting, clears in CSS units, and paints through
  // `computeGeometry(opts, cssW, cssH)` — the identical call `renderToSvg`
  // makes — rather than a scaled copy of device-pixel geometry. Assert the
  // transform/clear calls directly, and that the coordinates `paintFrame`
  // receives equal `computeGeometry(opts, cssW, cssH)`'s own math exactly,
  // not up to a correction factor.
  it('paints under the device transform, clears in CSS units, and matches computeGeometry(opts, cssW, cssH) exactly', () => {
    const options = baseOptions({ shape: shapes.rozenite, size: 48, cols: 16 });
    vi.stubGlobal('devicePixelRatio', 2.75);
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, options);
    ctx.setTransform.mockClear();
    ctx.clearRect.mockClear();
    ctx.rect.mockClear();
    instance.renderFrame(0);

    const cssW = parseFloat(canvas.style.width as string);
    const cssH = parseFloat(canvas.style.height as string);
    const W = canvas.width;
    const H = canvas.height;

    expect(ctx.setTransform).toHaveBeenCalledWith(W / cssW, 0, 0, H / cssH, 0, 0);
    expect(ctx.clearRect).toHaveBeenCalledWith(0, 0, cssW, cssH);

    const opts = resolveOptions(options);
    const geometry = computeGeometry(opts, cssW, cssH);
    const cells = sampleCells(opts.shape, opts.cols, opts.hitTest, resolveRows(opts));
    const expectedRects = cells.map((cell) => {
      const w = geometry.cellSize - geometry.gap * 2;
      const x = cell.i * geometry.cellSize + geometry.gap;
      const y = cell.j * geometry.cellSize + geometry.gap;
      return [x, y, w, w];
    });
    expect(ctx.rect.mock.calls).toEqual(expectedRects);
  });

  // Regression: `blit` used to index the sprite strip/paint phase with the
  // raw frame number, unlike `core/static.ts`'s `wrapFrame` and
  // `native/Dithered.tsx`'s local copy of it. An out-of-range
  // `initialFrame` (or `renderFrame` argument) therefore disagreed with
  // the React SSR fallback (which does wrap, via `renderToDataURL`) and,
  // worse, indexed past the sprite strip entirely when caching was on —
  // `drawImage`'s source rect landed outside the strip and painted
  // nothing.
  // `document.createElement('canvas')` (the sprite-strip cache) is a real
  // `HTMLCanvasElement` under jsdom, whose `getContext('2d')` returns
  // `null` (no "canvas" package installed) unless stubbed — hence
  // `stubGetContext`, on top of `makeFakeCanvas`'s own plain-object canvas
  // for the visible one.
  it('wraps an out-of-range initialFrame into [0, frames) rather than indexing past the sprite strip', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const strip = stubGetContext(make2dCtx());
    try {
      createDithered(canvas, baseOptions({ cache: true, frames: 48, initialFrame: 50 }));

      // 50 wraps to 50 % 48 = 2; the cached sprite strip's per-frame
      // source slot is `frame * canvas.width`.
      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
      const [, sx] = ctx.drawImage.mock.calls[0];
      expect(sx).toBe(2 * canvas.width);
    } finally {
      strip.restore();
    }
  });

  it("wraps a negative initialFrame the same way core/static.ts's wrapFrame does", () => {
    const { canvas, ctx } = makeFakeCanvas();
    const strip = stubGetContext(make2dCtx());
    try {
      createDithered(canvas, baseOptions({ cache: true, frames: 48, initialFrame: -1 }));

      // -1 wraps to 47, matching `((Math.round(-1) % 48) + 48) % 48`.
      const [, sx] = ctx.drawImage.mock.calls[0];
      expect(sx).toBe(47 * canvas.width);
    } finally {
      strip.restore();
    }
  });

  it('renderFrame also wraps an out-of-range frame index', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const strip = stubGetContext(make2dCtx());
    try {
      const instance = createDithered(canvas, baseOptions({ cache: true, frames: 48 }));
      ctx.drawImage.mockClear();

      instance.renderFrame(50);

      const [, sx] = ctx.drawImage.mock.calls[0];
      expect(sx).toBe(2 * canvas.width);
    } finally {
      strip.restore();
    }
  });

  // Regression: a caller (notably the React wrapper, which always builds a
  // full options object from its props) may pass a key with an explicit
  // `undefined` value rather than omitting it. That must fall back to the
  // default exactly like an omitted key would, not overwrite the default
  // with `undefined` (which painted opaque black squares: an unset
  // `fillStyle` renders as black, and an `undefined` `cols` makes cell
  // size `NaN`, drawing nothing).
  it('ignores explicit `undefined` option values and falls back to defaults', () => {
    const { canvas, ctx } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ fg: undefined, bg: undefined, cols: undefined }));

    // Default fg is '#000' — the last fillStyle set before drawing cells.
    expect(ctx.fillStyle).toBe('#000');
    // Default bg is 'transparent', so no background fillRect should happen.
    expect(ctx.fillRect).not.toHaveBeenCalled();
    // Default cols is a real number (16), not `undefined`/NaN, so cells
    // are still sampled and drawn (brightness is always true here).
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('update({ fg: undefined }) leaves the current fg untouched', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ fg: '#ff00ff' }));
    ctx.fill.mockClear();

    instance.update({ fg: undefined, cols: 6 });

    expect(ctx.fillStyle).toBe('#ff00ff');
    expect(ctx.fill).toHaveBeenCalled();
  });

  // Sprite-strip cache with a palette: the strip is built through the same
  // `computeGeometry` + `paintFrame` path as uncached rendering, so it
  // needs no palette-specific handling — this pins that down by comparing
  // the colors an actual cached build produces against an uncached
  // instance configured identically. `frames: 1` makes the whole strip
  // exactly one frame's worth of draws, directly comparable to a single
  // uncached paint.
  it('cache: true builds a sprite strip whose colors match an uncached instance', () => {
    const palette = ['#a00', '#0a0', '#00a'];
    // Deterministic and phase-independent (ignores `t`), so a one-frame
    // loop is representative and cached/uncached output must agree.
    const brightness = (cell: Cell) => (cell.i % 3 === 0 ? 0 : cell.i % 3 === 1 ? 0.95 : 0.4);
    const options = (overrides: Partial<DitheredOptions>) =>
      baseOptions({ fg: palette, frames: 1, brightness, ...overrides });

    const strip = makeColorRecordingCtx();
    const getContextStub = stubGetContext(strip.ctx);
    const { canvas: cachedCanvas, ctx: cachedMainCtx } = makeFakeCanvas();
    createDithered(cachedCanvas, options({ cache: true }));
    getContextStub.restore();

    const uncached = makeColorRecordingCtx();
    const uncachedCanvas = {
      width: 0,
      height: 0,
      style: {} as Record<string, string>,
      getContext: vi.fn(() => uncached.ctx),
    } as unknown as HTMLCanvasElement;
    createDithered(uncachedCanvas, options({ cache: false }));

    // Strip built and blitted.
    expect(strip.cellColors.length).toBeGreaterThan(0);
    expect(cachedMainCtx.drawImage).toHaveBeenCalled();

    // Cached and uncached agree on which colors were painted, in order.
    expect(strip.cellColors).toEqual(uncached.cellColors);
    expect(strip.cellColors.every((c) => palette.includes(c as string))).toBe(true);
  });

  // Finding 5: the palette must be copied at the edge (`resolveOptions`
  // for create, `update()`'s patch merge for reconfigure), not aliased.
  // Without that copy, a caller mutating the array they passed in would
  // silently change what gets painted -- immediately for `cache: false`
  // (the very next repaint reads the array's current contents), or on
  // the next reconfigure for `cache: true` (the mutation only reaches a
  // freshly rebuilt strip) -- with no `update({ fg: ... })` call naming
  // the new color anywhere in sight.
  it('does not observe a later mutation of the caller-supplied fg array (cache: false)', () => {
    const palette = ['#a00', '#0a0'];
    const rec = makeColorRecordingCtx();
    const stub = stubGetContext(rec.ctx);
    const canvas = document.createElement('canvas');

    const instance = createDithered(canvas, baseOptions({ fg: palette, cache: false }));
    rec.cellColors.length = 0; // discard the initial paint

    palette[1] = '#ff00ff'; // mutate the array `createDithered` was given
    instance.renderFrame(1); // any repaint, with no `update()` call

    expect(rec.cellColors).not.toContain('#ff00ff');
    expect(rec.cellColors).toContain('#0a0');

    stub.restore();
  });

  it('does not observe a later mutation of the caller-supplied fg array (cache: true)', () => {
    const palette = ['#a00', '#0a0'];
    const rec = makeColorRecordingCtx();
    const stub = stubGetContext(rec.ctx);
    const canvas = document.createElement('canvas');

    const instance = createDithered(canvas, baseOptions({ fg: palette, cache: true, frames: 1 }));

    palette[1] = '#ff00ff'; // mutate the array `createDithered` was given
    rec.cellColors.length = 0;
    // `frames` (not `fg`) forces the cache-affecting reconfigure that
    // rebuilds the strip — `update()` only touches the stages a patch
    // actually affects (ADR 0011), so an empty patch alone would leave
    // the untouched strip in place instead of proving anything here.
    instance.update({ frames: 2 });

    expect(rec.cellColors).not.toContain('#ff00ff');
    expect(rec.cellColors).toContain('#0a0');

    stub.restore();
  });

  // Round-2 finding 2: the previous two tests only ever hand the array to
  // `createDithered` (i.e. `resolveOptions`'s copy), so they can't catch a
  // regression in the *other* call site that must also copy -- the
  // `update()` patch merge. This one routes the array through `update({
  // fg: palette })` instead, so a later mutation of the caller's array must
  // still not be observed. Confirmed to fail (paints `#ff00ff`) if
  // `update()`'s merge is changed to `assignDefined<ResolvedOptions>(opts,
  // patch)`, i.e. dropped the `clonePaletteOption(patch.fg)` call.
  it('does not observe a later mutation of an fg array passed via update()', () => {
    const palette = ['#a00', '#0a0'];
    const rec = makeColorRecordingCtx();
    const stub = stubGetContext(rec.ctx);
    const canvas = document.createElement('canvas');

    const instance = createDithered(canvas, baseOptions({ fg: '#000', cache: false }));
    instance.update({ fg: palette });
    rec.cellColors.length = 0; // discard the paint triggered by update()

    palette[1] = '#ff00ff'; // mutate the array after handing it to update()
    instance.renderFrame(1); // any repaint, with no further update() call

    expect(rec.cellColors).not.toContain('#ff00ff');
    expect(rec.cellColors).toContain('#0a0');

    stub.restore();
  });

  // Regression for the missing-dependency failure mode: `update({ matrix })`
  // must actually resample, not just carry the new option through untouched.
  it('update({ matrix: "bayer8" }) resamples: the same fixed brightness draws a different cell count', () => {
    // cols=8 on a square shape makes rows=8 too, so the grid is 8x8 in
    // both cases: bayer4 tiles 2x2, bayer8 matches it exactly. 0.53 sits
    // between two bayer4 quantization levels and two different bayer8
    // ones, so the two matrices draw a different number of cells.
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ cols: 8, brightness: () => 0.53 }));

    ctx.fill.mockClear();
    instance.renderFrame(0);
    const bayer4Draws = ctx.fill.mock.calls.length;

    instance.update({ matrix: 'bayer8' });
    ctx.fill.mockClear();
    instance.renderFrame(0);
    const bayer8Draws = ctx.fill.mock.calls.length;

    expect(bayer4Draws).toBeGreaterThan(0);
    expect(bayer8Draws).not.toBe(bayer4Draws);
  });

  it('createDithered with an invalid matrix throws at create time, not at first frame', () => {
    const { canvas, ctx } = makeFakeCanvas();
    expect(() =>
      createDithered(
        canvas,
        baseOptions({
          matrix: [
            [0, 1, 2],
            [1, 2],
          ],
        }),
      ),
    ).toThrow(/ragged/);
    // Nothing should have been drawn — the throw happens before the first blit.
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  // Regression: a throwing `configure()` used to run after the
  // visibilitychange listener and IntersectionObserver were already
  // registered, so a failed create left both pinned to the canvas with no
  // `destroy()` to release them (a real leak under React 18 StrictMode,
  // which mounts twice).
  it('leaves no visibilitychange listener or observed IntersectionObserver behind when create fails', () => {
    const addSpy = vi.spyOn(document, 'addEventListener');
    const { canvas } = makeFakeCanvas();

    expect(() =>
      createDithered(
        canvas,
        baseOptions({
          matrix: [
            [0, 1, 2],
            [1, 2],
          ],
        }),
      ),
    ).toThrow(/ragged/);

    expect(addSpy).not.toHaveBeenCalledWith('visibilitychange', expect.any(Function));
    expect(env.ioInstances).toHaveLength(0);
    addSpy.mockRestore();
  });

  // Regression: a rejected `update()` used to merge the invalid patch into
  // `opts` before validating it, so the throw left the instance poisoned —
  // `cols`/`matrix` committed despite the error, the animation halted with
  // no `schedule()` to restart it, and even a subsequent *valid* `update()`
  // would re-throw against the same bad `opts.matrix` forever.
  describe('a rejected update()', () => {
    function raggedMatrix() {
      return [
        [0, 1, 2],
        [1, 2],
      ];
    }

    it('propagates the error', () => {
      const { canvas } = makeFakeCanvas();
      const instance = createDithered(canvas, baseOptions());
      expect(() => instance.update({ matrix: raggedMatrix() })).toThrow(/ragged/);
    });

    it('leaves opts unchanged: a rejected cols change alongside it never took effect', () => {
      const { canvas, ctx } = makeFakeCanvas();
      const instance = createDithered(canvas, baseOptions({ cols: 4 }));

      // Cell width is derived from `opts.cols` fresh on every paint (see
      // `computeGeometry`), so it exposes a poisoned `opts.cols` even
      // though the sampled `cells` array itself was never reassigned
      // (the assignment that would do so never runs, since it sits after
      // the throwing `sampleCells` call either way).
      ctx.rect.mockClear();
      instance.renderFrame(0);
      const [, , widthBefore] = ctx.rect.mock.calls[0] as number[];

      expect(() => instance.update({ cols: 8, matrix: raggedMatrix() })).toThrow(/ragged/);

      ctx.rect.mockClear();
      instance.renderFrame(0);
      const [, , widthAfter] = ctx.rect.mock.calls[0] as number[];

      expect(widthAfter).toBe(widthBefore);
    });

    it('leaves the canvas surface untouched', () => {
      const { canvas } = makeFakeCanvas();
      const instance = createDithered(canvas, baseOptions({ size: 40 }));
      const widthBefore = canvas.width;
      const heightBefore = canvas.height;

      expect(() => instance.update({ size: 80, matrix: raggedMatrix() })).toThrow(/ragged/);

      expect(canvas.width).toBe(widthBefore);
      expect(canvas.height).toBe(heightBefore);
    });

    it('leaves the animation scheduled, since it was already running', () => {
      const { canvas } = makeFakeCanvas();
      const instance = createDithered(canvas, baseOptions());
      expect(env.rafCallbacks.length).toBe(1);

      expect(() => instance.update({ matrix: raggedMatrix() })).toThrow(/ragged/);

      // halt()/schedule() were never reached: no new cancel, no new frame.
      expect(cancelAnimationFrame).not.toHaveBeenCalled();
      expect(env.rafCallbacks.length).toBe(1);
    });

    it('does not poison a later, valid update()', () => {
      const { canvas, ctx } = makeFakeCanvas();
      const instance = createDithered(canvas, baseOptions());

      expect(() => instance.update({ matrix: raggedMatrix() })).toThrow(/ragged/);

      // `period` alone doesn't affect the surface or the sprite cache
      // (ADR 0011), so a valid `update()` restricted to it is a no-op
      // repaint-wise; a real reconfigure (`brightness`, cache-affecting)
      // is what actually exercises "not poisoned by the earlier throw".
      ctx.fill.mockClear();
      expect(() => instance.update({ period: 3000, brightness: () => true })).not.toThrow();
      expect(ctx.fill).toHaveBeenCalled();
    });
  });

  // Regression: unlike the ragged-matrix cases above (which throw inside
  // `sampleCells`, before `configure()` touches anything), these throw
  // from the caller's `brightness` — once the sprite-strip rebuild calls
  // it (cache on), or once `blit()` calls it directly (cache off). Both
  // sit after `configure()` has already written the canvas surface, `W`,
  // `H` and `cells` to the rejected configuration, so restoring `opts`
  // alone is not enough: the surface and the sprite cache must roll back
  // together, and the loop must come back if it was running.
  describe('a rejected update() that fails outside matrix validation', () => {
    function throwingBrightness(): never {
      throw new Error('boom');
    }

    it('cache: true — a throwing brightness during the sprite-strip rebuild leaves the surface and cache in sync', () => {
      // The sprite strip is a real `document.createElement('canvas')`
      // (see `configure()`), and jsdom has no built-in 2D context — stub
      // it so the strip build actually runs `paintFrame` (and therefore
      // calls `brightness`) instead of silently no-op'ing into `cache:
      // false` behavior via a null context.
      const { restore } = stubGetContext(make2dCtx());
      try {
        const { canvas, ctx } = makeFakeCanvas();
        const instance = createDithered(
          canvas,
          baseOptions({ size: 40, cols: 4, frames: 4, cache: true, brightness: () => true }),
        );
        expect(env.rafCallbacks.length).toBe(1);
        const widthBefore = canvas.width;
        const heightBefore = canvas.height;

        ctx.drawImage.mockClear();
        instance.renderFrame(0);
        const callBefore = ctx.drawImage.mock.calls[0];

        expect(() => instance.update({ size: 120, brightness: throwingBrightness })).toThrow(
          /boom/,
        );

        // The rejected size change must not have taken effect on the
        // canvas surface...
        expect(canvas.width).toBe(widthBefore);
        expect(canvas.height).toBe(heightBefore);

        // ...nor left the loop halted for good (configure() throwing
        // never reaches `halt()`, so nothing needs re-scheduling here).
        expect(cancelAnimationFrame).not.toHaveBeenCalled();
        expect(env.rafCallbacks.length).toBe(1);

        // A later blit still agrees with the surface: same sprite strip,
        // same draw rectangle as before the failed update — not the old
        // strip read with the new (larger) geometry, which is what
        // drawing past the strip's edge looked like before the fix.
        ctx.drawImage.mockClear();
        instance.renderFrame(0);
        const callAfter = ctx.drawImage.mock.calls[0];
        expect(callAfter).toEqual(callBefore);

        // A subsequent valid update() still succeeds.
        ctx.fill.mockClear();
        expect(() => instance.update({ cache: false, period: 3000 })).not.toThrow();
      } finally {
        restore();
      }
    });

    it('cache: false — a throwing brightness during blit() leaves the surface untouched and the loop scheduled', () => {
      const { canvas, ctx } = makeFakeCanvas();
      const instance = createDithered(
        canvas,
        baseOptions({ size: 40, cache: false, brightness: () => true }),
      );
      expect(env.rafCallbacks.length).toBe(1);
      const widthBefore = canvas.width;
      const heightBefore = canvas.height;

      expect(() => instance.update({ size: 80, brightness: throwingBrightness })).toThrow(/boom/);

      // The rejected size change must not have taken effect...
      expect(canvas.width).toBe(widthBefore);
      expect(canvas.height).toBe(heightBefore);

      // ...and the loop, halted by `configure()` succeeding before the
      // repaint failed, must have been re-armed rather than left frozen.
      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(env.rafCallbacks.length).toBe(2);

      // A later blit paints real cells again (the restored, non-throwing
      // `brightness`), not a degenerate/blank frame.
      ctx.fill.mockClear();
      instance.renderFrame(0);
      expect(ctx.fill).toHaveBeenCalled();

      // A subsequent valid update() still succeeds.
      expect(() => instance.update({ period: 3000 })).not.toThrow();
    });
  });

  // Round-2's selective-stage `update()` only runs a stage when it detects
  // a relevant option delta, which is the ADR's stated design (and much
  // cheaper) — but a few real deltas fell outside every detection set,
  // silently losing a repaint (review finding 7).

  it('update({ initialFrame }) still repaints (review finding 7)', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    ctx.clearRect.mockClear();

    instance.update({ initialFrame: 3 });

    expect(ctx.clearRect).toHaveBeenCalled();
  });

  it('update({ respectReducedMotion: true }) under an active reduced-motion preference falls back to initialFrame instead of leaving whatever frame was showing (review finding 7)', () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const seenT: number[] = [];
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(
      canvas,
      baseOptions({
        respectReducedMotion: false, // not yet respecting the (already-active) OS preference
        initialFrame: 2,
        frames: 10,
        brightness: (_cell, t) => {
          seenT.push(t as number);
          return true;
        },
      }),
    );
    seenT.length = 0;
    instance.renderFrame(5); // simulate the loop having progressed to frame 5
    expect(seenT[0]).toBeCloseTo(0.5); // 5 / 10

    seenT.length = 0;
    instance.update({ respectReducedMotion: true });

    // The documented reduced-motion contract is a single static frame —
    // `initialFrame` (2), not whatever frame the (now-halted) loop last
    // happened to show.
    expect(seenT[0]).toBeCloseTo(0.2); // 2 / 10
  });

  it('update() re-reads devicePixelRatio when matchMedia is unavailable (review finding 6)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    expect(canvas.width).toBe(40); // dpr defaults to 1

    // A degraded environment with no `matchMedia` has no listener to catch
    // this — the only way back to a crisp backing store is `update()`
    // re-checking `devicePixelRatio` itself, as it did before the
    // selective-stage rewrite.
    vi.stubGlobal('devicePixelRatio', 2);
    instance.update({});

    expect(canvas.width).toBe(80);
  });
});

// ---------------------------------------------------------------------------
// createDithered: currentColor (web-only; see ADR 0005 §5)
// ---------------------------------------------------------------------------

describe('createDithered: currentColor', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;
  let ctx: ReturnType<typeof make2dCtx>;
  let getContextStub: ReturnType<typeof stubGetContext>;
  let canvas: HTMLCanvasElement;

  beforeEach(() => {
    env = stubAnimationGlobals();
    ctx = make2dCtx();
    getContextStub = stubGetContext(ctx);
    canvas = document.createElement('canvas');
    document.body.appendChild(canvas);
  });

  afterEach(() => {
    env.restore();
    getContextStub.restore();
    canvas.remove();
  });

  function baseOptions(overrides: Partial<DitheredOptions> = {}): DitheredOptions {
    return {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
      ...overrides,
    };
  }

  it('resolves a currentColor fg against the canvas computed color', () => {
    canvas.style.color = 'rgb(10, 20, 30)';
    const expected = getComputedStyle(canvas).color;

    createDithered(canvas, baseOptions({ fg: 'currentColor' }));

    expect(ctx.fillStyle).toBe(expected);
  });

  it('update() re-resolves currentColor against the new computed color', () => {
    canvas.style.color = 'rgb(10, 20, 30)';
    const instance = createDithered(canvas, baseOptions({ fg: 'currentColor' }));

    canvas.style.color = 'rgb(40, 50, 60)';
    const expected = getComputedStyle(canvas).color;
    instance.update({});

    expect(ctx.fillStyle).toBe(expected);
  });

  it('refreshColors() picks up a changed color and no-ops when unchanged', () => {
    canvas.style.color = 'rgb(10, 20, 30)';
    const instance = createDithered(canvas, baseOptions({ fg: 'currentColor' }));
    ctx.fill.mockClear();

    // No color change: a no-op, so nothing is repainted.
    instance.refreshColors();
    expect(ctx.fill).not.toHaveBeenCalled();

    canvas.style.color = 'rgb(70, 80, 90)';
    const expected = getComputedStyle(canvas).color;
    instance.refreshColors();

    expect(ctx.fillStyle).toBe(expected);
    expect(ctx.fill).toHaveBeenCalled();
  });

  // Every other `refreshColors` test in this file uses `cache: false`, so
  // none of them exercise the cache-rebuild half of `refreshColors` — even
  // though `cache: 'auto'` (on for `size <= 120`, the default) means most
  // real instances *are* cached. With `cache: true`, `blit()` draws the
  // sprite strip via `drawImage` rather than calling `paintFrame` on the
  // main context directly, and `drawImage` never touches `fillStyle` — so
  // the only way this test's final `fillStyle` can be the *new* resolved
  // color is if `refreshColors()` actually rebuilds the strip (paints
  // through the shared context, which is what sets `fillStyle`) before
  // blitting it. Deleting that rebuild would leave `blit()` drawing the
  // *stale* strip, and `fillStyle` would be left at whatever the very
  // first (old-color) strip build set it to.
  it('refreshColors() rebuilds the sprite cache when the resolved color changes (cache: true)', () => {
    canvas.style.color = 'rgb(10, 20, 30)';
    const instance = createDithered(canvas, baseOptions({ fg: 'currentColor', cache: true }));

    canvas.style.color = 'rgb(70, 80, 90)';
    const expected = getComputedStyle(canvas).color;
    instance.refreshColors();

    expect(ctx.fillStyle).toBe(expected);
  });

  it('resolves only the currentColor entry in a mixed palette', () => {
    const rec = makeColorRecordingCtx();
    const stub = stubGetContext(rec.ctx);
    const mixedCanvas = document.createElement('canvas');
    document.body.appendChild(mixedCanvas);
    mixedCanvas.style.color = 'rgb(9, 9, 9)';
    const expectedResolved = getComputedStyle(mixedCanvas).color;

    // threshold is Bayer-derived per cell; pick brightness values that
    // deterministically land cell (0,0) on tone 1 (the resolved token) and
    // cell (1,0) on tone 2 (the untouched literal), regardless of the
    // exact threshold, by using values far from any possible boundary.
    const brightness = (cell: Cell) => {
      if (cell.i === 0 && cell.j === 0) return 0.4;
      if (cell.i === 1 && cell.j === 0) return 1;
      return 0;
    };

    createDithered(mixedCanvas, {
      shape: SQUARE_SHAPE,
      brightness,
      size: 40,
      cols: 4,
      cache: false,
      fg: ['currentColor', '#ff00ff'],
    });

    expect(rec.cellColors).toEqual([expectedResolved, '#ff00ff']);

    stub.restore();
    mixedCanvas.remove();
  });
});

// ---------------------------------------------------------------------------
// Responsive sizing (ADR 0011): `size: 'fill'` and DPR-change handling.
// ---------------------------------------------------------------------------

describe('createDithered — responsive sizing', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;

  beforeEach(() => {
    env = stubAnimationGlobals();
    mockedSampleCells.mockClear();
  });

  afterEach(() => {
    env.restore();
  });

  function fillOptions(overrides: Partial<DitheredOptions> = {}): DitheredOptions {
    return {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 'fill',
      cols: 4,
      cache: false,
      ...overrides,
    };
  }

  /** A real `<canvas>` inside a real `<div>` parent, with a stubbed 2D context. */
  function setup(box: { width: number; height: number } | null) {
    const { parent, canvas } = makeCanvasWithParent();
    if (box) setClientBox(parent, box);
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    return { parent, canvas, ctx, restore: getContextStub.restore };
  }

  function lastResizeObserver() {
    const instances = env.resizeObserverInstances;
    return instances[instances.length - 1];
  }

  // -- fitting -------------------------------------------------------------

  it("size: 'fill' fits the parent's content box, with width following the shape's aspect ratio", () => {
    const { parent, canvas, restore } = setup({ width: 300, height: 100 });
    try {
      createDithered(canvas, fillOptions({ shape: WIDE_SHAPE }));
      // aspect 2: fitSize(300, 100, 2) = min(100, 150) = 100.
      expect(canvas.style.height).toBe('100px');
      expect(canvas.style.width).toBe('200px');
      expect(canvas.width).toBe(200); // dpr defaults to 1 in jsdom
      expect(canvas.height).toBe(100);
      expect(parent).toBeDefined();
    } finally {
      restore();
    }
  });

  it('a larger ResizeObserver delivery re-fits: CSS size and backing store both follow, at size x dpr', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('100px');
      expect(canvas.width).toBe(200); // 100 * dpr 2

      lastResizeObserver().trigger({ width: 200, height: 200 });

      expect(canvas.style.width).toBe('200px');
      expect(canvas.style.height).toBe('200px');
      expect(canvas.width).toBe(400); // 200 * dpr 2
      expect(canvas.height).toBe(400);
    } finally {
      restore();
    }
  });

  it('accounts for a vertical writing-mode parent when reading a ResizeObserver contentBoxSize entry (review finding 8)', () => {
    const { parent, canvas, restore } = setup({ width: 300, height: 100 });
    parent.style.writingMode = 'vertical-rl';
    try {
      createDithered(canvas, fillOptions({ shape: WIDE_SHAPE }));

      const ro = lastResizeObserver();
      // Under a vertical writing mode the inline axis runs vertically, so
      // `inlineSize` reports the box's visual *height* (100) and
      // `blockSize` its visual *width* (300) -- swapped relative to the
      // horizontal-writing-mode assumption `boxFromEntry` previously made
      // unconditionally.
      const entry = {
        target: parent,
        contentBoxSize: [{ inlineSize: 100, blockSize: 300 }],
        contentRect: {
          width: 300,
          height: 100,
          x: 0,
          y: 0,
          top: 0,
          left: 0,
          right: 300,
          bottom: 100,
        },
      } as unknown as ResizeObserverEntry;
      ro.callback([entry], ro as unknown as ResizeObserver);

      // aspect 2: fitSize(300, 100, 2) = min(100, 150) = 100. Reading the
      // logical sizes as if the mode were horizontal would instead compute
      // fitSize(100, 300, 2) = 50.
      expect(canvas.style.height).toBe('100px');
      expect(canvas.style.width).toBe('200px');
    } finally {
      restore();
    }
  });

  // -- one-cell resize threshold --------------------------------------------

  it('a sub-cell resize does not resample and does not rebuild the sprite strip', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      // cols: 4, cache forced on so there is a strip to (not) rebuild.
      createDithered(canvas, fillOptions({ cache: true }));
      const callsBefore = mockedSampleCells.mock.calls.length;
      const createSpy = vi.spyOn(document, 'createElement');

      // cell width at build time is 100/4 = 25px; a 10px move stays under it.
      lastResizeObserver().trigger({ width: 110, height: 110 });

      expect(canvas.style.width).toBe('110px');
      expect(mockedSampleCells.mock.calls.length).toBe(callsBefore);
      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(0);
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('a super-cell resize rebuilds the sprite strip but still does not resample', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions({ cache: true }));
      const callsBefore = mockedSampleCells.mock.calls.length;
      const createSpy = vi.spyOn(document, 'createElement');

      // cell width at build time is 100/4 = 25px; a 40px move clears it.
      lastResizeObserver().trigger({ width: 140, height: 140 });

      expect(canvas.style.width).toBe('140px');
      expect(mockedSampleCells.mock.calls.length).toBe(callsBefore);
      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(1);
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('a super-cell resize rebuild preserves the currently displayed frame instead of resetting to initialFrame (review finding 2)', () => {
    const { canvas, ctx, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions({ cache: true, frames: 10 }));
      instance.setPaused(true);
      instance.renderFrame(7); // e.g. a determinate `progress` render
      ctx.drawImage.mockClear();

      // cell width at build time is 100/4 = 25px; a 40px move clears it.
      lastResizeObserver().trigger({ width: 140, height: 140 });

      const lastCall = ctx.drawImage.mock.calls[ctx.drawImage.mock.calls.length - 1];
      const builtW = 140; // the new device width, post-rebuild
      expect(lastCall).toEqual([
        expect.anything(),
        7 * builtW,
        0,
        builtW,
        builtW,
        0,
        0,
        builtW,
        builtW,
      ]);
    } finally {
      restore();
    }
  });

  // -- epsilon guard / feedback loop ----------------------------------------

  it('a measurement within 0.5 CSS px of the current size writes nothing to canvas.style', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions());
      const widthBefore = canvas.style.width;
      const heightBefore = canvas.style.height;

      lastResizeObserver().trigger({ width: 100.3, height: 100.2 });

      expect(canvas.style.width).toBe(widthBefore);
      expect(canvas.style.height).toBe(heightBefore);
    } finally {
      restore();
    }
  });

  it('re-delivering the same box produces no further style writes and no rebuild', () => {
    const { canvas, ctx, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions({ cache: true }));
      lastResizeObserver().trigger({ width: 200, height: 200 });
      expect(canvas.style.width).toBe('200px');

      const createSpy = vi.spyOn(document, 'createElement');
      // Deleting the epsilon guard would still leave both assertions below
      // passing (`resizeTo(200)` would just re-write the same '200px' and
      // stay under the one-cell threshold), so also assert nothing was even
      // repainted — `resizeTo()` always ends with an unconditional `blit()`,
      // so a real (non-dropped) delivery always clears and redraws (review
      // finding 5).
      ctx.clearRect.mockClear();
      // The parent "re-measuring its own now-written size" — same box again.
      lastResizeObserver().trigger({ width: 200, height: 200 });

      expect(canvas.style.width).toBe('200px');
      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(0);
      expect(ctx.clearRect).not.toHaveBeenCalled();
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  // -- dormancy --------------------------------------------------------------

  it('a degenerate parent box goes dormant: 0px CSS size, loop halted, backing store retained', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(env.rafCallbacks.length).toBe(1);
      const widthBefore = canvas.width;
      const heightBefore = canvas.height;

      lastResizeObserver().trigger({ width: 0, height: 0 });

      expect(canvas.style.width).toBe('0px');
      expect(canvas.style.height).toBe('0px');
      expect(cancelAnimationFrame).toHaveBeenCalled();
      // The backing store itself is untouched while dormant.
      expect(canvas.width).toBe(widthBefore);
      expect(canvas.height).toBe(heightBefore);

      // Waking: a following non-degenerate box re-blits and reschedules the
      // animation loop (ADR 0011's "reschedule the loop" — previously
      // unasserted, see review finding 4).
      env.rafCallbacks.length = 0;
      lastResizeObserver().trigger({ width: 150, height: 150 });

      expect(canvas.style.width).toBe('150px');
      expect(canvas.width).toBe(150);
      expect(env.rafCallbacks.length).toBe(1);
      instance.setPaused(false); // no-op; just confirms the instance is alive
    } finally {
      restore();
    }
  });

  // -- update() while dormant (review finding 1) -----------------------------

  it('a shape change is resampled immediately while dormant, not lost on wake', () => {
    const { parent, canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      // Actually zero the *measured* box (not just the synthetic RO
      // delivery below) so a `shape` patch's internal `resolveFillSizeSync()`
      // re-measurement — real box, not the last delivered entry — also
      // finds it degenerate and stays dormant, exactly like a genuine
      // `display: none` parent would.
      setClientBox(parent, { width: 0, height: 0 });
      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant
      mockedSampleCells.mockClear();

      instance.update({ shape: WIDE_SHAPE });

      // Cells depend only on shape/cols/rows (never on the absent surface),
      // so this must happen right away -- deferring it to "whenever the
      // instance next wakes" would lose it permanently, since waking only
      // re-runs applySurface()/buildCache(), never resample().
      expect(mockedSampleCells).toHaveBeenCalledTimes(1);
      expect(mockedSampleCells).toHaveBeenCalledWith(
        WIDE_SHAPE,
        expect.any(Number),
        undefined,
        expect.any(Number),
        'bayer4',
      );
      expect(canvas.style.width).toBe('0px'); // still dormant

      // Waking now fits the *new* shape's aspect ratio (2:1).
      setClientBox(parent, { width: 200, height: 100 });
      lastResizeObserver().trigger({ width: 200, height: 100 });
      expect(canvas.style.width).toBe('200px');
      expect(canvas.style.height).toBe('100px');
    } finally {
      restore();
    }
  });

  it('an fg change picked up while dormant rebuilds the sprite cache on wake even at the same size', () => {
    const { canvas, ctx, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions({ cache: true }));
      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant

      instance.update({ fg: '#ff0000' });
      expect(canvas.style.width).toBe('0px'); // still dormant; patch applied silently

      const createSpy = vi.spyOn(document, 'createElement');
      // Wake at the *same* device size: below the one-cell threshold, so
      // absent the fix this would never rebuild and the strip would stay
      // painted with the old fg indefinitely.
      lastResizeObserver().trigger({ width: 100, height: 100 });

      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(1);
      expect(ctx.fillStyle).toBe('#ff0000');
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  // -- update()-driven wake from dormancy (review finding 1) -----------------
  //
  // The RO-driven wake path (`applyMeasurement` -> `resizeTo` -> `applySurface`,
  // exercised by the two tests above) always restores the CSS size. These
  // two reproduce the two `update()`-driven wake paths instead
  // (`detachFillObserver()` on 'fill' -> number, and `resolveFillSizeSync()`
  // on a reparent/shape change while still in fill mode) — neither ran
  // `applySurface()` when the size they woke up to happened to equal the
  // dormant-retained `sizePx`, leaving the canvas at the `0px` CSS size
  // dormancy set, forever, despite an animating, correctly-sized backing
  // store underneath.

  it("'fill' -> number through update() while dormant restores the CSS size (review finding 1)", () => {
    const { parent, canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('100px');

      setClientBox(parent, { width: 0, height: 0 });
      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant
      expect(canvas.style.width).toBe('0px');
      expect(canvas.width).toBe(100); // backing store retained, not zeroed

      // Waking to the *same* resolved size (100) that dormancy retained --
      // exactly the case `sizePx !== prevSizePx` cannot catch on its own.
      instance.update({ size: 100 });

      expect(canvas.style.width).toBe('100px');
      expect(canvas.style.height).toBe('100px');
      expect(canvas.width).toBe(100);
    } finally {
      restore();
    }
  });

  it("'fill' -> 'fill' reparent through update() while dormant restores the CSS size (review finding 1)", () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    const parentB = document.createElement('div');
    document.body.appendChild(parentB);
    setClientBox(parentB, { width: 100, height: 100 }); // same size as the original parent
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('100px');

      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant
      expect(canvas.style.width).toBe('0px');
      expect(canvas.width).toBe(100);

      parentB.appendChild(canvas); // reparent while dormant, no update() yet
      instance.update({ size: 'fill' }); // 'fill' -> 'fill': reparented, re-measures synchronously

      expect(canvas.style.width).toBe('100px');
      expect(canvas.style.height).toBe('100px');
      expect(canvas.width).toBe(100);
    } finally {
      restore();
      parentB.remove();
    }
  });

  it("'fill' -> 'fill' while still dormant stays dormant through update() (review findings 1, 12)", () => {
    const { parent, canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      setClientBox(parent, { width: 0, height: 0 });
      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant
      expect(canvas.style.width).toBe('0px');

      // An unrelated update() while still genuinely dormant (parent still
      // degenerate) must not fake a wake -- the canvas has to stay at 0px.
      instance.update({ size: 'fill', fg: '#ff0000' });

      expect(canvas.style.width).toBe('0px');
      expect(canvas.style.height).toBe('0px');
    } finally {
      restore();
    }
  });

  // -- update() after destroy() (review findings 2, 12) -----------------------

  it('update() after destroy() is inert and does not resurrect fill state or leak a second ResizeObserver', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      const roCountBefore = env.resizeObserverInstances.length;
      instance.destroy();
      canvas.style.display = 'sentinel-value';

      instance.update({ size: 'fill' });

      expect(env.resizeObserverInstances.length).toBe(roCountBefore); // no new observer
      expect(canvas.style.display).toBe('sentinel-value'); // untouched by a resurrected fill mode
    } finally {
      restore();
    }
  });

  // -- destroy() ---------------------------------------------------------------

  it('the cheap path rescales the existing strip via drawImage with an explicit source/destination rect', () => {
    const { canvas, ctx, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions({ cache: true, frames: 1 }));
      // Built at 100x100 device px (dpr 1, cols 4) -> builtW/builtH = 100.
      ctx.drawImage.mockClear();

      // cell width at build time is 100/4 = 25px; a 10px move stays under it.
      lastResizeObserver().trigger({ width: 110, height: 110 });

      expect(ctx.drawImage).toHaveBeenCalledTimes(1);
      // Sourced at the strip's *build* resolution (frame 0 at 100x100),
      // destined at the *new* device size (110x110) -- a rescale, not a
      // plain 1:1 blit. Reverting to sourcing at the new W/H (`f * W, W, H`)
      // would still pass every other test in this file, which is why this
      // is asserted explicitly (review finding 4).
      expect(ctx.drawImage).toHaveBeenCalledWith(expect.anything(), 0, 0, 100, 100, 0, 0, 110, 110);
    } finally {
      restore();
    }
  });

  // -- reparenting -------------------------------------------------------------

  it('reparenting the canvas retargets the ResizeObserver instead of accumulating parents (review finding 3)', () => {
    const { parent: parentA, canvas } = makeCanvasWithParent();
    setClientBox(parentA, { width: 100, height: 100 });
    const parentB = document.createElement('div');
    document.body.appendChild(parentB);
    setClientBox(parentB, { width: 300, height: 300 });
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    try {
      const instance = createDithered(canvas, fillOptions());
      const ro = lastResizeObserver();
      expect(ro.observedTargets).toEqual([parentA]);

      parentB.appendChild(canvas); // move the canvas to a different parent
      instance.update({ size: 'fill' }); // 'fill' -> 'fill': re-attaches, re-measures
      expect(canvas.style.width).toBe('300px');

      expect(ro.unobserve).toHaveBeenCalledWith(parentA);
      // Exactly the new parent is observed -- not both (previously additive:
      // `observe()` never paired with an `unobserve()` of the old target).
      expect(ro.observedTargets).toEqual([parentB]);
    } finally {
      getContextStub.restore();
      parentB.remove();
    }
  });

  // -- no parent / no observer ------------------------------------------------

  it('falls back to the default size and constructs no observer when there is no parent element (review finding 6)', () => {
    const canvas = document.createElement('canvas'); // deliberately not appended anywhere
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      createDithered(canvas, fillOptions());
      expect(canvas.style.height).toBe('48px'); // DEFAULTS.size
      // ADR 0011: "No parentElement ... attach no observer" -- not merely
      // one that's constructed but idle.
      expect(env.resizeObserverInstances).toHaveLength(0);
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      getContextStub.restore();
      warnSpy.mockRestore();
    }
  });

  it('constructs and attaches the ResizeObserver once a parent appears on a later update() (ADR 0011 recovery)', () => {
    const canvas = document.createElement('canvas'); // starts detached
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(env.resizeObserverInstances).toHaveLength(0);

      const parent = document.createElement('div');
      setClientBox(parent, { width: 120, height: 120 });
      parent.appendChild(canvas);

      // Any update() re-attempts the attachment; the canvas going from no
      // parent to a real one counts as "reparented", so this also forces
      // the synchronous re-measure that fits it immediately.
      instance.update({ fg: '#123456' });

      expect(env.resizeObserverInstances).toHaveLength(1);
      expect(env.resizeObserverInstances[0].observedTargets).toEqual([parent]);
      expect(canvas.style.width).toBe('120px');
    } finally {
      getContextStub.restore();
      warnSpy.mockRestore();
    }
  });

  it("a number -> 'fill' update on a still-detached canvas falls back to the numeric default, matching its own warning (review finding 6)", () => {
    const canvas = document.createElement('canvas'); // never appended
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const instance = createDithered(canvas, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        size: 200,
        cols: 4,
        cache: false,
      });
      expect(canvas.style.height).toBe('200px');

      instance.update({ size: 'fill' });

      // Must match the "using the default size (48)" warning it just
      // logged, not silently keep the previous numeric size.
      expect(canvas.style.height).toBe('48px');
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      getContextStub.restore();
      warnSpy.mockRestore();
    }
  });

  it('without a global ResizeObserver, takes one synchronous measurement and constructs no observer', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('100px'); // the one synchronous measurement still applies
      expect(env.resizeObserverInstances).toHaveLength(0);
    } finally {
      restore();
    }
  });

  it('sets display: block while in fill mode and restores the previous value on exit', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      canvas.style.display = 'inline-block';
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.display).toBe('block');

      instance.update({ size: 80 }); // fill -> number
      expect(canvas.style.display).toBe('inline-block');
    } finally {
      restore();
    }
  });

  it('destroy() restores the pre-fill display value, so a destroy+recreate cycle on the same canvas node does not corrupt it (review finding 1)', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      canvas.style.display = 'inline-block';
      const instance1 = createDithered(canvas, fillOptions());
      expect(canvas.style.display).toBe('block');

      instance1.destroy();
      // Previously left at 'block' forever -- the value a second create()
      // on this same node would (wrongly) capture as "previous".
      expect(canvas.style.display).toBe('inline-block');

      // Simulate a remount on the same DOM node (e.g. React StrictMode's
      // double-invoked mount effect).
      const instance2 = createDithered(canvas, fillOptions());
      expect(canvas.style.display).toBe('block');
      instance2.update({ size: 40 }); // fill -> number

      expect(canvas.style.display).toBe('inline-block');
    } finally {
      restore();
    }
  });

  it('restores the pre-fill display value even without a global ResizeObserver (review finding 5)', () => {
    vi.stubGlobal('ResizeObserver', undefined);
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      canvas.style.display = 'inline-block';
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.display).toBe('block');

      // An unrelated update while still in fill mode must not re-capture
      // `previousDisplay` from the now-'block' value -- it stayed `null`
      // gated on `resizeObserver` being non-null, which never happens here.
      instance.update({ fg: '#123456' });
      instance.update({ size: 60 }); // fill -> number

      expect(canvas.style.display).toBe('inline-block');
    } finally {
      restore();
    }
  });

  // -- fill + DPR combined -----------------------------------------------------

  it('applies a DPR change on top of a fill-fitted size', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions());
      expect(canvas.width).toBe(200); // 100 (fitted) * dpr 2

      env.changeDpr(3);

      expect(canvas.width).toBe(300); // 100 (fitted, unchanged) * dpr 3
      expect(canvas.style.width).toBe('100px'); // CSS size untouched by a DPR-only change
    } finally {
      restore();
    }
  });

  it('a modest DPR change absorbed while dormant forces a full rebuild on wake rather than the cheap path (review finding 7)', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      createDithered(canvas, fillOptions({ cache: true }));
      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant

      // A sub-cell-threshold DPR move (5% of the built width, at cols: 4 a
      // cell is 25%), absorbed while there's nothing to redraw.
      env.changeDpr(2.1);

      const createSpy = vi.spyOn(document, 'createElement');
      lastResizeObserver().trigger({ width: 100, height: 100 }); // wake, same box

      expect(canvas.width).toBe(210); // 100 * dpr 2.1
      // Absent the fix, this DPR move alone would be under the one-cell
      // threshold on wake and would never rebuild the strip at the new
      // resolution.
      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(1);
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  // -- DPR -------------------------------------------------------------------

  it('a DPR change reconfigures the backing store and re-arms the listener on the new ratio', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { canvas, ctx } = makeFakeCanvas();
    createDithered(canvas, {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
    });

    expect(canvas.width).toBe(80); // 40 * dpr 2
    expect(env.mediaQueries.some((m) => m.media === '(resolution: 2dppx)')).toBe(true);

    ctx.clearRect.mockClear();
    env.changeDpr(3);

    expect(canvas.width).toBe(120); // 40 * dpr 3
    expect(ctx.clearRect).toHaveBeenCalled(); // reconfigured + re-blit
    expect(env.mediaQueries.some((m) => m.media === '(resolution: 3dppx)')).toBe(true);
  });

  it('maxDpr clamps the backing store, and a raw change entirely above the clamp re-arms without rebuilding', () => {
    vi.stubGlobal('devicePixelRatio', 4);
    const { canvas, ctx } = makeFakeCanvas();
    createDithered(canvas, {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
      maxDpr: 2,
    });

    expect(canvas.width).toBe(80); // 40 * clamp 2, not 40 * raw 4

    ctx.clearRect.mockClear();
    env.changeDpr(5); // raw moves, but stays entirely above the clamp

    expect(canvas.width).toBe(80); // unchanged
    expect(ctx.clearRect).not.toHaveBeenCalled(); // no rebuild/re-blit
    expect(env.mediaQueries.some((m) => m.media === '(resolution: 5dppx)')).toBe(true); // still re-armed
  });

  it('a DPR change preserves the currently displayed frame instead of resetting to initialFrame (review finding 2)', () => {
    vi.stubGlobal('devicePixelRatio', 2);
    const { canvas, ctx } = makeFakeCanvas();
    // `cache: true` makes `buildCache()` create a *real* offscreen
    // `<canvas>` for the sprite strip; route its `getContext('2d')` to the
    // same recording `ctx` the fake main canvas already uses directly.
    const getContextStub = stubGetContext(ctx);
    try {
      const instance = createDithered(canvas, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        size: 40,
        cols: 4,
        cache: true,
        frames: 10,
      });
      instance.setPaused(true);
      instance.renderFrame(7); // e.g. a determinate `progress` render
      ctx.drawImage.mockClear();

      env.changeDpr(3);

      // `buildCache()` always resets `currentFrame` to -1 internally; absent
      // the fix the following blit reads that reset value and snaps back to
      // `initialFrame` (0) instead of redrawing frame 7.
      const lastCall = ctx.drawImage.mock.calls[ctx.drawImage.mock.calls.length - 1];
      const builtW = 120; // size 40 * new dpr 3
      expect(lastCall).toEqual([
        expect.anything(),
        7 * builtW,
        0,
        builtW,
        builtW,
        0,
        0,
        builtW,
        builtW,
      ]);
    } finally {
      getContextStub.restore();
    }
  });

  // -- destroy() ---------------------------------------------------------------

  it('destroy() disconnects the ResizeObserver and removes the DPR listener, and is idempotent', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      const ro = lastResizeObserver();
      const mqlEntry = env.mediaQueries[env.mediaQueries.length - 1];

      instance.destroy();

      expect(ro.disconnect).toHaveBeenCalled();
      expect(mqlEntry.removeEventListener).toHaveBeenCalledWith('change', expect.any(Function));

      // Idempotency is more than "doesn't throw" (review finding 12): a
      // second `destroy()` must not clobber state the first call already
      // restored, e.g. by re-running `detachFillObserver()` and resetting
      // `display` a second time from whatever it's since been set to.
      canvas.style.display = 'sentinel-value';
      expect(() => instance.destroy()).not.toThrow();
      expect(canvas.style.display).toBe('sentinel-value');
    } finally {
      restore();
    }
  });

  it('destroy() while dormant restores the last resolved CSS size instead of leaving 0px x 0px (review finding 11)', () => {
    const { canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('100px');

      lastResizeObserver().trigger({ width: 0, height: 0 }); // dormant
      expect(canvas.style.width).toBe('0px');

      instance.destroy();

      expect(canvas.style.width).toBe('100px');
      expect(canvas.style.height).toBe('100px');
    } finally {
      restore();
    }
  });

  // -- update() transitions ------------------------------------------------

  it('update() transitions between numeric and fill sizes correctly', () => {
    const { parent, canvas, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        size: 40,
        cols: 4,
        cache: false,
      });
      expect(env.resizeObserverInstances).toHaveLength(0);

      // number -> 'fill': attaches an observer and re-fits.
      instance.update({ size: 'fill' });
      expect(env.resizeObserverInstances).toHaveLength(1);
      const ro = env.resizeObserverInstances[0];
      expect(ro.observedTargets).toContain(parent);
      expect(canvas.style.width).toBe('100px');

      // 'fill' -> 'fill': keeps the same observer instance.
      instance.update({ size: 'fill' });
      expect(env.resizeObserverInstances).toHaveLength(1);

      // An unrelated update() in fill mode preserves the fitted size, even
      // though the parent's box has changed underneath it.
      setClientBox(parent, { width: 300, height: 300 });
      instance.update({ fg: '#123456' });
      expect(canvas.style.width).toBe('100px');

      // 'fill' -> number: disconnects the observer and uses the number.
      instance.update({ size: 80 });
      expect(ro.disconnect).toHaveBeenCalled();
      expect(canvas.style.width).toBe('80px');
    } finally {
      restore();
    }
  });

  it("a live ResizeObserver-delivered size is not clobbered by an explicit `size: 'fill'` patch on an unrelated update (review finding 2)", () => {
    const { canvas, restore } = setup({ width: 200, height: 200 });
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('200px'); // the initial synchronous fit

      // A live RO delivery with a fractional size -- more precise than the
      // synchronous `clientWidth`-based fit.
      lastResizeObserver().trigger({ width: 199.3, height: 199.3 });
      expect(canvas.style.width).toBe('199.3px');

      // Simulates the React wrapper: it always resends `size: 'fill'`
      // alongside every other prop, even though the parent's *measured*
      // box hasn't changed. This must not re-run the coarser synchronous
      // measurement over the fractional RO-delivered one.
      instance.update({ size: 'fill', fg: '#123456' });

      expect(canvas.style.width).toBe('199.3px');
    } finally {
      restore();
    }
  });

  it('update({ paused: true }) does not resample, reconfigure the surface, or rebuild the sprite cache (review finding 3)', () => {
    const { canvas, ctx, restore } = setup({ width: 100, height: 100 });
    try {
      const instance = createDithered(canvas, fillOptions({ cache: true }));
      const callsBefore = mockedSampleCells.mock.calls.length;
      const createSpy = vi.spyOn(document, 'createElement');
      ctx.clearRect.mockClear();

      instance.update({ paused: true });

      expect(mockedSampleCells.mock.calls.length).toBe(callsBefore);
      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(0);
      expect(ctx.clearRect).not.toHaveBeenCalled(); // nothing to redraw
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it("a cheap-path resize that crosses the cache: 'auto' 120px boundary still re-evaluates the strip (review finding 4)", () => {
    // Square shape, cols: 16, dpr 1: built at 118 device px keeps a strip
    // (118 <= 120). 118/16 = 7.375px threshold; a move to 125 (Δ=7) stays
    // under it -- the cheap path -- but 125 > 120 should drop the strip.
    const { canvas, ctx, restore } = setup({ width: 118, height: 118 });
    try {
      const instance = createDithered(canvas, fillOptions({ cache: 'auto', cols: 16 }));
      ctx.drawImage.mockClear();
      instance.renderFrame(0);
      expect(ctx.drawImage).toHaveBeenCalled(); // a strip exists at 118px

      lastResizeObserver().trigger({ width: 125, height: 125 });

      ctx.drawImage.mockClear();
      ctx.fill.mockClear();
      instance.renderFrame(0);
      // Strip dropped (125 > 120): painted directly, not blitted.
      expect(ctx.drawImage).not.toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('the one-cell threshold has a floor above the smallest possible device-pixel delta, so a fine grid does not rebuild on every single-pixel jitter (review finding 5)', () => {
    // cols: 32 at a 30px fill gives a raw threshold of 30/32 = 0.9375
    // device px. Device widths are always whole pixels, so the smallest
    // possible nonzero move is 1px -- which an un-floored (or floored-at-1)
    // threshold would still call a full rebuild every time (`1 >= 0.9375`
    // or `1 >= 1`), i.e. on every single ResizeObserver delivery.
    const { canvas, restore } = setup({ width: 30, height: 30 });
    try {
      createDithered(canvas, fillOptions({ cache: true, cols: 32 }));
      const createSpy = vi.spyOn(document, 'createElement');

      // 30 -> 30.6 CSS px rounds the device width from 30 to 31: a 1px move.
      lastResizeObserver().trigger({ width: 30.6, height: 30.6 });

      expect(canvas.style.width).toBe('30.6px'); // accepted (past the 0.5 epsilon)
      expect(createSpy.mock.calls.filter((c) => c[0] === 'canvas')).toHaveLength(0);
      createSpy.mockRestore();
    } finally {
      restore();
    }
  });

  it('renderFrame() while dormant does not paint into a 0x0 backing store (review finding 7)', () => {
    const { canvas, ctx, restore } = setup({ width: 0, height: 0 }); // degenerate from the start
    try {
      const instance = createDithered(canvas, fillOptions());
      expect(canvas.style.width).toBe('0px'); // dormant from creation

      ctx.clearRect.mockClear();
      ctx.fill.mockClear();
      instance.renderFrame(0);

      expect(ctx.clearRect).not.toHaveBeenCalled();
      expect(ctx.fill).not.toHaveBeenCalled();
    } finally {
      restore();
    }
  });

  it('cache: true at a large resolved size falls back to direct painting instead of a blank strip (review finding 9)', () => {
    // 800 (device px, dpr defaults to 1 in jsdom) * 48 (frames) = 38400,
    // comfortably past the 32767 safe-canvas-dimension cap (review finding
    // 3: the previous 16384 cap was too low and tripped for ordinary
    // instances, so it was raised to a realistic browser maximum -- this
    // box is sized to still exceed even the raised cap).
    const { canvas, ctx, restore } = setup({ width: 800, height: 800 });
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    try {
      const instance = createDithered(canvas, fillOptions({ cache: true, frames: 48 }));
      ctx.drawImage.mockClear();
      ctx.fill.mockClear();

      instance.renderFrame(0);

      // No strip is built -- painted directly instead of blitting a blank one.
      expect(ctx.drawImage).not.toHaveBeenCalled();
      expect(ctx.fill).toHaveBeenCalled();
      expect(warnSpy).toHaveBeenCalled();
    } finally {
      restore();
      warnSpy.mockRestore();
    }
  });

  it('a default-configured retina instance keeps its sprite cache and does not warn (review finding 3)', () => {
    // The previous 16384 cap (checked as `W * frames`) tripped for entirely
    // ordinary configurations once a real DPR was involved -- and did so
    // under `cache: 'auto'`, not just an explicit `cache: true`, logging a
    // warning whose remedy ("pass `cache: false`") made no sense to a
    // caller who never asked for a cache at all.
    vi.stubGlobal('devicePixelRatio', 3);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});

    // Square shape at the cache: 'auto' on-threshold (120px) under dpr 3:
    // W = 360, so the strip would be 360 * 48 = 17280px wide -- suppressed
    // by the old 16384 cap, kept by the corrected one.
    const onThreshold = makeFakeCanvas();
    const onThresholdStub = stubGetContext(onThreshold.ctx);
    try {
      const instance = createDithered(onThreshold.canvas, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        size: 120,
      });
      onThreshold.ctx.drawImage.mockClear();
      instance.renderFrame(1);
      expect(onThreshold.ctx.drawImage).toHaveBeenCalled();
    } finally {
      onThresholdStub.restore();
    }

    // A 3:1 shape at the *default* size (48px) under dpr 3: W = 432, so the
    // strip would be 432 * 48 = 20736px wide -- also wrongly suppressed by
    // the old cap.
    const wideAtDefault = makeFakeCanvas();
    const wideStub = stubGetContext(wideAtDefault.ctx);
    try {
      const instance = createDithered(wideAtDefault.canvas, {
        shape: { path: 'M0 0 H30 V10 H0 Z', viewBox: { x: 0, y: 0, width: 30, height: 10 } },
        brightness: () => true,
      });
      wideAtDefault.ctx.drawImage.mockClear();
      instance.renderFrame(1);
      expect(wideAtDefault.ctx.drawImage).toHaveBeenCalled();
    } finally {
      wideStub.restore();
    }

    expect(warnSpy).not.toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('reconfigures on consecutive DPR changes, leaving a live listener only on the newest MediaQueryList (review finding 10)', () => {
    vi.stubGlobal('devicePixelRatio', 1);
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
    });
    expect(canvas.width).toBe(40);

    env.changeDpr(2);
    expect(canvas.width).toBe(80);

    env.changeDpr(3);
    expect(canvas.width).toBe(120);

    const activeLists = env.mediaQueries.filter((m) => m.listeners.size > 0);
    expect(activeLists).toHaveLength(1);
    expect(activeLists[0].media).toBe('(resolution: 3dppx)');
  });

  it('supports the legacy addListener/removeListener MediaQueryList API (review finding 11)', () => {
    const legacyListeners = new Map<string, Set<() => void>>();
    vi.stubGlobal('devicePixelRatio', 1);
    vi.stubGlobal(
      'matchMedia',
      vi.fn((query: string) => {
        const listeners = new Set<() => void>();
        legacyListeners.set(query, listeners);
        return {
          media: query,
          matches: false,
          addListener: (cb: () => void) => listeners.add(cb),
          removeListener: (cb: () => void) => listeners.delete(cb),
        };
      }),
    );
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
    });

    const firstQuery = '(resolution: 1dppx)';
    expect(legacyListeners.get(firstQuery)?.size).toBe(1);

    instance.destroy();
    expect(legacyListeners.get(firstQuery)?.size).toBe(0);
  });

  it('degrades to no DPR tracking when matchMedia is absent or throws (review finding 11)', () => {
    vi.stubGlobal('matchMedia', undefined);
    const { canvas: canvasA } = makeFakeCanvas();
    expect(() =>
      createDithered(canvasA, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        size: 40,
        cols: 4,
        cache: false,
      }),
    ).not.toThrow();

    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => {
        throw new Error('nope');
      }),
    );
    const { canvas: canvasB } = makeFakeCanvas();
    expect(() =>
      createDithered(canvasB, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        size: 40,
        cols: 4,
        cache: false,
      }),
    ).not.toThrow();
  });

  // -- cache policy against the resolved size --------------------------------

  it("cache: 'auto' is evaluated against the resolved (fill-fitted) size", () => {
    const big = setup({ width: 400, height: 400 });
    try {
      const bigInstance = createDithered(big.canvas, fillOptions({ cache: 'auto' }));
      big.ctx.drawImage.mockClear();
      bigInstance.renderFrame(1);
      // 400px resolves above the auto threshold (120) -> no strip -> the
      // main canvas paints cells directly, never via drawImage.
      expect(big.ctx.drawImage).not.toHaveBeenCalled();
      bigInstance.destroy();
    } finally {
      big.restore();
    }

    const small = setup({ width: 60, height: 60 });
    try {
      const smallInstance = createDithered(small.canvas, fillOptions({ cache: 'auto' }));
      small.ctx.drawImage.mockClear();
      smallInstance.renderFrame(1);
      // 60px resolves at/under the auto threshold -> a strip exists -> the
      // main canvas blits it via drawImage.
      expect(small.ctx.drawImage).toHaveBeenCalled();
      smallInstance.destroy();
    } finally {
      small.restore();
    }
  });
});

// ---------------------------------------------------------------------------
// Playback controls: speed, onFrame, onLoop, setTime/clearTime, and the
// update() structural/runtime split (ADR 0006).
// ---------------------------------------------------------------------------

describe('createDithered playback controls', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;

  beforeEach(() => {
    env = stubAnimationGlobals();
  });

  afterEach(() => {
    env.restore();
  });

  function baseOptions(overrides: Partial<DitheredOptions> = {}): DitheredOptions {
    return {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
      ...overrides,
    };
  }

  /**
   * Spies on `document.createElement`, so a test can assert whether the
   * sprite-strip cache was (re)built without asserting on its contents.
   * Real canvases still get created for non-'canvas' tags and for the
   * caller's own `<canvas>`; jsdom has no 2D context implementation, so
   * a stub context stands in only for the strip itself, keeping the
   * cache path exercised without an unimplemented-API console error.
   */
  function spyCreateElement() {
    const real = document.createElement.bind(document);
    return vi.spyOn(document, 'createElement').mockImplementation(((tag: string) => {
      if (tag !== 'canvas') return real(tag);
      const strip = real('canvas') as HTMLCanvasElement;
      strip.getContext = vi.fn(() => make2dCtx()) as unknown as HTMLCanvasElement['getContext'];
      return strip;
    }) as typeof document.createElement);
  }

  /** The RAF callback most recently registered by `requestAnimationFrame`. */
  function lastTick(): FrameRequestCallback {
    const cb = env.rafCallbacks[env.rafCallbacks.length - 1];
    if (!cb) throw new Error('no animation frame is currently scheduled');
    return cb;
  }

  it('speed=2 advances twice as far per RAF tick as speed=1', () => {
    // Drives a fresh instance through two ticks (a dt=0 baseline, then a
    // 500ms step) and returns the last frame index reported to onFrame.
    function driveTwoTicks(speed: number): number {
      const reported: number[] = [];
      const onFrame = vi.fn((f: number) => reported.push(f));
      const { canvas } = makeFakeCanvas();
      createDithered(canvas, baseOptions({ speed, onFrame }));
      lastTick()(0); // dt=0: establishes lastNow, no movement yet
      lastTick()(500);
      return reported[reported.length - 1]!;
    }

    // period=2000, frames=48: 500ms is a quarter loop at speed 1.
    expect(driveTwoTicks(1)).toBe(12);
    expect(driveTwoTicks(2)).toBe(24);
  });

  it('update({ speed }) does not move the frame at the moment of the change, only the subsequent rate', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ speed: 1, onFrame }));
    lastTick()(0);
    lastTick()(500); // phase 0.25 -> frame 12
    expect(onFrame).toHaveBeenLastCalledWith(12, expect.any(Number));

    onFrame.mockClear();
    instance.update({ speed: 4 }); // non-structural: no repaint at all
    expect(onFrame).not.toHaveBeenCalled();

    // dt=100 at the new speed: +0.2. `initialFrame` (default 0) now
    // seeds `phase` via `phaseForFrame`, not a bare division (finding
    // 3/ADR §1), so the running phase carries a permanent +0.5-frame
    // (1/96) offset from what a naive "starts at exactly 0" reading
    // would suggest: 25/96 + 0.2 = 221/480 -> frame 22, not 21.
    lastTick()(600);
    expect(onFrame).toHaveBeenLastCalledWith(22, expect.any(Number));
  });

  it('negative speed walks the frame index backwards and wraps 0 -> frames - 1', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ speed: -1, onFrame }));
    lastTick()(0);
    // dt=25ms: the seeded phase (1/96, from `phaseForFrame(0, 48)`) has
    // to be overcome before the phase actually goes negative — a dt=1ms
    // nudge no longer crosses 0, it just eats into that half-frame
    // headroom. 25ms clears it (period 2000ms, speed -1: -25/2000 <
    // -1/96) and lands just below 0.
    lastTick()(25);
    expect(onFrame).toHaveBeenLastCalledWith(47, expect.any(Number));
  });

  it('onFrame never fires twice for the same index across consecutive ticks', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onFrame }));
    onFrame.mockClear(); // drop the initial-paint call

    lastTick()(0); // dt=0: no change
    expect(onFrame).not.toHaveBeenCalled();

    lastTick()(1); // dt=1ms: phase 0.0005 -> still frame 0
    expect(onFrame).not.toHaveBeenCalled();

    lastTick()(50); // dt=49ms: phase 0.025 -> frame 1
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame).toHaveBeenLastCalledWith(1, expect.any(Number));

    onFrame.mockClear();
    lastTick()(50.4); // dt=0.4ms: still frame 1
    expect(onFrame).not.toHaveBeenCalled();
  });

  // ADR 0006 test 45 / finding 4. `update({ period })` alone (the
  // original version of this test) is non-structural, so `update()`
  // never even reaches `renderer.ts`'s repaint branch — it passes
  // whether or not the `if (f !== previousFrame)` guard exists at all,
  // because nothing is painted either way. `update({ fg })` is the real
  // case: it's structural, so `configure()` + `blit()` really do
  // repaint (asserted below via `ctx.fill`), and the guard is what keeps
  // `onFrame` silent when that repaint lands on the same frame index it
  // started from.
  it('onFrame does not fire for a repaint at the same frame index', () => {
    const onFrame = vi.fn();
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame }));
    onFrame.mockClear();

    // Non-structural: never reaches the repaint branch at all.
    instance.update({ period: 4000 });
    expect(onFrame).not.toHaveBeenCalled();

    // Structural, but the frame index doesn't move (nothing has ticked
    // the clock): a real repaint happens, and onFrame must stay silent.
    ctx.fill.mockClear();
    instance.update({ fg: '#ff00ff' });
    expect(ctx.fill).toHaveBeenCalled(); // confirms a repaint actually happened
    expect(onFrame).not.toHaveBeenCalled();
  });

  it("onFrame's t is the wrapped phase, always in [0, 1)", () => {
    const seenPhases: number[] = [];
    const onFrame = vi.fn((_f: number, t: number) => seenPhases.push(t));
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onFrame, speed: -1 }));
    lastTick()(0);
    // dt=100ms: large enough to clear the seeded phase's half-frame
    // headroom (1/96, from `phaseForFrame(0, 48)` — see finding 3) and
    // still wrap the phase below 0.
    lastTick()(100);

    for (const t of seenPhases) {
      expect(t).toBeGreaterThanOrEqual(0);
      expect(t).toBeLessThan(1);
    }
    // wrapPhase(1/96 - 100/2000) = wrapPhase(-19/480) = 461/480.
    expect(seenPhases[seenPhases.length - 1]).toBeCloseTo(461 / 480, 6);
  });

  it('onLoop fires once per whole-loop crossing, with the cumulative signed count', () => {
    const onLoop = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onLoop, period: 1000 }));
    lastTick()(0);
    lastTick()(1000); // one full period
    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(onLoop).toHaveBeenLastCalledWith(1);

    lastTick()(2000); // another full period
    expect(onLoop).toHaveBeenCalledTimes(2);
    expect(onLoop).toHaveBeenLastCalledWith(2);
  });

  it('onLoop coalesces several boundary crossings inside one tick into a single call', () => {
    const onLoop = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onLoop, period: 1000 }));
    lastTick()(0);
    lastTick()(5000); // a stall: 5 periods elapse in a single tick
    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(onLoop).toHaveBeenLastCalledWith(5);
  });

  it('onLoop reports -1 when a negative speed wraps backward past 0', () => {
    const onLoop = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onLoop, period: 1000, speed: -1 }));
    lastTick()(0);
    // dt=11ms: the seeded phase (1/96, from `phaseForFrame(0, 48)`) is
    // ~10.4ms of backward travel at this period/speed — dt=1ms no
    // longer crosses the loop boundary, dt=11ms does.
    lastTick()(11);
    expect(onLoop).toHaveBeenCalledTimes(1);
    expect(onLoop).toHaveBeenLastCalledWith(-1);
  });

  it('onFrame fires for the initial paint at initialFrame, at a frame count where initialFrame / frames is not exact', () => {
    // frames: 20, initialFrame: 5 (5/20 = 0.25 exactly) would pass even
    // with the bare-division bug (finding 3) — picking a value where the
    // division isn't float-exact is what makes this test load-bearing.
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onFrame, initialFrame: 1, frames: 48 }));
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(1);
    expect(onFrame.mock.calls[0]![1]).toBeCloseTo(1.5 / 48, 10);
  });

  // ADR 0006 test 40: initialFrame paints exactly that frame for every
  // valid index. The frame counts matter: 48/60/36 are round numbers
  // where a bare `k / frames` happens to round-trip correctly, so a
  // regression to it would slip past them. 49, 22 and 26 are counts
  // where it still fails (49/1 -> 0, 22/15 -> 14, 26/15 -> 14), and
  // they are what actually pins `phaseForFrame` here.
  it('initialFrame paints frame k for every k in [0, frames), at frames 48, 60, 36, 49, 22 and 26', () => {
    for (const frames of [48, 60, 36, 49, 22, 26]) {
      for (let k = 0; k < frames; k++) {
        const onFrame = vi.fn();
        const { canvas } = makeFakeCanvas();
        createDithered(canvas, baseOptions({ onFrame, initialFrame: k, frames }));
        expect(onFrame).toHaveBeenCalledTimes(1);
        expect(onFrame.mock.calls[0]![0]).toBe(k);
      }
    }
  });

  it('setTime halts the internal loop: no new RAF is ever scheduled, and the displayed frame matches what was requested', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, frames: 10 }));
    const rafCountBefore = env.rafCallbacks.length;
    onFrame.mockClear();

    instance.setTime(0.5); // floor(0.5 * 10) = 5

    expect(cancelAnimationFrame).toHaveBeenCalled();
    // The frame actually moved (not just "nothing was scheduled" — a
    // no-op instance would also satisfy that half of the claim).
    expect(onFrame).toHaveBeenLastCalledWith(5, expect.any(Number));
    // ...and nothing was scheduled to move it any further.
    expect(env.rafCallbacks.length).toBe(rafCountBefore);

    // Even an operation that would ordinarily (re)schedule playback —
    // an explicit `setPaused(false)`, a no-op here since the instance
    // was never paused — must not resurrect the internal clock while
    // `time` still owns the phase.
    instance.setPaused(false);
    expect(env.rafCallbacks.length).toBe(rafCountBefore);
  });

  it('setTime paints the frame for the phase; repeated calls within one frame index paint once', () => {
    const onFrame = vi.fn();
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, frames: 10 }));
    onFrame.mockClear();
    ctx.clearRect.mockClear();

    instance.setTime(0.35); // floor(0.35 * 10) = 3
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(3);
    expect(onFrame.mock.calls[0]![1]).toBeCloseTo(0.35);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);

    onFrame.mockClear();
    ctx.clearRect.mockClear();
    instance.setTime(0.38); // still floor(0.38 * 10) = 3
    expect(onFrame).not.toHaveBeenCalled();
    expect(ctx.clearRect).not.toHaveBeenCalled();
  });

  it('setTime never fires onLoop, even crossing a whole-loop boundary, but does fire onFrame', () => {
    const onLoop = vi.fn();
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onLoop, onFrame, frames: 10 }));
    onFrame.mockClear();

    instance.setTime(2.5); // several whole loops away from the initial phase

    expect(onLoop).not.toHaveBeenCalled();
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(5); // wrapPhase(2.5) = 0.5 -> floor(0.5*10)
  });

  it('clearTime resumes the internal clock from the external phase, without a jump', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, frames: 10, period: 1000 }));

    instance.setTime(0.42); // floor(4.2) = 4
    onFrame.mockClear();
    instance.clearTime();

    expect(env.rafCallbacks.length).toBeGreaterThan(0);
    lastTick()(123); // first resumed tick: dt must be 0, so the frame holds
    expect(onFrame).not.toHaveBeenCalled();

    lastTick()(123 + 100); // dt=100: +0.1 from the resumed phase (0.42) -> 0.52 -> frame 5
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(5);
  });

  it('clearTime is a safe no-op when the instance is not currently driven', () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    expect(() => instance.clearTime()).not.toThrow();
  });

  // ADR 0006 test 44 / finding 1. The PRD's flagship use case:
  // `time={scrollY / contentHeight}` is `NaN` on the first render,
  // before layout. A non-finite `t` must not corrupt playback state —
  // the displayed frame holds, neither callback fires, and a later
  // finite `setTime` still works exactly as if the bad call never
  // happened.
  it('setTime(NaN) / setTime(Infinity) leave the displayed frame untouched and fire neither callback', () => {
    const onFrame = vi.fn();
    const onLoop = vi.fn();
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, onLoop, frames: 10 }));

    instance.setTime(0.35); // floor(3.5) = 3, the known-good baseline
    onFrame.mockClear();
    onLoop.mockClear();
    ctx.clearRect.mockClear();

    for (const bad of [NaN, Infinity, -Infinity]) {
      instance.setTime(bad);
      expect(onFrame).not.toHaveBeenCalled();
      expect(onLoop).not.toHaveBeenCalled();
      expect(ctx.clearRect).not.toHaveBeenCalled(); // nothing was repainted
    }

    // Still driveable afterwards: a subsequent finite `setTime` behaves
    // normally, as if the non-finite calls above never happened.
    instance.setTime(0.72); // floor(7.2) = 7
    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(7);
  });

  // Finding 5 (third review). Ignoring the *value* is not the same as
  // ignoring the *call*: passing `time` at all means "this instance is
  // externally driven", so a non-finite `t` must still halt the internal
  // clock. Otherwise `time={scrollY / contentHeight}` would leave the
  // indicator animating freely until layout produced a finite ratio —
  // and native, which treats a non-finite `time` as driving, would hold
  // while web ran.
  it('setTime(NaN) still halts the internal clock, so the displayed frame really does hold', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, frames: 10 }));
    expect(env.rafCallbacks.length).toBe(1); // free-running at mount

    instance.setTime(NaN);
    onFrame.mockClear();

    // No new frame is ever scheduled, and driving the one already in
    // flight paints nothing further.
    const scheduled = env.rafCallbacks.length;
    lastTick()(10_000);
    expect(env.rafCallbacks.length).toBe(scheduled);
    expect(onFrame).not.toHaveBeenCalled();
  });

  // Finding 2 (third review). `speed`/`period`/`initialFrame` reach the
  // accumulator without passing `setTime`'s guard, and nothing but
  // `setTime` ever resets `phase` — so before `advancePhase` was made
  // total, one bad `speed` froze the frame permanently while firing
  // `onLoop(NaN)` on every tick, because `NaN !== NaN`.
  it('a non-finite speed does not poison the accumulator, and update() recovers', () => {
    const onFrame = vi.fn();
    const onLoop = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, onLoop, frames: 10 }));

    lastTick()(0);
    instance.update({ speed: NaN });
    onFrame.mockClear();
    onLoop.mockClear();

    // Ticking with a NaN speed advances nothing and reports nothing —
    // in particular it does not fire onLoop once per frame forever.
    for (let i = 1; i <= 20; i++) lastTick()(i * 16);
    expect(onLoop).not.toHaveBeenCalled();
    expect(onFrame).not.toHaveBeenCalled();

    // And the instance is not wedged: a good speed drives it again.
    instance.update({ speed: 1 });
    lastTick()(20 * 16);
    lastTick()(20 * 16 + 400); // dt=400ms of a 2000ms period -> +0.2
    expect(onFrame).toHaveBeenCalled();
  });

  it('a non-finite period or initialFrame does not wedge playback', () => {
    const onFrame = vi.fn();
    const onLoop = vi.fn();
    const { canvas } = makeFakeCanvas();
    createDithered(canvas, baseOptions({ onFrame, onLoop, frames: 10, initialFrame: Infinity }));
    // `wrapFrame` is total, so the seed falls back to frame 0 rather
    // than seeding the accumulator with NaN. Asserting the painted frame
    // alone would not catch an un-total `wrapFrame`: `frameForPhase` is
    // itself total, so a NaN phase still *paints* frame 0. The tell is
    // `loopsAt(NaN) !== loopsAt(NaN)` — NaN compares unequal to itself —
    // firing `onLoop(NaN)` on every single tick.
    expect(onFrame.mock.calls[0]![0]).toBe(0);
    for (let i = 0; i <= 10; i++) lastTick()(i * 16);
    expect(onLoop).not.toHaveBeenCalled();

    const onFrame2 = vi.fn();
    const { canvas: canvas2 } = makeFakeCanvas();
    const instance = createDithered(canvas2, baseOptions({ onFrame: onFrame2, frames: 10 }));
    lastTick()(0);
    instance.update({ period: 0 }); // dt/0 -> Infinity
    onFrame2.mockClear();
    for (let i = 1; i <= 10; i++) lastTick()(i * 16);
    expect(onFrame2).not.toHaveBeenCalled();
    instance.update({ period: 2000 });
    lastTick()(10 * 16);
    lastTick()(10 * 16 + 400);
    expect(onFrame2).toHaveBeenCalled();
  });

  it('clearTime re-applies `paused`: it does not resume playback while paused is true', () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ paused: true }));
    expect(env.rafCallbacks.length).toBe(0);

    instance.setTime(0.5);
    instance.clearTime();

    expect(env.rafCallbacks.length).toBe(0);
  });

  // The PRD's explicit acceptance criterion: two differently-configured
  // instances handed the same `time` render the same frame, because the
  // frame is a pure function of (phase, frames) with no hidden origin.
  it('two instances given the same time render the same frame', () => {
    let frameA = 0;
    let frameB = 0;
    const onFrameA = vi.fn((f: number) => {
      frameA = f;
    });
    const onFrameB = vi.fn((f: number) => {
      frameB = f;
    });
    const { canvas: canvasA } = makeFakeCanvas();
    const { canvas: canvasB } = makeFakeCanvas();
    const instanceA = createDithered(
      canvasA,
      baseOptions({ onFrame: onFrameA, frames: 24, period: 3000, fg: '#111', cols: 4 }),
    );
    const instanceB = createDithered(
      canvasB,
      baseOptions({ onFrame: onFrameB, frames: 24, period: 700, fg: '#222', cols: 12, gap: 0.2 }),
    );

    for (const t of [0, 0.1, 0.33, 0.5, 0.999, 1.4, -0.2, 2.75]) {
      instanceA.setTime(t);
      instanceB.setTime(t);
      expect(frameA).toBe(frameB);
    }
  });

  it('update({ speed }) / update({ period }) / update({ paused }) do not rebuild the sprite strip', () => {
    const createElementSpy = spyCreateElement();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ cache: true }));
    createElementSpy.mockClear(); // drop the initial build

    instance.update({ speed: 3 });
    instance.update({ period: 5000 });
    instance.update({ paused: true });

    expect(createElementSpy).not.toHaveBeenCalledWith('canvas');
    createElementSpy.mockRestore();
  });

  it('update() re-passing identical structural values (e.g. a React re-render) is also a no-op rebuild', () => {
    const createElementSpy = spyCreateElement();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ cache: true, fg: '#123456' }));
    createElementSpy.mockClear(); // drop the initial build

    // The React wrapper builds a full options object from its props on
    // every render, so `fg`/`cols`/`size` are compared by value, not
    // just presence, against what's already resolved.
    instance.update({ fg: '#123456', cols: 4, size: 40 });

    expect(createElementSpy).not.toHaveBeenCalledWith('canvas');
    createElementSpy.mockRestore();
  });

  it('update({ cols }) does rebuild the sprite strip', () => {
    const createElementSpy = spyCreateElement();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ cache: true }));
    createElementSpy.mockClear(); // drop the initial build

    instance.update({ cols: 8 });

    expect(createElementSpy).toHaveBeenCalledWith('canvas');
    createElementSpy.mockRestore();
  });

  it('update({ frames }) preserves the phase rather than the raw frame index', () => {
    const onFrame = vi.fn();
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, frames: 10 }));

    instance.setTime(0.5); // frame floor(0.5 * 10) = 5
    onFrame.mockClear();
    instance.update({ frames: 20 }); // same phase 0.5 -> floor(0.5 * 20) = 10, not 5 % 20

    expect(onFrame).toHaveBeenCalledTimes(1);
    expect(onFrame.mock.calls[0]![0]).toBe(10);
  });

  // ADR 0006 test 41 / finding 6: `setPaused()` and `update()` disagreed
  // about who owns `paused` — `update()` unconditionally reset it back
  // to the resolved option, discarding whatever `setPaused()` last set
  // whenever the patch didn't itself touch `paused`.
  it('update({ speed }) does not resurrect a paused value overridden by setPaused()', () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ paused: true }));
    expect(env.rafCallbacks.length).toBe(0);

    instance.setPaused(false);
    expect(env.rafCallbacks.length).toBe(1);

    instance.update({ speed: 2 });

    // `update()`'s own schedule()/halt() call can't tell us anything by
    // itself here (whether paused or not, `raf` is already non-zero, so
    // `schedule()`'s guard is a no-op either way) — the tell is whether
    // the *next* tick reschedules itself. If `update()` silently reset
    // `isPaused` back to the mount-time `true`, the pending tick's own
    // `schedule()` call bails and playback stops dead; if not, it keeps
    // rescheduling.
    const before = env.rafCallbacks.length;
    lastTick()(0);
    expect(env.rafCallbacks.length).toBe(before + 1);
  });

  it('pausing and resuming does not jump the phase', () => {
    // dt values deliberately avoid landing the phase exactly on a frame
    // boundary (e.g. 0.3, 0.4 of a 10-frame loop) — floating point makes
    // `wrapPhase` of an exact boundary an unreliable side of the floor(),
    // which is a test-authoring hazard here, not a playback bug.
    const onFrame = vi.fn();
    const lastFrame = () => onFrame.mock.calls[onFrame.mock.calls.length - 1]?.[0];
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ onFrame, frames: 10, period: 1000 }));
    lastTick()(0);
    lastTick()(333); // phase 0.333 -> frame 3
    expect(lastFrame()).toBe(3);

    instance.setPaused(true);
    instance.setPaused(false); // resume — long afterwards in wall-clock terms

    lastTick()(999_999); // huge `now`, but dt must be 0 on the first resumed tick
    expect(lastFrame()).toBe(3); // unchanged: no jump

    // dt=133 now behaves normally from the resumed phase. The seeded
    // phase (0.05, from `phaseForFrame(0, 10)`) carries through: 0.383 +
    // 0.133 = 0.516 -> frame 5, not 4.
    lastTick()(999_999 + 133);
    expect(lastFrame()).toBe(5);
  });

  // ADR 0006 test 51 / finding 9. Before ADR 0006, `update()`
  // unconditionally called `halt()`; the structural/runtime split (§4)
  // narrowed that to `isPaused || driven`, silently dropping the case
  // where an update newly makes `reduced` true. `schedule()` at the call
  // site after it is itself guarded against *scheduling a new* frame,
  // but does nothing about a frame *already in flight* — so without also
  // halting on `reduced`, the pending RAF runs one more time before the
  // guard finally takes effect.
  it('update() that newly forbids playback via reduced motion cancels the in-flight RAF', () => {
    // matchMedia matches from the start, but `respectReducedMotion:
    // false` means the instance ignores it and schedules normally.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ respectReducedMotion: false }));
    expect(env.rafCallbacks.length).toBe(1);

    (cancelAnimationFrame as unknown as ReturnType<typeof vi.fn>).mockClear();
    const rafCountBefore = env.rafCallbacks.length;

    // Now `reduced` newly becomes true: `isPaused` and `driven` are both
    // still false, so only a check against `reduced` itself can catch this.
    instance.update({ respectReducedMotion: true });

    expect(cancelAnimationFrame).toHaveBeenCalled();
    // And nothing new was scheduled in its place.
    expect(env.rafCallbacks.length).toBe(rafCountBefore);
  });
});

// ---------------------------------------------------------------------------
// transitions (ADR 0004): transitionTo() / finishLoop()
// ---------------------------------------------------------------------------

describe('createDithered transitions', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;
  let mockNow: number;
  let nowSpy: ReturnType<typeof vi.spyOn>;

  function baseOptions(overrides: Partial<DitheredOptions> = {}): DitheredOptions {
    return {
      shape: SQUARE_SHAPE,
      brightness: () => true,
      size: 40,
      cols: 4,
      cache: false,
      period: 1000,
      frames: 10,
      ...overrides,
    };
  }

  // Fires the most recently *scheduled* animation frame. stubAnimationGlobals
  // never removes a cancelled callback from `rafCallbacks`, but createDithered
  // only ever reads `raf`'s return value to decide whether to re-schedule, so
  // the last entry is always the one that matters next.
  function fire(ts: number): void {
    const cbs = env.rafCallbacks;
    cbs[cbs.length - 1](ts);
  }

  beforeEach(() => {
    env = stubAnimationGlobals();
    mockNow = 0;
    nowSpy = vi.spyOn(performance, 'now').mockImplementation(() => mockNow);
  });

  afterEach(() => {
    env.restore();
    nowSpy.mockRestore();
  });

  it('transitionTo resolves after duration of ticks and leaves the instance in the target state', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    ctx.fill.mockClear();

    mockNow = 1000;
    let resolved = false;
    const promise = instance
      .transitionTo({ brightness: () => false, transition: { duration: 400 } })
      .then(() => {
        resolved = true;
      });

    // The first transition frame paints synchronously, at progress 0 —
    // still the outgoing (always-true) brightness, so cells are drawn.
    expect(ctx.fill.mock.calls.length).toBeGreaterThan(0);

    ctx.fill.mockClear();
    mockNow = 1200; // 200ms into a 400ms morph: not done yet.
    fire(1200);
    await Promise.resolve();
    expect(resolved).toBe(false);

    ctx.fill.mockClear();
    mockNow = 1400; // exactly at duration: progress reaches 1.
    fire(1400);
    await promise;
    expect(resolved).toBe(true);
    // Target brightness is always-false: the completed steady state draws
    // nothing for this tick...
    expect(ctx.fill).not.toHaveBeenCalled();

    // ...and for a later one, at a different frame index, confirming this
    // is the new steady state rather than a one-off empty transition frame.
    ctx.fill.mockClear();
    mockNow = 1500;
    fire(1500);
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it("repaints every tick during a morph, unlike steady state's skip-if-unchanged shortcut", () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    mockNow = 1000;
    void instance.transitionTo({ brightness: () => true, transition: { duration: 1000 } });
    ctx.clearRect.mockClear();

    mockNow = 1100;
    fire(1100);
    expect(ctx.clearRect).toHaveBeenCalledTimes(1);

    // Same instant again: a steady loop computes the same frame index and
    // skips the redraw entirely. A morph must not — p is continuous.
    fire(1100);
    expect(ctx.clearRect).toHaveBeenCalledTimes(2);
  });

  it('drops the sprite strip for the morph and rebuilds it once the steady state resumes', () => {
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    const canvas = document.createElement('canvas');

    try {
      const instance = createDithered(canvas, baseOptions({ cache: true }));

      // Before: the initial steady-state paint is cached, so it draws via drawImage.
      expect(ctx.drawImage).toHaveBeenCalled();

      ctx.drawImage.mockClear();
      mockNow = 1000;
      void instance.transitionTo({ brightness: () => false, transition: { duration: 400 } });
      // During: the strip is dropped — the transition paints cells directly.
      expect(ctx.drawImage).not.toHaveBeenCalled();

      mockNow = 1200;
      fire(1200);
      expect(ctx.drawImage).not.toHaveBeenCalled();

      ctx.drawImage.mockClear();
      mockNow = 1400;
      fire(1400); // progress reaches 1: completes, configure() rebuilds the strip.
      // After: back to drawImage for the new steady state.
      expect(ctx.drawImage).toHaveBeenCalled();
    } finally {
      getContextStub.restore();
    }
  });

  it('prefers-reduced-motion skips the morph and cuts straight to the target', async () => {
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());
    ctx.fill.mockClear();

    const promise = instance.transitionTo({
      brightness: () => false,
      transition: { duration: 5000 },
    });

    // No tick needed at all — it's already resolved.
    await promise;
    // Target's always-false brightness, applied immediately.
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('finishLoop() resolves when the frame index wraps to 0', async () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    let resolved = false;
    void instance.finishLoop().then(() => {
      resolved = true;
    });

    // The first tick after create() always sees dt=0 (lastNow starts
    // null), so this just establishes the baseline timestamp — phase
    // doesn't move yet, and no wrap has happened.
    mockNow = 500;
    fire(500);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // dt=700ms out of a 1000ms period advances phase by 0.7 from its
    // ~0.05 seed — not yet a full loop, so still no wrap.
    mockNow = 1200;
    fire(1200);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // dt=950ms more crosses the 1.0 phase boundary: the loop has wrapped.
    mockNow = 2150;
    fire(2150);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('finishLoop() resolves when playback halts (paused) without a wrap', async () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    let resolved = false;
    void instance.finishLoop().then(() => {
      resolved = true;
    });

    instance.setPaused(true);
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('finishLoop() resolves immediately when the loop is already halted', async () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ paused: true }));

    let resolved = false;
    void instance.finishLoop().then(() => {
      resolved = true;
    });
    await Promise.resolve();
    expect(resolved).toBe(true);
  });

  it('transition.onLoopEnd defers the morph until after the loop wraps', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    mockNow = 0;
    let resolved = false;
    const promise = instance
      .transitionTo({ brightness: () => false, transition: { onLoopEnd: true, duration: 200 } })
      .then(() => {
        resolved = true;
      });

    // The first tick after create() always sees dt=0 (lastNow starts
    // null) — this just establishes the baseline timestamp, no wrap yet.
    mockNow = 500;
    fire(500);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // dt=700ms out of a 1000ms period: not yet a full loop.
    mockNow = 1200;
    fire(1200);
    await Promise.resolve();
    expect(resolved).toBe(false);

    ctx.fill.mockClear();
    // dt=950ms more crosses the 1.0 phase boundary: wraps, deferred morph begins.
    mockNow = 2150;
    fire(2150);
    await Promise.resolve(); // flush finishLoop()'s `.then(begin)`

    mockNow = 2350; // 200ms after the morph actually started at 2150.
    fire(2350);
    await promise;
    expect(resolved).toBe(true);
  });

  it('a second transitionTo mid-morph resolves the first and lands on the second target', async () => {
    const { canvas } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    mockNow = 1000;
    let firstResolved = false;
    void instance
      .transitionTo({ brightness: () => false, transition: { duration: 1000 } })
      .then(() => {
        firstResolved = true;
      });

    mockNow = 1200;
    fire(1200); // 200ms into the first (1000ms) morph — nowhere near done.
    await Promise.resolve();
    expect(firstResolved).toBe(false);

    // A second call cuts the first one short: its target becomes the
    // steady state and its own promise resolves right away.
    let secondResolved = false;
    const second = instance
      .transitionTo({ brightness: () => true, transition: { duration: 400 } })
      .then(() => {
        secondResolved = true;
      });

    await Promise.resolve();
    expect(firstResolved).toBe(true);
    expect(secondResolved).toBe(false);

    mockNow = 1600; // 400ms after the second morph started at 1200.
    fire(1600);
    await second;
    expect(secondResolved).toBe(true);
  });

  it('destroy() resolves pending finishLoop/transitionTo promises, tears down listeners, and releases the strip', async () => {
    const removeSpy = vi.spyOn(document, 'removeEventListener');
    const ctx = make2dCtx();
    const getContextStub = stubGetContext(ctx);
    const canvas = document.createElement('canvas');

    try {
      const instance = createDithered(canvas, baseOptions({ cache: true }));

      let loopEndResolved = false;
      void instance.finishLoop().then(() => {
        loopEndResolved = true;
      });

      mockNow = 1000;
      let transitionResolved = false;
      void instance
        .transitionTo({ brightness: () => false, transition: { duration: 1000 } })
        .then(() => {
          transitionResolved = true;
        });

      instance.destroy();
      await Promise.resolve();

      expect(loopEndResolved).toBe(true);
      expect(transitionResolved).toBe(true);
      expect(cancelAnimationFrame).toHaveBeenCalled();
      expect(env.ioInstances[0].disconnect).toHaveBeenCalled();
      expect(removeSpy).toHaveBeenCalledWith('visibilitychange', expect.any(Function));

      // The sprite strip is released, not just abandoned: a renderFrame()
      // call afterward has nothing cached left to drawImage from.
      ctx.drawImage.mockClear();
      instance.renderFrame(0);
      expect(ctx.drawImage).not.toHaveBeenCalled();
    } finally {
      getContextStub.restore();
      removeSpy.mockRestore();
    }
  });

  // -------------------------------------------------------------------------
  // Regression tests for review findings 1, 2, 8 and 10 (see the ADR 0004
  // implementation review this fixes).
  // -------------------------------------------------------------------------

  it('a halt during the onLoopEnd wait settles the deferred transition instead of stranding it (finding 1)', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    mockNow = 0;
    let resolved = false;
    const promise = instance
      .transitionTo({ brightness: () => false, transition: { onLoopEnd: true, duration: 200 } })
      .then(() => {
        resolved = true;
      });

    mockNow = 500; // frame 5 — not a wrap yet, so the morph is still queued.
    fire(500);
    await Promise.resolve();
    expect(resolved).toBe(false);

    // Playback halts (equivalently: tab hidden, canvas off-screen) while
    // the deferred morph is still waiting for a wrap that will now never
    // come — this must not hang the promise, nor leave the instance
    // showing the outgoing (pre-`transitionTo`) state forever.
    instance.setPaused(true);
    await Promise.resolve();
    expect(resolved).toBe(true);

    // The target's brightness (always false) must have been adopted, not
    // left on the outgoing always-true brightness.
    ctx.fill.mockClear();
    instance.renderFrame(0);
    expect(ctx.fill).not.toHaveBeenCalled();

    // Advancing the clock far past when the wrap *would* have released the
    // morph must not replay it — it was already settled.
    ctx.fill.mockClear();
    mockNow = 100_000;
    instance.setPaused(false);
    fire(100_000);
    expect(ctx.fill).not.toHaveBeenCalled();
  });

  it('a plain update() during an onLoopEnd wait is not reverted when the deferred morph fires (finding 2)', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions({ fg: '#aaa' }));

    mockNow = 0;
    void instance.transitionTo({ fg: '#bbb', transition: { onLoopEnd: true, duration: 100 } });

    mockNow = 500; // no wrap yet.
    fire(500);

    // A plain update() lands while the deferred morph is still queued.
    mockNow = 600;
    instance.update({ fg: '#ccc' });
    expect(ctx.fillStyle).toBe('#ccc');

    // Advance the frame index away from 0 before checking for a wrap, so
    // this doesn't depend on whichever frame `update()` itself happens to
    // paint.
    mockNow = 700;
    fire(700);

    // The loop wraps, releasing the deferred morph (if it's still queued
    // at all — see below). Release happens off a microtask (the old
    // `finishLoopPromise().then(begin)` chain), so flush one before
    // asserting.
    ctx.fill.mockClear();
    mockNow = 1600; // phase 600/1000 -> frame 6, less than frame 7 at t=700: wraps.
    fire(1600);
    await Promise.resolve();

    // The deferred morph must not silently revert the newer update() — the
    // steady state stays on '#ccc', not the stale '#bbb' from the earlier
    // transitionTo call.
    expect(ctx.fillStyle).toBe('#ccc');
  });

  it('a later transitionTo is not reverted when an earlier onLoopEnd morph fires (finding 2)', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    mockNow = 0;
    // Queued: morph to "draw nothing" once the loop wraps.
    void instance.transitionTo({
      brightness: () => false,
      transition: { onLoopEnd: true, duration: 100 },
    });

    mockNow = 600; // still no wrap.
    fire(600);

    // A newer, immediate transitionTo lands and completes before the wrap.
    // `onLoopEnd: false` is explicit: the resolved `transition` option is
    // sticky like every other option (a patch only overrides what it
    // sets), so without this it would inherit `onLoopEnd: true` from the
    // first call and queue behind a wrap too.
    let secondResolved = false;
    const second = instance
      .transitionTo({
        brightness: () => true,
        transition: { duration: 300, onLoopEnd: false },
      })
      .then(() => {
        secondResolved = true;
      });

    // 300ms after the second morph started at 600: it completes, painting
    // through the tick itself (brightness true -> cells drawn). Checking
    // via the tick's own paint, rather than a separate `renderFrame()`
    // call, matters here: `renderFrame()` also writes `currentFrame`, and
    // an incidental write would mask the wrap this test depends on below.
    ctx.fill.mockClear();
    mockNow = 900;
    fire(900);
    await second;
    expect(secondResolved).toBe(true);
    expect(ctx.fill).toHaveBeenCalled(); // brightness true: steady state draws.

    // The loop wraps well after the second transitionTo completed —
    // releasing the *first* (now stale) queued morph must not revert the
    // newer steady state back to "draw nothing". Release happens off a
    // microtask (the old `finishLoopPromise().then(begin)` chain), so
    // flush one before letting a further tick observe its effect.
    mockNow = 1100; // phase 100/1000 -> frame 1, less than frame 9 at t=900: wraps.
    fire(1100);
    await Promise.resolve();

    // Give a wrongly-restarted stale morph (the bug: the first call's
    // `.then(begin)` firing a *new* transition toward brightness-false)
    // time to run to completion, and check the steady state is still the
    // newer one, not reverted.
    ctx.fill.mockClear();
    mockNow = 1300;
    fire(1300);
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('a reduced-motion cut holds the current phase instead of resetting to initialFrame (finding 8)', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    // `t` is passed straight through as the numeric brightness: at phase 0
    // no cell can clear its (strictly positive) Bayer threshold, so frame 0
    // always draws nothing, while a later frame draws at least one cell.
    const instance = createDithered(canvas, baseOptions({ brightness: (_cell, t) => t }));

    // The first tick after create() always sees dt=0 (lastNow starts
    // null), so this just establishes the baseline timestamp.
    mockNow = 500;
    fire(500);
    // dt=700ms out of a 1000ms period advances phase to ~0.75 from its
    // ~0.05 seed -> frame 7 of 10.
    mockNow = 1200;
    fire(1200);

    // Reduced motion turns on *after* the loop has already advanced away
    // from frame 0/initialFrame.
    vi.stubGlobal(
      'matchMedia',
      vi.fn(() => ({ matches: true })),
    );
    ctx.fill.mockClear();

    await instance.transitionTo({ transition: { duration: 300 } });

    // Fixed: holds frame 7 (phase 0.7), which draws cells. The pre-fix
    // dead ternary always fell back to `initialFrame` (0, phase 0), which
    // draws nothing at all.
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('morphs the shape itself, resampling onto the target grid (ADR 0004 §2)', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    // `rozenite`'s viewBox (18.67 x 26.67) resolves to a different row
    // count than the 1:1 SQUARE_SHAPE at the same `cols` — so completing
    // this morph must leave the instance on rozenite's own grid/surface,
    // not a hybrid of the two.
    const instance = createDithered(canvas, baseOptions({ shape: SQUARE_SHAPE }));

    const cssWidthBefore = canvas.style.width;

    mockNow = 1000;
    const promise = instance.transitionTo({
      shape: rozenite,
      transition: { duration: 400 },
    });

    // The surface resizes onto the target immediately (ADR 0004 §5), in
    // the same synchronous call — not deferred until the morph completes.
    expect(canvas.style.width).not.toBe(cssWidthBefore);

    ctx.fill.mockClear();
    mockNow = 1400;
    fire(1400);
    await promise;

    // Steady state after the morph draws using rozenite's own cells, not
    // an empty/stale set left over from the square.
    ctx.fill.mockClear();
    instance.renderFrame(0);
    expect(ctx.fill).toHaveBeenCalled();
  });

  it('never paints an empty frame during a morph, at any tick (finding 10, ADR acceptance criterion)', () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(
      canvas,
      baseOptions({ shape: SQUARE_SHAPE, brightness: () => true }),
    );

    mockNow = 0;
    void instance.transitionTo({
      shape: rozenite,
      brightness: () => true,
      transition: { duration: 1000 },
    });

    // Sweep every 25ms across the whole morph; at each tick, the paint
    // must have drawn at least one cell (paintFrame calls ctx.fill() once
    // per drawn cell) — the end-to-end version of the cell-set-level
    // guarantee `core/transition.test.ts` already covers.
    for (let t = 0; t <= 1000; t += 25) {
      ctx.fill.mockClear();
      mockNow = t;
      fire(t);
      expect(ctx.fill.mock.calls.length).toBeGreaterThan(0);
    }
  });

  it('a morph in flight completes immediately when playback is paused mid-morph (ADR 0004 §7)', async () => {
    const { canvas, ctx } = makeFakeCanvas();
    const instance = createDithered(canvas, baseOptions());

    mockNow = 1000;
    let resolved = false;
    const promise = instance
      .transitionTo({ brightness: () => false, transition: { duration: 1000 } })
      .then(() => {
        resolved = true;
      });

    mockNow = 1200; // 200ms into a 1000ms morph.
    fire(1200);
    expect(resolved).toBe(false);

    instance.setPaused(true);
    await promise;
    expect(resolved).toBe(true);

    // The target (always-false brightness) was adopted, not left half-morphed.
    ctx.fill.mockClear();
    instance.renderFrame(0);
    expect(ctx.fill).not.toHaveBeenCalled();
  });
});
