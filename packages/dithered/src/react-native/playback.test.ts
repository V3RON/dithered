import { describe, expect, it } from 'vitest';
import { advancePhase, frameForPhase, loopsAt, wrapPhase } from '../core/clock';
import { advancePhaseUI, frameForPhaseUI, loopsAtUI, wrapPhaseUI } from './playback';

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

  // The parity criterion that actually matters: driven by the same dt
  // timeline (including a null-as-0 first frame, matching
  // `info.timeSincePreviousFrame ?? 0` on the very first frame callback
  // after every (re)activation), the UI-thread accumulator and the web
  // driver's accumulator land on the same frame at every step.
  it('produces the same frame sequence as the web driver given the same dt timeline', () => {
    const dtTimeline: Array<number | null> = [null, 16.6667, 16.6667, 16.6667, 500, 0, 33.3333];
    const period = 2000;
    const speed = -2;
    const frames = 36;

    let uiPhase = 0;
    const uiFrames = dtTimeline.map((dt) => {
      uiPhase = advancePhaseUI(uiPhase, dt ?? 0, period, speed);
      return frameForPhaseUI(uiPhase, frames);
    });

    let webPhase = 0;
    const webFrames = dtTimeline.map((dt) => {
      webPhase = advancePhase(webPhase, dt ?? 0, period, speed);
      return frameForPhase(webPhase, frames);
    });

    expect(uiFrames).toEqual(webFrames);
  });
});
