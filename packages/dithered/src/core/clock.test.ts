import { describe, expect, it } from 'vitest';
import { advancePhase, frameForPhase, loopsAt, wrapPhase } from './clock';

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
