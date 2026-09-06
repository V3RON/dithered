import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { createDithered, frameAt, paintFrame, type DitheredOptions } from './renderer';
import type { Cell } from './shape';
import { SQUARE_SHAPE, makeFakeCanvas, stubAnimationGlobals } from './test-utils';

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
});
