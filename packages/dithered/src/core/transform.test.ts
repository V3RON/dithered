import { describe, expect, it } from 'vitest';
import { IDENTITY, apply, isIdentity, multiply, parseTransform } from './transform';

describe('multiply', () => {
  it('applies m2 first, then m1 (m1 x m2)', () => {
    const translate = { a: 1, b: 0, c: 0, d: 1, e: 10, f: 0 };
    const scale = { a: 2, b: 0, c: 0, d: 2, e: 0, f: 0 };
    // translate x scale: scale the point, then translate it.
    const m = multiply(translate, scale);
    expect(apply(m, 1, 1)).toEqual([12, 2]);
  });

  it('is associative with the identity', () => {
    const m = { a: 2, b: 1, c: 3, d: 4, e: 5, f: 6 };
    expect(multiply(IDENTITY, m)).toEqual(m);
    expect(multiply(m, IDENTITY)).toEqual(m);
  });
});

describe('apply', () => {
  it('applies translation', () => {
    expect(apply({ a: 1, b: 0, c: 0, d: 1, e: 5, f: -3 }, 1, 1)).toEqual([6, -2]);
  });

  it('applies the identity as a no-op', () => {
    expect(apply(IDENTITY, 7, 9)).toEqual([7, 9]);
  });
});

describe('isIdentity', () => {
  it('is true only for exactly [1 0 0 1 0 0]', () => {
    expect(isIdentity(IDENTITY)).toBe(true);
    expect(isIdentity({ a: 1, b: 0, c: 0, d: 1, e: 0.0001, f: 0 })).toBe(false);
    expect(isIdentity({ a: 1.0001, b: 0, c: 0, d: 1, e: 0, f: 0 })).toBe(false);
  });
});

describe('parseTransform', () => {
  it('parses translate(tx)', () => {
    expect(apply(parseTransform('translate(10)'), 0, 0)).toEqual([10, 0]);
  });

  it('parses translate(tx ty)', () => {
    expect(apply(parseTransform('translate(10 20)'), 0, 0)).toEqual([10, 20]);
  });

  it('parses scale(s)', () => {
    expect(apply(parseTransform('scale(2)'), 3, 4)).toEqual([6, 8]);
  });

  it('parses scale(sx sy)', () => {
    expect(apply(parseTransform('scale(2 3)'), 1, 1)).toEqual([2, 3]);
  });

  it('parses rotate(a) about the origin', () => {
    const [x, y] = apply(parseTransform('rotate(90)'), 1, 0);
    expect(x).toBeCloseTo(0, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  it('parses rotate(a cx cy) about a center', () => {
    const [x, y] = apply(parseTransform('rotate(90 5 5)'), 6, 5);
    expect(x).toBeCloseTo(5, 10);
    expect(y).toBeCloseTo(6, 10);
  });

  it('parses skewX', () => {
    const [x, y] = apply(parseTransform('skewX(45)'), 0, 1);
    expect(x).toBeCloseTo(1, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  it('parses skewY', () => {
    const [x, y] = apply(parseTransform('skewY(45)'), 1, 0);
    expect(x).toBeCloseTo(1, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  it('parses matrix(a b c d e f) verbatim', () => {
    expect(parseTransform('matrix(1 2 3 4 5 6)')).toEqual({ a: 1, b: 2, c: 3, d: 4, e: 5, f: 6 });
  });

  it('composes a list left to right, so the rightmost function applies first', () => {
    // translate(10,0) rotate(45) => T x R: R applies to the point first.
    const m = parseTransform('translate(10 0) rotate(90)');
    const [x, y] = apply(m, 1, 0);
    expect(x).toBeCloseTo(10, 10);
    expect(y).toBeCloseTo(1, 10);
  });

  it('accepts comma and/or whitespace separators, in the argument list and between functions', () => {
    const a = parseTransform('translate(10,20) scale(2,3)');
    const b = parseTransform('translate(10, 20), scale(2, 3)');
    expect(a).toEqual(b);
  });

  it('returns the identity for an empty string', () => {
    expect(parseTransform('')).toEqual(IDENTITY);
    expect(parseTransform('   ')).toEqual(IDENTITY);
  });

  it('throws on an unknown function name', () => {
    expect(() => parseTransform('spin(10)')).toThrow(/spin/);
  });

  it('throws on a wrong argument count', () => {
    expect(() => parseTransform('translate(1 2 3)')).toThrow(/translate/);
    expect(() => parseTransform('matrix(1 2 3)')).toThrow(/matrix/);
    expect(() => parseTransform('rotate()')).toThrow(/rotate/);
  });

  it('throws on garbage between recognized functions', () => {
    expect(() => parseTransform('translate(10 0) ???')).toThrow();
  });

  it('throws on an unparseable number', () => {
    expect(() => parseTransform('translate(abc)')).toThrow();
  });
});
