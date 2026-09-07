import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { advancePhase, frameForPhase, loopsAt, phaseForFrame, wrapPhase } from '../core/clock';
import { createDithered } from '../renderer';
import { SQUARE_SHAPE, makeFakeCanvas, stubAnimationGlobals } from '../test-utils';
import {
  advancePhaseUI,
  frameForPhaseUI,
  loopsAtUI,
  phaseForFrameUI,
  wrapPhaseUI,
} from './playback';

// A deliberately awkward sweep: whole numbers, halves, values that hug a
// frame boundary from either side, and both signs.
const PHASES = [-2.7, -1.5, -1, -0.5, -0.001, 0, 0.001, 0.25, 0.5, 0.75, 0.999, 1, 1.5, 3.25];
const DTS = [0, 1, 16.6667, 33.3333, 100, 1000, 5000];
const PERIODS = [500, 1000, 2000, 3333];
const SPEEDS = [-3, -1, -0.5, 0, 0.5, 1, 2.5];
const FRAME_COUNTS = [1, 8, 24, 48, 60];

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
  });
});
