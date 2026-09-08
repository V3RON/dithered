import { describe, expect, it } from 'vitest';
import { basicShapeToPath, type AttrGetter } from './svg-shapes';

/** Builds an `AttrGetter` from a plain object, `null` for anything absent. */
function attrs(values: Record<string, string>): AttrGetter {
  return (name) => (name in values ? values[name] : null);
}

describe('basicShapeToPath: rect', () => {
  it('converts a plain rect to M/H/V/H/Z', () => {
    expect(basicShapeToPath('rect', attrs({ x: '10', y: '20', width: '30', height: '40' }))).toBe(
      'M 10 20 H 40 V 60 H 10 Z',
    );
  });

  it('defaults x/y to 0', () => {
    expect(basicShapeToPath('rect', attrs({ width: '10', height: '10' }))).toBe(
      'M 0 0 H 10 V 10 H 0 Z',
    );
  });

  it('mirrors rx onto ry, and ry onto rx, when only one is given', () => {
    const withRx = basicShapeToPath('rect', attrs({ width: '20', height: '10', rx: '3' }));
    const withRy = basicShapeToPath('rect', attrs({ width: '20', height: '10', ry: '3' }));
    expect(withRx).toBe(withRy);
    expect(withRx).toContain('A 3 3 0 0 1');
  });

  it('clamps rx/ry to half the corresponding side', () => {
    const d = basicShapeToPath('rect', attrs({ width: '20', height: '10', rx: '999' }));
    // Clamped to width/2=10 and height/2=5.
    expect(d).toContain('A 10 5 0 0 1');
  });

  it('treats a negative radius as absent', () => {
    const d = basicShapeToPath('rect', attrs({ width: '10', height: '10', rx: '-5' }));
    expect(d).toBe('M 0 0 H 10 V 10 H 0 Z');
  });

  it('treats rx/ry "auto" as absent', () => {
    const d = basicShapeToPath(
      'rect',
      attrs({ width: '10', height: '10', rx: 'auto', ry: 'auto' }),
    );
    expect(d).toBe('M 0 0 H 10 V 10 H 0 Z');
  });

  it('skips a rect with missing width/height', () => {
    expect(basicShapeToPath('rect', attrs({ height: '10' }))).toBeNull();
    expect(basicShapeToPath('rect', attrs({ width: '10' }))).toBeNull();
  });

  it('skips a rect with zero or negative width/height', () => {
    expect(basicShapeToPath('rect', attrs({ width: '0', height: '10' }))).toBeNull();
    expect(basicShapeToPath('rect', attrs({ width: '10', height: '-1' }))).toBeNull();
  });

  it('skips a rect with non-numeric width/height', () => {
    expect(basicShapeToPath('rect', attrs({ width: 'huge', height: '10' }))).toBeNull();
  });

  it('accepts a trailing px unit', () => {
    expect(basicShapeToPath('rect', attrs({ width: '10px', height: '10px' }))).toBe(
      'M 0 0 H 10 V 10 H 0 Z',
    );
  });

  it('treats a percentage or other CSS unit as absent, same as any other unparseable value', () => {
    expect(basicShapeToPath('rect', attrs({ width: '50%', height: '10' }))).toBeNull();
    expect(basicShapeToPath('rect', attrs({ x: '2em', width: '10', height: '10' }))).toBe(
      'M 0 0 H 10 V 10 H 0 Z', // unparseable x falls back to 0, same as absent
    );
  });

  it('emits a rounded rect clockwise from the top-left corner', () => {
    const d = basicShapeToPath('rect', attrs({ width: '20', height: '10', rx: '2', ry: '2' }));
    expect(d).toBe(
      'M 2 0 H 18 A 2 2 0 0 1 20 2 V 8 A 2 2 0 0 1 18 10 H 2 A 2 2 0 0 1 0 8 V 2 A 2 2 0 0 1 2 0 Z',
    );
  });
});

describe('basicShapeToPath: circle', () => {
  it('converts to a two-arc path', () => {
    expect(basicShapeToPath('circle', attrs({ cx: '5', cy: '5', r: '5' }))).toBe(
      'M 10 5 A 5 5 0 0 1 0 5 A 5 5 0 0 1 10 5 Z',
    );
  });

  it('defaults cx/cy to 0', () => {
    expect(basicShapeToPath('circle', attrs({ r: '3' }))).toBe(
      'M 3 0 A 3 3 0 0 1 -3 0 A 3 3 0 0 1 3 0 Z',
    );
  });

  it('skips a circle with a missing, zero, or negative radius', () => {
    expect(basicShapeToPath('circle', attrs({}))).toBeNull();
    expect(basicShapeToPath('circle', attrs({ r: '0' }))).toBeNull();
    expect(basicShapeToPath('circle', attrs({ r: '-1' }))).toBeNull();
  });
});

describe('basicShapeToPath: ellipse', () => {
  it('converts to a two-arc path with independent rx/ry', () => {
    expect(basicShapeToPath('ellipse', attrs({ cx: '5', cy: '5', rx: '10', ry: '5' }))).toBe(
      'M 15 5 A 10 5 0 0 1 -5 5 A 10 5 0 0 1 15 5 Z',
    );
  });

  it('mirrors a single given radius onto the other axis', () => {
    const withRx = basicShapeToPath('ellipse', attrs({ rx: '4' }));
    const withRy = basicShapeToPath('ellipse', attrs({ ry: '4' }));
    expect(withRx).toBe(withRy);
    expect(withRx).toContain('A 4 4 0 0 1');
  });

  it('skips an ellipse with no radius given at all', () => {
    expect(basicShapeToPath('ellipse', attrs({}))).toBeNull();
  });

  it('skips an ellipse with a zero or negative resolved radius', () => {
    expect(basicShapeToPath('ellipse', attrs({ rx: '0', ry: '5' }))).toBeNull();
  });
});

describe('basicShapeToPath: polygon', () => {
  it('converts points to M/L.../Z', () => {
    expect(basicShapeToPath('polygon', attrs({ points: '0,0 10,0 5,10' }))).toBe(
      'M 0 0 L 10 0 L 5 10 Z',
    );
  });

  it('accepts whitespace-separated points too', () => {
    expect(basicShapeToPath('polygon', attrs({ points: '0 0 10 0 5 10' }))).toBe(
      'M 0 0 L 10 0 L 5 10 Z',
    );
  });

  it('drops a trailing odd coordinate', () => {
    expect(basicShapeToPath('polygon', attrs({ points: '0,0 10,0 5,10 99' }))).toBe(
      'M 0 0 L 10 0 L 5 10 Z',
    );
  });

  it('skips with fewer than two points', () => {
    expect(basicShapeToPath('polygon', attrs({ points: '0,0' }))).toBeNull();
    expect(basicShapeToPath('polygon', attrs({ points: '' }))).toBeNull();
    expect(basicShapeToPath('polygon', attrs({}))).toBeNull();
  });

  it('skips on an unparseable coordinate', () => {
    expect(basicShapeToPath('polygon', attrs({ points: '0,0 x,10' }))).toBeNull();
  });

  it('keeps the valid prefix when the unparseable token is trailing, rather than skipping the element (regression: finding 4)', () => {
    // Both this and the mid-list case above stop at the bad token, but
    // only here does that leave >= 2 points behind — this is the case the
    // round-1 fix regressed, dropping the whole polygon instead of the
    // one bad trailing point.
    expect(basicShapeToPath('polygon', attrs({ points: '0,0 10,0 5,10 x' }))).toBe(
      'M 0 0 L 10 0 L 5 10 Z',
    );
  });

  it('accepts a sign glued directly onto the next number with no separator', () => {
    // "10-5" is a legal points value: the sign starts a new number.
    expect(basicShapeToPath('polygon', attrs({ points: '0 0 10-5 20 20' }))).toBe(
      'M 0 0 L 10 -5 L 20 20 Z',
    );
  });
});

describe('basicShapeToPath: polyline', () => {
  it('converts points to M/L... without closing', () => {
    expect(basicShapeToPath('polyline', attrs({ points: '0,0 10,0 5,10' }))).toBe(
      'M 0 0 L 10 0 L 5 10',
    );
  });
});

describe('basicShapeToPath: line and unknown tags', () => {
  it('returns null for <line> (zero area)', () => {
    expect(basicShapeToPath('line', attrs({ x1: '0', y1: '0', x2: '10', y2: '10' }))).toBeNull();
  });

  it('returns null for a tag it does not know', () => {
    expect(basicShapeToPath('path', attrs({ d: 'M0 0 Z' }))).toBeNull();
  });
});
