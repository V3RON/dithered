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
  // on the shared-value objects (and, for `Canvas`, the `style` prop) these
  // components receive.
  Canvas: ({ children, style }: { children?: React.ReactNode; style?: unknown }) => {
    lastCanvasStyle = style;
    return React.createElement(React.Fragment, null, children);
  },
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
let lastCanvasStyle: unknown = null;

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

/** The `{ width, height }` the `<Canvas>` was last rendered with. */
function canvasSize(): { width: number; height: number } {
  const style = lastCanvasStyle as [{ width: number; height: number }, unknown];
  return style[0];
}

const alwaysTrue = () => true;

describe('Dithered (native)', () => {
  beforeEach(() => {
    frameCallbackEntries = [];
    reactionEntries = [];
    reducedMotionValue = false;
    lastPictureShared = null;
    lastCanvasStyle = null;
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

    // Finding 1: this assertion alone passed even with the underlying fix
    // entirely removed, because nothing had driven the frame callback —
    // it only observed React-commit-time state, never what the UI-thread
    // loop actually paints. A tick is the whole point: the pre-fix steady
    // branch read `pictures` directly (already the target's, 0 cells)
    // with no morph state to gate it while one is merely *queued*, so it
    // repainted the target on this very first tick, a full `period`
    // before the deferred morph was ever meant to start.
    act(() => {
      tick(250);
    });
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
        frames={48}
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
          frames={48}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
        />,
      );
    });

    // No tick has run yet — the canvas must still show the outgoing
    // square, not the already-rebuilt (0-cell) target steady picture.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);

    // Driving a tick partway through the morph is the part the original
    // assertion above never covered (finding 1/7): a genuine dissolve is
    // in progress by now — some but not all cells drawn — not stuck on
    // the outgoing shape forever, and not an instant jump to the target
    // either.
    act(() => {
      tick(200); // roughly halfway through the 400ms morph.
    });
    const midway = cellsDrawnOf(lastPictureShared!.value);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(16);
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

  // Finding 2: the frame callback's own clock can restart mid-morph
  // (Reanimated resets `info.timeSinceFirstFrame` to 0 whenever
  // `useFrameCallback` is deactivated and reactivated — which happens
  // whenever `holding` toggles, and can toggle in the very same commit
  // that also starts a new morph). Without clamping/clock-restart
  // handling, `elapsed` goes deeply negative, `morphPictures[step]` reads
  // `undefined`, and the canvas goes blank for the rest of the window.
  it('keeps painting a valid frame after the frame-callback clock restarts mid-morph (finding 2)', () => {
    const { rerender } = render(
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

    // Run for a while first — mirrors a long-lived instance, not one
    // freshly mounted at t=0 (where `elapsed` could never go negative
    // regardless of this bug).
    act(() => {
      tick(9000);
    });

    // Starts a morph this commit, capturing `startedAt` from the clock as
    // it stood on the last tick (9000).
    act(() => {
      rerender(
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
    });

    // Simulates the frame-callback clock restarting: a tick whose raw
    // time is *lower* than the previous one, with no assumption about by
    // how much (real Reanimated restarts at ~0, but the fix must not
    // depend on the exact value).
    act(() => {
      tick(16);
    });

    const picture = lastPictureShared!.value;
    expect(picture).not.toBeUndefined();
    // A real recording — whichever step this virtual-clock-corrected tick
    // lands on — draws a valid, in-range cell count. The pre-fix bug's
    // `undefined` picture would throw here instead (`cellsDrawnOf` reads
    // `.canvas` off it).
    const cells = cellsDrawnOf(picture);
    expect(cells).toBeGreaterThanOrEqual(0);
    expect(cells).toBeLessThanOrEqual(16);

    // The clock-restart handling must not get "stuck" either: continued
    // ticks (now on the new, post-restart epoch) still make forward
    // progress and eventually complete the morph normally.
    act(() => {
      tick(500); // ~484ms after the restart on the new epoch — well past duration.
    });
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0); // settled on the target.
  });

  // Finding 4: native computes `holding` from *this* render's props, so a
  // `paused`/option change landing in the same commit is decided by the
  // *final* pause state, not a stale one — this is the behaviour
  // `dithered/react`'s effect ordering was changed to match (see
  // `react.test.tsx`'s mirror of this test).
  it('unpausing and changing shape together starts a real morph, not an immediate cut (finding 4)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={48}
        period={1000}
        brightness={alwaysTrue}
        transition={{ duration: 400 }}
        paused
      />,
    );

    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={48}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
          // `paused` dropped -> false, in the same commit as the shape change.
        />,
      );
    });

    // A real morph is now driving playback: a tick partway through shows
    // a genuine partial dissolve, not an instant cut to the target.
    act(() => {
      tick(200);
    });
    const midway = cellsDrawnOf(lastPictureShared!.value);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(16);
  });

  it('pausing and changing shape together still cuts immediately, on native as on web (finding 4)', () => {
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
          paused
        />,
      );
    });

    // No loop left to morph on this commit: cuts straight to the target,
    // no recordings needed, no tick required to observe it.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0);
  });

  // Finding 6: the declarative `transition` prop is the whole truth for a
  // render — dropping `onLoopEnd` puts it back to its default (`false`),
  // it does not stay stuck at an earlier render's `true`. This must agree
  // with `dithered/react`'s own resolution of the same finding.
  it('dropping onLoopEnd from the transition prop resets it to false, not a sticky true (finding 6)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={48}
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
          frames={48}
          period={1000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }} // onLoopEnd dropped, not repeated as false.
        />,
      );
    });

    // No wrap has fired. If `onLoopEnd` were still (sticky) true, this
    // would still show the outgoing square untouched. With the fix, the
    // morph starts immediately, so a tick partway through shows a partial
    // dissolve.
    act(() => {
      tick(200);
    });
    const cells = cellsDrawnOf(lastPictureShared!.value);
    expect(cells).toBeGreaterThan(0);
    expect(cells).toBeLessThan(16);
  });

  // Finding 8: pictures are recorded at `p = i / (steps - 1)`, so
  // selecting the nearest step needs the same denominator — `round(t *
  // (steps - 1))` — not `floor(t * steps)`, which runs ahead of the
  // recording and freezes on the finished target for the last fraction of
  // the morph.
  it('tracks progress continuously rather than running ahead of the recorded steps (finding 8)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={48}
        period={2000}
        brightness={alwaysTrue}
        transition={{ duration: 400 }}
      />,
    );

    createPictureImpl.mockClear();
    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={48}
          period={2000}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
        />,
      );
    });

    // steps = clamp(round(400 / (2000/48)), 2, 240) = round(9.6) = 10,
    // recorded once (synchronously, in order) as this render's morph
    // starts — nothing else records a picture in the same commit, since
    // the steady `pictures` array stays pinned to the (unchanged)
    // outgoing config.
    expect(createPictureImpl.mock.results.length).toBe(10);
    const stepBeforeFinish = createPictureImpl.mock.results[8]!.value; // p = 8/9 ≈ 0.889
    const finishedTarget = createPictureImpl.mock.results[9]!.value; // p = 1

    // At t = 0.9 (360ms into the 400ms morph), the *old* `floor(t * steps)`
    // selection picks step `floor(0.9 * 10) = 9` — the fully-finished
    // target — a full 10% of the duration before the morph is actually
    // meant to finish. The fixed `round(t * (steps - 1))` selection picks
    // step `round(0.9 * 9) = round(8.1) = 8`: still (barely) mid-dissolve,
    // matching the denominator the recording itself used.
    act(() => {
      tick(360);
    });
    expect(lastPictureShared!.value).toBe(stepBeforeFinish);
    expect(lastPictureShared!.value).not.toBe(finishedTarget);
  });

  // Finding 3 (native mirror): a queued `onLoopEnd` morph must be settled
  // immediately when reduced motion turns on mid-wait, exactly as it is
  // for `paused` — `holding` folds both in identically, but only the
  // `paused` case had a regression test before this.
  it('settles a still-pending onLoopEnd morph immediately when reduced motion turns on (finding 3)', () => {
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
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16); // still queued.

    reducedMotionValue = true;
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

    // Settled immediately to the target — not left frozen on the square
    // waiting for a wrap that reduced motion means will never usefully
    // come.
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(0);
  });

  // Closing-review finding 1: `useDitheredPictures`' `width`/`height` stay
  // pinned to the *outgoing* surface for the whole episode (by design — see
  // `steadySnapshot`), but the morph itself runs on the *target's* grid and
  // surface (ADR 0004 §2). The `<Canvas>` has to size itself from
  // `useDitheredTransition`'s own `width`/`height` while the morph is
  // actively playing, not from the pinned pair — otherwise the incoming
  // shape is clipped/cropped to the outgoing surface for the entire morph,
  // only snapping to the right size on the "done" beat.
  it('adopts the target surface size at morph start, not only on completion (closing review finding 1)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        cols={4}
        frames={48}
        period={1000}
        size={48}
        brightness={alwaysTrue}
        transition={{ duration: 400 }}
      />,
    );
    // Before: the outgoing surface.
    expect(canvasSize()).toEqual({ width: 48, height: 48 });

    act(() => {
      rerender(
        <Dithered
          shape={SQUARE_SHAPE}
          cols={4}
          frames={48}
          period={1000}
          size={96}
          brightness={alwaysTrue}
          transition={{ duration: 400 }}
        />,
      );
    });
    // At morph start — before any tick has run — the canvas has already
    // adopted the target's (larger) surface, per ADR 0004 §2/§5.
    expect(canvasSize()).toEqual({ width: 96, height: 96 });

    // During: driving a tick partway through the morph must not regress
    // the size back to the outgoing surface.
    act(() => {
      tick(200); // roughly halfway through the 400ms morph.
    });
    expect(canvasSize()).toEqual({ width: 96, height: 96 });

    // After completion: still the target surface, once steady playback
    // has taken back over.
    act(() => {
      tick(500);
    });
    expect(canvasSize()).toEqual({ width: 96, height: 96 });
  });

  // Closing-review finding: a second, superseding change that arrives
  // while the first morph is *actively playing* (not merely queued behind
  // `onLoopEnd`) must re-base onto the running morph's own target — ADR
  // 0004 §7's "finishes the running one instantly ... and starts the new
  // morph from there" — rather than keeping the original pre-episode
  // freeze. Otherwise a change back toward the shape that was on screen
  // *before the first morph ever started* is recorded as a same-shape
  // morph (`from` and `to` identical) whose every step already draws the
  // full target, hard-snapping instead of dissolving back in.
  it('rebases an active morph onto its own target when superseded by a new change', () => {
    const { rerender } = render(
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
    expect(cellsDrawnOf(lastPictureShared!.value)).toBe(16);

    // Starts the first morph: square (16 cells) -> other (0 cells).
    act(() => {
      rerender(
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
    });

    act(() => {
      tick(200); // roughly halfway through the first morph: genuinely mid-dissolve.
    });
    const midway = cellsDrawnOf(lastPictureShared!.value);
    expect(midway).toBeGreaterThan(0);
    expect(midway).toBeLessThan(16);

    // A second change, before the first morph resolves, asks for the
    // square again. The first morph was *actively* playing (not queued),
    // so this must start a fresh morph from *its* target (other, 0 cells)
    // back to the square — not snap straight to the square.
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
      tick(400); // roughly halfway through the *second* morph (started at 200).
    });
    const midwayBack = cellsDrawnOf(lastPictureShared!.value);
    // The pre-fix bug records a square -> square morph (re-based on the
    // stale original freeze from before the *first* morph), whose every
    // step already draws the full 16 cells — a hard snap, not a dissolve.
    expect(midwayBack).toBeGreaterThan(0);
    expect(midwayBack).toBeLessThan(16);
  });

  // Closing-review finding 4: the worklet must index the pinned steady
  // `pictures` array with the *pinned* `period`, not the live prop — the
  // two have to describe the same config, or the outgoing recordings (kept
  // playing for as long as an episode is queued/active, per ADR 0004 §5)
  // play back at whatever period the still-unapplied *target* asked for.
  it('keeps the outgoing steady-state period pinned during a queued morph episode (finding 4)', () => {
    const { rerender } = render(
      <Dithered
        shape={SQUARE_SHAPE}
        hitTest={squareHitTest}
        cols={4}
        frames={4}
        period={2000}
        brightness={alwaysTrue}
        transition={{ duration: 400, onLoopEnd: true }}
      />,
    );
    // The 4 steady recordings for the outgoing (period 2000) loop, frame 0..3.
    const framePictures = createPictureImpl.mock.results.map((r) => r.value);
    expect(framePictures.length).toBe(4);

    createPictureImpl.mockClear();
    act(() => {
      rerender(
        <Dithered
          shape={OTHER_SHAPE}
          hitTest={otherHitTest}
          cols={4}
          frames={4}
          period={500} // the target asks for a 4x faster loop.
          brightness={alwaysTrue}
          transition={{ duration: 400, onLoopEnd: true }}
        />,
      );
    });
    // Queued behind onLoopEnd: nothing about the steady config actually
    // changed (still pinned to the outgoing snapshot), so no new steady
    // recordings were needed.
    expect(createPictureImpl).not.toHaveBeenCalled();

    act(() => {
      tick(300); // 300ms into the *outgoing* (period 2000) loop.
    });
    // Under the live (target) period of 500, `floor(300/500*4) = 2` — the
    // outgoing recordings would appear to run 4x too fast, before the
    // morph that's supposed to carry that change has even started. Pinned
    // to the outgoing period of 2000, `floor(300/2000*4) = 0`.
    expect(lastPictureShared!.value).toBe(framePictures[0]);
    expect(lastPictureShared!.value).not.toBe(framePictures[2]);
  });

  // Defect 5 (native): the lower `Math.max(0, ...)` clamp on morph
  // progress. The offset-correction in the frame callback (finding 2)
  // already keeps a *legitimate* Reanimated clock restart from producing a
  // meaningfully negative `elapsed`, so exercising this guard directly
  // means feeding the worklet a raw time that violates that correction's
  // only assumption (that `timeSinceFirstFrame` is never negative) —
  // this is the guard's actual job: making sure a negative `t` still
  // selects a valid, in-range recorded step (`morphPictures[0]`) instead
  // of indexing the array with a negative number and reading `undefined`.
  it('clamps morph progress at 0 instead of indexing the recordings with a negative step (defect 5)', () => {
    const { rerender } = render(
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

    act(() => {
      tick(9000); // establishes a nonzero baseline on the virtual clock.
    });

    act(() => {
      rerender(
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
    });
    // The morph's `startedAt` is captured as 9000 (the virtual clock as of
    // the last tick above).

    act(() => {
      // A raw time far enough below the last observed raw time that, even
      // after the clock-restart correction folds the *previous* raw value
      // into the running offset, the resulting `elapsed` is still deeply
      // negative — a strictly larger regression than any real Reanimated
      // restart (which never goes below 0) could ever produce.
      tick(-1_000_000);
    });

    const picture = lastPictureShared!.value;
    expect(picture).not.toBeUndefined();
    // Clamped to progress 0: the first recorded step, the full outgoing
    // square. Without the clamp, a negative `t` indexes the recordings
    // array with a large negative number, reading `undefined` — a picture
    // whose `.canvas` access throws instead of a valid cell count.
    expect(cellsDrawnOf(picture)).toBe(16);
  });
});
