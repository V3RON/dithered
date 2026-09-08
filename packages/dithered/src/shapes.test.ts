import { describe, expect, it } from 'vitest';
import { sampleCells } from './shape';
import { circle, diamond, heart, rozenite, shapes, square } from './shapes';

const ACCEPT_ALL = () => true;

describe('shapes', () => {
  it('exposes all five named shapes', () => {
    expect(Object.keys(shapes).sort()).toEqual(
      ['circle', 'diamond', 'heart', 'rozenite', 'square'].sort(),
    );
  });

  it.each(Object.entries(shapes))(
    '%s has a non-empty path and a positive-area viewBox',
    (_name, shape) => {
      expect(shape.path.length).toBeGreaterThan(0);
      expect(shape.viewBox.width).toBeGreaterThan(0);
      expect(shape.viewBox.height).toBeGreaterThan(0);
    },
  );

  it.each(Object.entries(shapes))(
    '%s samples a non-empty grid with an accept-all hit tester',
    (_name, shape) => {
      const cells = sampleCells(shape, 12, ACCEPT_ALL);
      expect(cells.length).toBeGreaterThan(0);
    },
  );

  it('rozenite matches the reference PATH_D and viewBox verbatim', () => {
    expect(rozenite.path).toBe(
      'M17.333 5.333H20V10.667H22.667V16H25.333V24H22.667V26.667H20V29.333H12' +
        'V26.667H9.333V24H6.667V16H9.333V10.667H12V5.333H14.667V2.667H17.333V5.333Z',
    );
    expect(rozenite.viewBox).toEqual({ x: 6.67, y: 2.67, width: 18.67, height: 26.67 });
  });

  it('exports the same objects both individually and via the `shapes` map', () => {
    expect(shapes.circle).toBe(circle);
    expect(shapes.square).toBe(square);
    expect(shapes.diamond).toBe(diamond);
    expect(shapes.heart).toBe(heart);
    expect(shapes.rozenite).toBe(rozenite);
  });
});
