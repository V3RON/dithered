import { describe, expect, it } from 'vitest';
import { advancePhase, frameForPhase, loopsAt, phaseForFrame, wrapFrame, wrapPhase } from './clock';

describe('wrapPhase', () => {
  it('maps whole and half loop-unit values into [0, 1)', () => {
    expect(wrapPhase(0)).toBe(0);
    expect(wrapPhase(0.5)).toBe(0.5);
    expect(wrapPhase(1)).toBe(0);
    expect(wrapPhase(1.5)).toBe(0.5);
    expect(wrapPhase(2)).toBe(0);
  });

  it('wraps negative phases', () => {
    expect(wrapPhase(-0.25)).toBeCloseTo(0.75);
    expect(wrapPhase(-1)).toBe(0);
    expect(wrapPhase(-2.5)).toBeCloseTo(0.5);
  });
});

describe('advancePhase', () => {
  it('is linear in dt/period, scaled by speed', () => {
    expect(advancePhase(0, 1000, 2000, 1)).toBe(0.5);
    expect(advancePhase(0.25, 1000, 2000, 1)).toBe(0.75);
  });

  it('negative speed decrements the phase', () => {
    expect(advancePhase(0.5, 1000, 2000, -1)).toBe(0);
  });

  it('speed 0 is a no-op regardless of dt', () => {
    expect(advancePhase(0.37, 5000, 2000, 0)).toBe(0.37);
  });

  it('accumulating many small steps matches one big step, within float epsilon', () => {
    const period = 2000;
    const speed = 1.3;
    let accumulated = 0;
    for (let i = 0; i < 1000; i++) {
      accumulated = advancePhase(accumulated, 16.6667, period, speed);
    }
    const closedForm = advancePhase(0, 1000 * 16.6667, period, speed);
    expect(accumulated).toBeCloseTo(closedForm, 6);
  });
});

describe('frameForPhase', () => {
  it('never returns frames or a negative index across a sweep of phases', () => {
    const frames = 48;
    for (let i = 0; i <= 1000; i++) {
      const phase = (i / 1000) * 3 - 1; // sweeps [-1, 2]
      const f = frameForPhase(phase, frames);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(frames);
    }
    // Values immediately below 1, where p * frames can round up in fp.
    for (const phase of [1 - Number.EPSILON, 0.9999999999999999, 0.999999999999999]) {
      const f = frameForPhase(phase, frames);
      expect(f).toBeGreaterThanOrEqual(0);
      expect(f).toBeLessThan(frames);
    }
  });

  it('lands backwards wraparound on the last frame, not -1', () => {
    expect(frameForPhase(-0.001, 48)).toBe(47);
  });

  it('quantizes a phase within a loop the same way frame indices are usually thought of', () => {
    expect(frameForPhase(0, 10)).toBe(0);
    expect(frameForPhase(0.5, 10)).toBe(5);
    expect(frameForPhase(0.99, 10)).toBe(9);
  });

  // ADR 0006 test 43 / finding 1. `Math.min(frames - 1, NaN)` is `NaN`,
  // so the top-edge clamp guards the float edge but not a non-finite
  // input at all — without an explicit guard this reaches straight
  // through to `pictures[NaN]` (`undefined`, on native) or a `drawImage`
  // with non-finite args (a blank canvas, on web). `time={scrollY /
  // contentHeight}` is `NaN` on the first render, before layout — the
  // PRD's flagship use case.
  it('is total: NaN, Infinity and -Infinity all return frame 0, never a non-integer or out-of-range index', () => {
    for (const phase of [NaN, Infinity, -Infinity]) {
      for (const frames of [1, 10, 48]) {
        const f = frameForPhase(phase, frames);
        expect(f).toBe(0);
        expect(Number.isInteger(f)).toBe(true);
      }
    }
  });

  it('is total: frames <= 0 always returns frame 0, for any phase', () => {
    for (const frames of [0, -1, -48]) {
      for (const phase of [0, 0.5, -0.3, 1.7, NaN, Infinity]) {
        expect(frameForPhase(phase, frames)).toBe(0);
      }
    }
  });
});

describe('advancePhase totality', () => {
  // Nothing but `setTime` ever *resets* `phase`, so a single non-finite
  // step would poison playback permanently: the frame freezes (a
  // non-finite phase floors to 0) while `loopsAt(NaN) !== loopsAt(NaN)`
  // fires `onLoop(NaN)` every tick forever, and not even
  // `update({ speed: 1 })` recovers it. `setTime` guards its own input;
  // `speed`, `period` and `dt` are guarded here, at the one place they
  // all meet.
  it('leaves the phase untouched when the step would not be finite', () => {
    expect(advancePhase(0.25, 16, 2000, NaN)).toBe(0.25);
    expect(advancePhase(0.25, 16, 2000, Infinity)).toBe(0.25);
    expect(advancePhase(0.25, 16, 0, 1)).toBe(0.25); // period 0 -> Infinity
    expect(advancePhase(0.25, NaN, 2000, 1)).toBe(0.25);
    expect(advancePhase(0.25, Infinity, 2000, 1)).toBe(0.25);
  });

  it('still advances normally for finite inputs', () => {
    expect(advancePhase(0, 1000, 2000, 1)).toBe(0.5);
    expect(advancePhase(0.25, 16, 2000, 0)).toBe(0.25); // speed 0 is a real no-op
  });
});

describe('wrapFrame totality', () => {
  it('returns 0 for a non-finite index or a non-positive frame count', () => {
    // `Math.round(Infinity) % 48` is `NaN`, which would seed the
    // accumulator with a phase nothing can recover.
    expect(wrapFrame(Infinity, 48)).toBe(0);
    expect(wrapFrame(NaN, 48)).toBe(0);
    expect(wrapFrame(5, 0)).toBe(0);
  });
});

describe('phaseForFrame', () => {
  // The property `phaseForFrame` exists to guarantee (ADR 0006 §1): a
  // frame index survives the round trip through a phase exactly, for
  // *every* valid index at *every* frame count, not just the ones where
  // a bare `frame / frames` happens to be exact in binary. Exhaustive,
  // not sampled — findings 2/3/7 were each a case this sweep would have
  // caught: `k / n` is inexact for 16 of the 48 valid indices at the
  // library's own default frame count.
  it('round-trips through frameForPhase exactly, for every frame at every frame count from 1 to 512', () => {
    for (let n = 1; n <= 512; n++) {
      for (let k = 0; k < n; k++) {
        expect(frameForPhase(phaseForFrame(k, n), n)).toBe(k);
      }
    }
  });

  it('round-trips a phase exactly, so a caller can read back what they set', () => {
    // `((p % 1) + 1) % 1` perturbs values already inside [0, 1) — adding
    // 1 to a fraction costs a mantissa bit the second modulo cannot give
    // back — so `setTime(0.35)` used to report `onFrame(_, 0.3500000000
    // 0000009)`. Subtracting the floor is exact there.
    for (const p of [0, 0.1, 0.2, 0.3, 0.35, 0.5, 0.7, 0.9, 0.999999]) {
      expect(wrapPhase(p)).toBe(p);
    }
  });

  it('stays inside [0, 1) for a phase a hair below zero', () => {
    // `-1e-18 - Math.floor(-1e-18)` is `-1e-18 + 1`, which rounds to
    // exactly 1 — outside the half-open range this function guarantees.
    expect(wrapPhase(-1e-18)).toBe(0);
    expect(wrapPhase(-Number.MIN_VALUE)).toBe(0);
  });

  it('is total: a non-finite phase wraps to 0', () => {
    expect(wrapPhase(NaN)).toBe(0);
    expect(wrapPhase(Infinity)).toBe(0);
    expect(wrapPhase(-Infinity)).toBe(0);
  });

  it('is the centre of the frame band, not frame / frames', () => {
    // A frame's band is [k/n, (k+1)/n); a bare `k/n` sits on its leading
    // edge, where the division's own rounding can drop it into the band
    // below. `wrapPhase` subtracting the floor (rather than the old
    // `((p % 1) + 1) % 1`) made that far rarer — every index at
    // frames=48 now round-trips through a bare division — but it did not
    // make it safe: frames=49 and frames=22 still round down. Those are
    // pinned here precisely because the round numbers no longer are, so
    // a regression to the bare division cannot hide behind a tidy frame
    // count.
    expect(phaseForFrame(1, 49)).toBeCloseTo(1.5 / 49, 10);
    expect(frameForPhase(1 / 49, 49)).toBe(0); // the bare-division bug
    expect(frameForPhase(phaseForFrame(1, 49), 49)).toBe(1); // the centre
    expect(frameForPhase(15 / 22, 22)).toBe(14); // and again at frames=22
    expect(frameForPhase(phaseForFrame(15, 22), 22)).toBe(15);
  });
});

describe('loopsAt', () => {
  it('is a signed, floored loop count', () => {
    expect(loopsAt(0)).toBe(0);
    expect(loopsAt(0.5)).toBe(0);
    expect(loopsAt(1)).toBe(1);
    expect(loopsAt(1.999)).toBe(1);
    expect(loopsAt(-0.001)).toBe(-1);
    expect(loopsAt(-1)).toBe(-1);
    expect(loopsAt(-1.5)).toBe(-2);
  });
});

describe('wrapFrame', () => {
  it('is the identity for an already in-range frame', () => {
    for (let k = 0; k < 10; k++) {
      expect(wrapFrame(k, 10)).toBe(k);
    }
  });

  // ADR 0006 §6 / finding 8: this is applied to `initialFrame` *before*
  // it is converted to a phase by `phaseForFrame`, on both platforms, so
  // an out-of-range `initialFrame` seeds the same `loopsAt` starting
  // point (0) everywhere, rather than a bare `phaseForFrame(-1, frames)`
  // seeding a phase below 0 (`loopsAt` starts at -1) on whichever
  // platform forgets to wrap first.
  it('wraps out-of-range frames into [0, frames)', () => {
    expect(wrapFrame(-1, 48)).toBe(47);
    expect(wrapFrame(48, 48)).toBe(0);
    expect(wrapFrame(49, 48)).toBe(1);
    expect(wrapFrame(-49, 48)).toBe(47);
  });

  it('rounds a non-integer frame before wrapping', () => {
    expect(wrapFrame(2.6, 10)).toBe(3);
    expect(wrapFrame(-0.6, 10)).toBe(9); // rounds to -1, then wraps
  });
});
