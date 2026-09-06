import { render, screen } from '@testing-library/react';
import { createRef } from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { Dithered } from './react';
import type { DitheredInstance } from './renderer';
import { SQUARE_SHAPE, make2dCtx, stubAnimationGlobals } from './test-utils';

vi.mock('./renderer', async () => {
  const actual = await vi.importActual<typeof import('./renderer')>('./renderer');
  return { ...actual, createDithered: vi.fn(actual.createDithered) };
});

// eslint-disable-next-line import/first -- must come after vi.mock so it resolves to the mock.
import { createDithered } from './renderer';

const mockedCreateDithered = createDithered as unknown as ReturnType<
  typeof vi.fn<typeof createDithered>
>;

function lastInstance(): DitheredInstance {
  const results = mockedCreateDithered.mock.results;
  return results[results.length - 1]!.value as DitheredInstance;
}

describe('Dithered', () => {
  let env: ReturnType<typeof stubAnimationGlobals>;
  let getContextSpy: { mockRestore: () => void };

  beforeEach(() => {
    mockedCreateDithered.mockClear();
    env = stubAnimationGlobals();
    const ctx = make2dCtx();
    getContextSpy = vi
      .spyOn(HTMLCanvasElement.prototype, 'getContext')
      .mockReturnValue(ctx as unknown as RenderingContext) as unknown as {
      mockRestore: () => void;
    };
  });

  afterEach(() => {
    env.restore();
    getContextSpy.mockRestore();
  });

  it('renders a canvas with role="status" and an aria-label by default', () => {
    render(<Dithered shape={SQUARE_SHAPE} />);
    const canvas = screen.getByRole('status');
    expect(canvas.tagName).toBe('CANVAS');
    expect(canvas).toHaveAttribute('aria-label', 'Loading');
  });

  it('label="" hides the canvas from assistive tech and drops the role', () => {
    render(<Dithered shape={SQUARE_SHAPE} label="" />);
    expect(screen.queryByRole('status')).toBeNull();
    const canvas = document.querySelector('canvas')!;
    expect(canvas).toHaveAttribute('aria-hidden', 'true');
    expect(canvas).not.toHaveAttribute('aria-label');
  });

  it('forwards the ref to the underlying canvas element', () => {
    const ref = createRef<HTMLCanvasElement>();
    render(<Dithered ref={ref} shape={SQUARE_SHAPE} />);
    expect(ref.current).toBeInstanceOf(HTMLCanvasElement);
  });

  it('creates exactly one instance on mount and destroys it on unmount', () => {
    const { unmount } = render(<Dithered shape={SQUARE_SHAPE} />);
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);

    const destroySpy = vi.spyOn(lastInstance(), 'destroy');
    unmount();
    expect(destroySpy).toHaveBeenCalledTimes(1);
  });

  it('re-rendering with a new fg calls update() and does not recreate the instance', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} fg="#111111" />);
    const updateSpy = vi.spyOn(lastInstance(), 'update');

    rerender(<Dithered shape={SQUARE_SHAPE} fg="#ff00ff" />);

    expect(updateSpy).toHaveBeenCalledWith(expect.objectContaining({ fg: '#ff00ff' }));
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });

  it('toggling paused calls setPaused with the new value', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} paused={false} />);
    const setPausedSpy = vi.spyOn(lastInstance(), 'setPaused');

    rerender(<Dithered shape={SQUARE_SHAPE} paused={true} />);
    expect(setPausedSpy).toHaveBeenCalledWith(true);

    rerender(<Dithered shape={SQUARE_SHAPE} paused={false} />);
    expect(setPausedSpy).toHaveBeenCalledWith(false);
  });

  it('progress={0.5} pauses and renders the expected frame index (default frames=48)', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} />);
    const instance = lastInstance();
    const setPausedSpy = vi.spyOn(instance, 'setPaused');
    const renderFrameSpy = vi.spyOn(instance, 'renderFrame');

    rerender(<Dithered shape={SQUARE_SHAPE} progress={0.5} />);

    expect(setPausedSpy).toHaveBeenCalledWith(true);
    // round(0.5 * (48 - 1)) = round(23.5) = 24
    expect(renderFrameSpy).toHaveBeenCalledWith(24);
  });

  it('does not recreate the instance when only progress changes', () => {
    const { rerender } = render(<Dithered shape={SQUARE_SHAPE} progress={0} />);
    rerender(<Dithered shape={SQUARE_SHAPE} progress={1} />);
    expect(mockedCreateDithered).toHaveBeenCalledTimes(1);
  });
});
