import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDithered, frameAt, paintFrame, type DitheredOptions } from './renderer';
import type { Cell } from './shape';
import {
  SQUARE_SHAPE,
  make2dCtx,
  makeFakeCanvas,
  stubAnimationGlobals,
  stubGetContext,
} from './test-utils';

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
    instance.update({}); // reconfigures (rebuilds the strip) without touching fg

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

      ctx.fill.mockClear();
      expect(() => instance.update({ period: 3000 })).not.toThrow();
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
