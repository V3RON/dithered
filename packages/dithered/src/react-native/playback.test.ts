import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  advancePhase,
  frameForPhase,
  loopsAt,
  phaseForFrame,
  wrapFrame,
  wrapPhase,
} from '../core/clock';
import { createDithered } from '../renderer';
import { SQUARE_SHAPE, makeFakeCanvas, stubAnimationGlobals } from '../test-utils';
import {
  advancePhaseUI,
  frameForPhaseUI,
  frameForRepoint,
  isExternallyDriven,
  loopsAtUI,
  phaseForFrameUI,
  resolveAppliedFrame,
  wrapPhaseUI,
} from './playback';

// A deliberately awkward sweep: whole numbers, halves, values that hug a
// frame boundary from either side, and both signs.
const PHASES = [-2.7, -1.5, -1, -0.5, -0.001, 0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, 1.5, 3.25];
const DTS = [0, 1, 16.6667, 33.3333, 100, 1000, 5000];
const PERIODS = [500, 1000, 2000, 3333];
const SPEEDS = [-3, -1, -0.5, 0, 0.5, 1, 2.5];
const FRAME_COUNTS = [1, 8, 24, 48, 60];

describe('UI twins match core totality', () => {
  it('advancePhaseUI leaves the phase untouched when the step would not be finite', () => {
    const cases: Array<[number, number, number, number]> = [
      [0.25, 16, 2000, NaN],
      [0.25, 16, 2000, Infinity],
      [0.25, 16, 0, 1],
      [0.25, NaN, 2000, 1],
    ];
    for (const [phase, dt, period, speed] of cases) {
      expect(advancePhaseUI(phase, dt, period, speed)).toBe(advancePhase(phase, dt, period, speed));
      expect(advancePhaseUI(phase, dt, period, speed)).toBe(0.25);
    }
  });

  it('wrapPhaseUI is exact on [0, 1) and total, exactly like wrapPhase', () => {
    for (const p of [0, 0.1, 0.3, 0.35, 0.9, -1e-18, NaN, Infinity, -0.25, 2.5]) {
      expect(Object.is(wrapPhaseUI(p), wrapPhase(p))).toBe(true);
    }
    expect(wrapPhaseUI(0.35)).toBe(0.35);
  });
});

describe('native/playback parity with core/clock', () => {
  it('wrapPhaseUI matches wrapPhase across a sweep of phases', () => {
    for (const phase of PHASES) {
      expect(wrapPhaseUI(phase)).toBe(wrapPhase(phase));
    }
  });

  it('advancePhaseUI matches advancePhase across dt, period and speed', () => {
    for (const phase of PHASES) {
      for (const dt of DTS) {
        for (const period of PERIODS) {
          for (const speed of SPEEDS) {
            expect(advancePhaseUI(phase, dt, period, speed)).toBe(
              advancePhase(phase, dt, period, speed),
            );
          }
        }
      }
    }
  });

  it('frameForPhaseUI matches frameForPhase across phases and frame counts', () => {
    for (const phase of PHASES) {
      for (const frames of FRAME_COUNTS) {
        expect(frameForPhaseUI(phase, frames)).toBe(frameForPhase(phase, frames));
      }
    }
  });

  it('frameForPhaseUI clamps identically at the top of the range', () => {
    // Values close enough to 1 that p * frames can round up to frames in
    // floating point — the exact case the clamp in both copies guards.
    const nearOne = [1 - Number.EPSILON, 0.9999999999999999, 0.999999999999999];
    for (const phase of nearOne) {
      for (const frames of FRAME_COUNTS) {
        expect(frameForPhaseUI(phase, frames)).toBe(frameForPhase(phase, frames));
        expect(frameForPhaseUI(phase, frames)).toBeLessThan(frames);
      }
    }
  });

  // ADR 0006 test 43 / finding 1, the `*UI` twin. Same totality
  // guarantee as `core/clock.ts`'s `frameForPhase`: a non-finite phase,
  // or any `frames <= 0`, returns frame `0` rather than `undefined`
  // reaching Skia's `drawPicture`.
  it('frameForPhaseUI is total: NaN/Infinity/-Infinity and frames <= 0 all return frame 0', () => {
    for (const phase of [NaN, Infinity, -Infinity]) {
      for (const frames of [1, 10, 48]) {
        expect(frameForPhaseUI(phase, frames)).toBe(0);
        expect(frameForPhaseUI(phase, frames)).toBe(frameForPhase(phase, frames));
      }
    }
    for (const frames of [0, -1, -48]) {
      for (const phase of [0, 0.5, -0.3, NaN]) {
        expect(frameForPhaseUI(phase, frames)).toBe(0);
      }
    }
  });

  it('loopsAtUI matches loopsAt across a sweep of phases', () => {
    for (const phase of PHASES) {
      expect(loopsAtUI(phase)).toBe(loopsAt(phase));
    }
  });

  it('phaseForFrameUI matches phaseForFrame across frame indices and frame counts', () => {
    for (const frames of FRAME_COUNTS) {
      for (let frame = 0; frame < frames; frame++) {
        expect(phaseForFrameUI(frame, frames)).toBe(phaseForFrame(frame, frames));
      }
    }
  });

  it('frameForPhaseUI(phaseForFrameUI(k, n), n) round-trips to k exactly, matching the web-side guarantee', () => {
    for (const frames of FRAME_COUNTS) {
      for (let frame = 0; frame < frames; frame++) {
        expect(frameForPhaseUI(phaseForFrameUI(frame, frames), frames)).toBe(frame);
      }
    }
  });

  describe('resolveAppliedFrame (extracted from the applyPhase worklet, finding 1)', () => {
    it('returns null (paint nothing) for a non-finite phase, regardless of the currently displayed frame', () => {
      for (const phase of [NaN, Infinity, -Infinity]) {
        expect(resolveAppliedFrame(phase, 48, 0)).toBeNull();
        expect(resolveAppliedFrame(phase, 48, 5)).toBeNull();
      }
    });

    it('returns null when the phase maps to the frame already displayed (no redundant repaint/onFrame)', () => {
      expect(resolveAppliedFrame(phaseForFrameUI(5, 10), 10, 5)).toBeNull();
    });

    it('returns the new frame index when the phase maps somewhere else', () => {
      expect(resolveAppliedFrame(phaseForFrameUI(5, 10), 10, 2)).toBe(5);
    });
  });

  describe('frameForRepoint (extracted from the recordings re-point effect, finding 2)', () => {
    it('reads externalPhase when it is set, ignoring internalPhase', () => {
      expect(frameForRepoint(0.75, 0.1, 10)).toBe(frameForPhaseUI(0.75, 10));
    });

    it('falls back to internalPhase when externalPhase is null', () => {
      expect(frameForRepoint(null, 0.75, 10)).toBe(frameForPhaseUI(0.75, 10));
    });

    // The exact ADR 0006 §6 regression scenario: `initialFrame: 30,
    // frames: 48`, paused, then re-rendered at `frames: 10`. The old
    // `wrapFrame(currentFrame, frameCount)` mapping this replaces would
    // answer `wrapFrame(30, 10) === 0`; the phase-based mapping agrees
    // with the web driver's `frameForPhase` at frame `6`.
    it('re-points from the preserved phase, not the old frame index, at the exact ADR regression scenario', () => {
      const frames = 48;
      const seedFrame = wrapFrame(30, frames);
      const internalPhase = phaseForFrameUI(seedFrame, frames);

      const newFrameCount = 10;
      const repointed = frameForRepoint(null, internalPhase, newFrameCount);

      expect(repointed).toBe(6);
      // Pinned against the buggy mapping this replaces, so the fix can't
      // silently regress back to it.
      expect(repointed).not.toBe(wrapFrame(seedFrame, newFrameCount));
    });
  });

  describe('isExternallyDriven (extracted from the `driven` computation, finding 6)', () => {
    it('is false when time and progress are both absent', () => {
      expect(isExternallyDriven(undefined, undefined)).toBe(false);
    });

    // The actual regression: `time={sharedValue ?? null}` before the
    // shared value exists must behave like "not externally driven", not
    // freeze the frame callback forever.
    it('treats a null time the same as an absent one, even with progress absent too', () => {
      expect(isExternallyDriven(null, undefined)).toBe(false);
    });

    it('is true for a numeric time, a shared-value-shaped time, or a set progress', () => {
      expect(isExternallyDriven(0.5, undefined)).toBe(true);
      expect(isExternallyDriven(0, undefined)).toBe(true); // falsy but present
      expect(isExternallyDriven({ value: 0.5 }, undefined)).toBe(true);
      expect(isExternallyDriven(null, 0.5)).toBe(true); // progress alone still drives
      expect(isExternallyDriven(undefined, 0)).toBe(true); // falsy but present
    });
  });

  // ADR 0006 test 42. The sweep above (and the one it replaces) only
  // proved the `*UI` helpers agree with their `core/clock.ts` twins —
  // pairwise identical functions compared to themselves, restated. It
  // never touched the actual web driver, which is where "two platforms
  // agree" as a claim about the library (not about four pure functions)
  // actually lives: if `renderer.ts`'s `tick` ever clamped `dt`,
  // reordered the `loopsAt` comparison, or diverged from
  // `advancePhase`/`frameForPhase` in any other way, the sweep above
  // would keep passing while this would not.
  describe('the real web driver (createDithered) matches the UI-thread accumulator', () => {
    let env: ReturnType<typeof stubAnimationGlobals>;

    beforeEach(() => {
      env = stubAnimationGlobals();
    });

    afterEach(() => {
      env.restore();
    });

    it('produces the same frame sequence over an identical dt timeline', () => {
      const dtTimeline: Array<number | null> = [null, 16.6667, 16.6667, 16.6667, 500, 0, 33.3333];
      const period = 2000;
      const speed = -2;
      const frames = 36;

      // Convert the dt timeline into cumulative `now` timestamps the way
      // a real requestAnimationFrame stream would deliver them, and
      // drive the actual `createDithered`/`tick` through it — not a
      // second evaluation of the pure helpers `tick` is built from.
      let now = 10_000; // an arbitrary non-zero start
      const nowTimeline = dtTimeline.map((dt) => {
        now += dt ?? 0;
        return now;
      });

      const webFrames: number[] = [];
      const { canvas } = makeFakeCanvas();
      createDithered(canvas, {
        shape: SQUARE_SHAPE,
        brightness: () => true,
        cache: false,
        frames,
        period,
        speed,
        onFrame: (f) => webFrames.push(f),
      });
      webFrames.length = 0; // drop the mount-time initial paint

      for (const t of nowTimeline) {
        const cb = env.rafCallbacks[env.rafCallbacks.length - 1];
        if (!cb) throw new Error('no animation frame is currently scheduled');
        cb(t);
      }

      // Seeded identically to how `createDithered` seeds its own `phase`
      // for `initialFrame: 0` (the default) — via `phaseForFrame`, not a
      // bare `0` (see finding 3) — so this is a fair comparison of the
      // *step deltas*, not an artifact of two different starting points
      // that happen to round to the same frame.
      let uiPhase = phaseForFrameUI(0, frames);
      const uiFrames: number[] = [];
      let previousUiFrame = frameForPhaseUI(uiPhase, frames);
      for (const dt of dtTimeline) {
        uiPhase = advancePhaseUI(uiPhase, dt ?? 0, period, speed);
        const f = frameForPhaseUI(uiPhase, frames);
        if (f !== previousUiFrame) uiFrames.push(f);
        previousUiFrame = f;
      }

      expect(webFrames).toEqual(uiFrames);
    });

    // ADR 0006 test 48 / finding 8. `initialFrame` is wrapped into
    // `[0, frames)` *before* being converted to a phase, on both
    // platforms — otherwise `loopsAt` starts somewhere other than `0`
    // for an out-of-range `initialFrame` on whichever platform seeds it
    // unwrapped, and the two disagree about the first `onLoop` count for
    // identical props. This drives the real web `createDithered` and
    // compares it against the native accumulator built from the same
    // pure helpers `Dithered.tsx` seeds with (`wrapFrame` +
    // `phaseForFrameUI`), since there is no React Native renderer here
    // to mount the component itself.
    it('initialFrame out of range paints the same frame and reports the same first onLoop count on both platforms', () => {
      const frames = 48;
      const period = 1000;

      for (const initialFrame of [-1, frames, frames + 1]) {
        // Web: the real renderer. Tracked as a running "last painted
        // frame" rather than an array of pushes: advancing by exactly
        // one full period returns to the *same* frame index (only the
        // loop count changes), so `onFrame` correctly does not fire
        // again — an array would go empty and lose the value entirely.
        let lastWebFrame = -1;
        const webLoops: number[] = [];
        const { canvas } = makeFakeCanvas();
        createDithered(canvas, {
          shape: SQUARE_SHAPE,
          brightness: () => true,
          cache: false,
          frames,
          period,
          initialFrame,
          onFrame: (f) => {
            lastWebFrame = f;
          },
          onLoop: (loops) => webLoops.push(loops),
        });
        const webInitialFrame = lastWebFrame; // from the mount-time paint

        const cb = env.rafCallbacks[env.rafCallbacks.length - 1]!;
        cb(0); // establishes lastNow, no movement
        cb(period); // one full period forward: crosses exactly one loop boundary

        // Native: the same seeding `Dithered.tsx` performs at mount
        // (`wrapFrame` then `phaseForFrameUI`), then one accumulator step
        // through the same forward period.
        const nativeSeedFrame = wrapFrame(initialFrame, frames);
        let nativePhase = phaseForFrameUI(nativeSeedFrame, frames);
        const loopsBefore = loopsAtUI(nativePhase);
        nativePhase = advancePhaseUI(nativePhase, period, period, 1);
        const loopsAfter = loopsAtUI(nativePhase);
        const nativeFirstLoop = loopsAfter !== loopsBefore ? loopsAfter : undefined;
        const nativeFinalFrame = frameForPhaseUI(nativePhase, frames);

        expect(webInitialFrame).toBe(nativeSeedFrame);
        expect(webLoops[0]).toBe(nativeFirstLoop);
        expect(lastWebFrame).toBe(nativeFinalFrame);
      }
    });
  });
});
