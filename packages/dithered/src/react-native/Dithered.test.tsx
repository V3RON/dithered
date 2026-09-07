import { act, render } from '@testing-library/react';
import * as React from 'react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// ---------------------------------------------------------------------------
// Mocks — following the style of native/hit-test.test.ts and
// native/transition.test.ts: @shopify/react-native-skia is mocked so
// `createPicture` records synchronously through a fake canvas we can
// inspect, and `Skia.Path.MakeFromSVGString` distinguishes shapes by path
// string so a "square" and a "not-square" shape sample to different cell
// sets without needing a real Path2D/SkPath.
//
// react-native and react-native-reanimated are mocked too: this file is
// the first to render `<Dithered>` itself (rather than its sub-hooks), so
// it needs AppState, the frame-callback driver, and the wrap-detection
// reaction all available for the test to drive by hand.
// ---------------------------------------------------------------------------

/** A path string standing in for "the square" — the only shape our fake hit-tester accepts. */
const SQUARE_PATH = 'M0 0 H10 V10 H0 Z';
/** Any other path — the fake hit-tester rejects every point sampled against it. */
const OTHER_PATH = 'M0 0 H10 V10 H0 Z#other';

const SQUARE_SHAPE = { path: SQUARE_PATH, viewBox: { x: 0, y: 0, width: 10, height: 10 } };
const OTHER_SHAPE = { path: OTHER_PATH, viewBox: { x: 0, y: 0, width: 10, height: 10 } };

// `hitTest` is explicit rather than left to default to `jsHitTester`
// (which would try to actually parse `OTHER_PATH`'s deliberately-invalid
// `"#other"` suffix): `skiaHitTester` delegates entirely to the mocked
// `Skia.Path.MakeFromSVGString` below, so it distinguishes the two shapes
// exactly as this file's mock intends without touching a real path parser.

const makeFromSVGString = vi.fn((d: string) => ({
  contains: () => d === SQUARE_PATH,
}));

const createPictureImpl = vi.fn((recorder: (canvas: unknown) => void, bounds: unknown): unknown => {
  const canvas = { drawRect: vi.fn(), drawRRect: vi.fn() };
  recorder(canvas);
  return { bounds, canvas };
});

vi.mock('@shopify/react-native-skia', () => ({
  Skia: {
    Path: { MakeFromSVGString: (d: string) => makeFromSVGString(d) },
    Paint: () => ({ setAntiAlias: vi.fn(), setColor: vi.fn() }),
    Color: (c: string) => `color:${c}`,
    XYWHRect: (x: number, y: number, width: number, height: number) => ({ x, y, width, height }),
    RRectXY: (rect: unknown, rx: number, ry: number) => ({ rect, rx, ry }),
  },
  createPicture: (recorder: (canvas: unknown) => void, bounds: unknown) =>
    createPictureImpl(recorder, bounds),
  // Minimal stand-ins: this file never asserts on the rendered tree, only
  // on the shared-value objects these components receive as props.
  Canvas: ({ children }: { children?: React.ReactNode }) =>
    React.createElement(React.Fragment, null, children),
  Picture: ({ picture }: { picture: { value: unknown } }) => {
    lastPictureShared = picture;
    return null;
  },
}));

vi.mock('react-native', () => ({
  AppState: {
    currentState: 'active',
    addEventListener: vi.fn(() => ({ remove: vi.fn() })),
  },
}));

interface FrameCallbackEntry {
  cb: (info: { timeSinceFirstFrame: number }) => void;
  active: boolean;
}
interface ReactionEntry {
  react: (curr: unknown, prev: unknown) => void;
}

let frameCallbackEntries: FrameCallbackEntry[] = [];
let reactionEntries: ReactionEntry[] = [];
let reducedMotionValue = false;
let lastPictureShared: { value: unknown } | null = null;

vi.mock('react-native-reanimated', () => ({
  // A real `useRef` under the hood, so each shared value stays the same
  // mutable object across re-renders — exactly what lets a manually-driven
  // "worklet" tick mutate state the test can read straight back out of.
  useSharedValue: (init: unknown) => {
    const ref = React.useRef<{ value: unknown } | null>(null);
    if (!ref.current) ref.current = { value: init };
    return ref.current;
  },
  useFrameCallback: (cb: (info: { timeSinceFirstFrame: number }) => void, autostart = true) => {
    const entryRef = React.useRef<FrameCallbackEntry | null>(null);
    if (!entryRef.current) {
      entryRef.current = { cb, active: autostart };
      frameCallbackEntries.push(entryRef.current);
    } else {
      entryRef.current.cb = cb; // refresh to the latest render's closure
    }
    const entry = entryRef.current;
    return {
      setActive: (active: boolean) => {
        entry.active = active;
      },
    };
  },
  useAnimatedReaction: (_prepare: () => unknown, react: (curr: unknown, prev: unknown) => void) => {
    const entryRef = React.useRef<ReactionEntry | null>(null);
    if (!entryRef.current) {
      entryRef.current = { react };
      reactionEntries.push(entryRef.current);
    } else {
      entryRef.current.react = react;
    }
  },
  // Synchronous in tests — there is no second thread to hop to.
  runOnJS: (fn: (...args: unknown[]) => void) => fn,
  useReducedMotion: () => reducedMotionValue,
}));

const { Dithered } = await import('./Dithered');
const { skiaHitTester } = await import('./hit-test');

const squareHitTest = skiaHitTester(SQUARE_SHAPE);
const otherHitTest = skiaHitTester(OTHER_SHAPE);

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

function lastFrameCallback(): FrameCallbackEntry {
  const entry = frameCallbackEntries[frameCallbackEntries.length - 1];
  if (!entry) throw new Error('no frame callback registered');
  return entry;
}

/**
 * `Dithered.tsx` registers two `useAnimatedReaction`s — the wrap-detection
 * one (declared first) and the `time`-`SharedValue` write path (declared
 * later) — and each call site's mocked `useRef` persists its own entry
 * positionally across renders, so the wrap-detection reaction is always
 * `reactionEntries[0]`, not the most recently *registered* one.
 */
function wrapReaction(): ReactionEntry {
  const entry = reactionEntries[0];
  if (!entry) throw new Error('no animated reaction registered');
  return entry;
}

/** Drives one ordinary playback tick — the frame callback's steady branch. */
function tick(timeSinceFirstFrame: number): void {
  lastFrameCallback().cb({ timeSinceFirstFrame });
}

/**
 * Simulates the wrap-detection reaction firing directly (rather than also
 * driving a frame-callback tick at the same instant) — isolates "the loop
 * wrapped" from whatever the steady branch's own tick would separately do,
 * keeping these tests scoped to the pending/halt bookkeeping in
 * `Dithered.tsx` (findings 3, 6, 7) rather than frame-index arithmetic.
 */
function simulateWrap(): void {
  wrapReaction().react(0, 5);
}

interface FakePicture {
  canvas: { drawRRect: ReturnType<typeof vi.fn>; drawRect: ReturnType<typeof vi.fn> };
}

function cellsDrawnOf(picture: unknown): number {
  return (picture as FakePicture).canvas.drawRRect.mock.calls.length;
}

const alwaysTrue = () => true;

describe('Dithered (native)', () => {
  beforeEach(() => {
    frameCallbackEntries = [];
    reactionEntries = [];
    reducedMotionValue = false;
    lastPictureShared = null;
    makeFromSVGString.mockClear();
    createPictureImpl.mockClear();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('renders the initial shape (sanity check for the mock harness)', () => {
    render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={1000}
        brightness={alwaysTrue}
      />,
    );
    expect(lastPictureShared).not.toBeNull();
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);
  });

  // Finding 3: a shape change deferred by `transition.onLoopEnd` must not
  // hard-cut to the target before the loop actually wraps.
  it('does not cut to the target before an onLoopEnd-deferred morph starts (finding 3)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400, onLoopEnd: true }}
      />,
    );
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);

    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400, onLoopEnd: true }}
        />,
      );
    });

    // The steady `pictures` array already reflects `OTHER_SHAPE` (0 cells)
    // the instant the prop changes, but the canvas must still show the
    // *outgoing* square — the deferred morph hasn't started yet.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);
  });

  // Finding 3 (continued): once the wrap actually happens, the morph plays
  // *forward* from the outgoing shape to the target — not backward (jumping
  // to the already-installed target and dissolving back to the square).
  it('plays the deferred morph forward, from the outgoing shape to the target, once released (finding 3)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400, onLoopEnd: true }}
      />,
    );
    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400, onLoopEnd: true }}
        />,
      );
    });

    createPictureImpl.mockClear();
    act(() => {
      simulateWrap();
    });

    // Every picture recorded in this render is the morph's (the steady
    // pictures didn't need to change), in step order — the first is
    // progress 0.
    expect(createPictureImpl.mock.results.length).toBeGreaterThan(0);
    const firstStep = createPictureImpl.mock.results[0]!.value;
    const lastStep =
      createPictureImpl.mock.results[createPictureImpl.mock.results.length - 1]!.value;

    expect(cellsDrawnOf(firstStep)).toBe(16); // starts on the outgoing square...
    expect(cellsDrawnOf(lastStep)).toBe(0); // ...and ends on the target.
  });

  // Halting playback while a morph is *actively* dissolving (not merely
  // queued behind `onLoopEnd` — that's the "finding 6" case above) must
  // also cut straight to the target's steady state, not strand the canvas
  // on the half-dissolved frame that happened to be on screen. Regression
  // test: `suppressRepointRef` used to be set (by the effect that starts
  // a morph) but never cleared by the halt effect's "active morph" branch,
  // so the repoint effect's own guard bailed on every run from then on —
  // the canvas froze on the half-morphed picture until some *unrelated*
  // prop change happened to clear the ref via a different code path.
  it('does not strand the canvas on a half-dissolved frame when playback halts mid-morph', () => {
    const { rerender } = render(
      <Dithered
        shape={OTHER_SHAPE}
        hitTest={otherHitTest}
        cols={4}
        frames={48}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400 }}
      />,
    );
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0);

    act(() => {
      rerender(
        <Dithered
          shape={SQUARE_SHAPE}
          hitTest={squareHitTest}
          cols={4}
          frames={48}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
        />,
      );
    });

    act(() => {
      tick(200); // roughly halfway through the 400ms morph
    });
    const midway = cellsDrawnOf(lastPictureShared!.value);
    // Sanity: this is genuinely a half-dissolved frame, not one end or
    // the other — otherwise the assertion below wouldn't distinguish
    // "cut to target" from "coincidentally already showing the target".
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(16);

    act(() => {
      rerender(
        <Dithered
          shape={SQUARE_SHAPE}
          hitTest={squareHitTest}
          cols={4}
          frames={48}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
          paused // playback halts mid-morph.
        />,
      );
    });

    // Cut straight to the target's full 16 cells in the same commit that
    // halts playback — not left frozen at `midway`, and not requiring any
    // further, unrelated prop change to unstick it.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);

    // The fix must not just repaint once and re-freeze: a further,
    // unrelated steady-state rebuild (e.g. from a later prop change while
    // still paused) should also go through cleanly, proving
    // `suppressRepointRef` was actually cleared rather than the repoint
    // having happened despite it.
    act(() => {
      rerender(
        <Dithered
          shape={SQUARE_SHAPE}
          hitTest={squareHitTest}
          cols={4}
          frames={48}
          period={1000}
          brightness={alwaysTrue}
          fg="#123456"
          transition={{ duration: 400 }}
          paused
        />,
      );
    });
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);
  });

  // Finding 6: a halt (paused, backgrounded, reduced motion) while a morph
  // is merely *queued* behind `onLoopEnd` must settle it immediately, not
  // leave it to fire later — possibly long after, and playing backwards.
  it('settles a still-pending onLoopEnd morph immediately when playback halts (finding 6)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400, onLoopEnd: true }}
      />,
    );
    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400, onLoopEnd: true }}
        />,
      );
    });
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16); // still pending, per finding 3's fix.

    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400, onLoopEnd: true }}
          paused // playback halts while the morph is still queued.
        />,
      );
    });

    // Settled immediately to the target, not left frozen on the square.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0);

    // The wrap that *would* have released the (now-cleared) pending morph
    // must not fire it — no new recording, no jump back to the square.
    createPictureImpl.mockClear();
    act(() => {
      simulateWrap();
    });
    expect(createPictureImpl).not.toHaveBeenCalled();
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0);
  });

  // Finding 7: even without `onLoopEnd`, the canvas must not flash the
  // finished target before the morph's first frame exists — it should keep
  // showing the outgoing shape until a tick actually hands off to the morph.
  it('does not flash the finished target when an (immediate) morph starts (finding 7)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400 }}
      />,
    );
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);

    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
        />,
      );
    });

    // No tick has run yet — the canvas must still show the outgoing
    // square, not the already-rebuilt (0-cell) target steady picture.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);
  });

  // Finding 10 (native scheduling coverage): once a morph completes, the
  // recordings are dropped and playback hands off to the steady array —
  // a further change behaves like an ordinary cut again.
  it('drops the morph recordings after playback completes and resumes steady state', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400, onLoopEnd: true }}
      />,
    );
    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400, onLoopEnd: true }}
        />,
      );
    });
    act(() => {
      simulateWrap();
    });

    // Drive the morph to completion (duration 400ms; startAt defaults to
    // whatever the clock was, here still its initial 0).
    act(() => {
      tick(500);
    });
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0);

    // A further, ordinary (non-transition) cut back to the square must
    // work exactly as it would with no morph history at all.
    act(() => {
      rerender(
        <Dithered
          shape={SQUARE_SHAPE}
          hitTest={squareHitTest}
          cols={4}
          frames={4}
          period={1000}
          brightness={alwaysTrue}
        />,
      );
    });
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);
  });

  // Regression: `useDitheredPictures({ ..., matrix })` at pictures.ts must
  // actually receive the `matrix` prop `<Dithered>` was given —
  // `pictures.test.ts` exercises the hook directly and can't see the
  // component silently dropping it before forwarding.
  it('passes the matrix prop through to sampling: bayer8 clears a fixed brightness differently than bayer4', () => {
    const brightness = () => 0.53;

    // cols=8 on a square shape makes an 8x8 grid: bayer4 tiles 2x2,
    // bayer8 matches it exactly, so 0.53 (between quantization levels for
    // both, but different ones) draws a different cell count under each —
    // the same reasoning `pictures.test.ts` and `renderer.test.ts` use.
    render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        brightness={brightness}
        cols={8}
        frames={1}
      />,
    );
    const bayer4Draws = cellsDrawnOf(lastPictureShared!.value);

    render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        brightness={brightness}
        cols={8}
        frames={1}
        matrix="bayer8"
      />,
    );
    const bayer8Draws = cellsDrawnOf(lastPictureShared!.value);

    expect(bayer4Draws).toBeGreaterThan(0);
    expect(bayer8Draws).not.toBe(bayer4Draws);
  });
});
