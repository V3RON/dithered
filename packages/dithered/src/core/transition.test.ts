import { describe, expect, it } from 'vitest';
import type { Cell } from '../shape';
import {
  ENTER_START,
  EXIT_END,
  blend,
  blendPhases,
  createTransition,
  diffCells,
  enterAt,
  exitAt,
  toLevel,
  transitionCells,
  type CellDiff,
} from './transition';

function cell(i: number, j: number, threshold: number): Cell {
  return { i, j, u: i / 10 - 0.5, v: j / 10 - 0.5, threshold };
}

/** Cells identified only by `(i, j)` — ignores `u`/`v`/`threshold`, since
 * `shared` deliberately swaps in the target's object for the same slot. */
function byPosition(cells: readonly Cell[]): Array<[number, number]> {
  return cells
    .map((c) => [c.i, c.j] as [number, number])
    .sort((a, b) => a[0] - b[0] || a[1] - b[1]);
}

describe('diffCells', () => {
  it('partitions two cell sets into exiting / entering / shared by (i, j)', () => {
    const from = [cell(0, 0, 0.1), cell(1, 0, 0.9)];
    const to = [cell(0, 0, 0.1), cell(2, 0, 0.5)];

    const diff = diffCells(from, to);

    expect(byPosition(diff.shared)).toEqual([[0, 0]]);
    expect(byPosition(diff.exiting)).toEqual([[1, 0]]);
    expect(byPosition(diff.entering)).toEqual([[2, 0]]);
  });

  it('shared uses the target cell objects, not the source ones', () => {
    const fromCell = cell(0, 0, 0.1);
    const toCell = cell(0, 0, 0.1); // same position, distinct object

    const diff = diffCells([fromCell], [toCell]);

    expect(diff.shared).toEqual([toCell]);
    expect(diff.shared[0]).toBe(toCell);
    expect(diff.shared[0]).not.toBe(fromCell);
  });

  it('an empty `to` makes every source cell exiting; an empty `from` makes every target cell entering', () => {
    const from = [cell(0, 0, 0.1), cell(1, 0, 0.9)];

    expect(diffCells(from, []).exiting).toHaveLength(2);
    expect(diffCells(from, []).shared).toHaveLength(0);
    expect(diffCells([], from).entering).toHaveLength(2);
    expect(diffCells([], from).shared).toHaveLength(0);
  });

  it('orders exiting ascending by threshold and entering descending by threshold', () => {
    const from = [cell(0, 0, 0.8), cell(1, 0, 0.2), cell(2, 0, 0.5)];
    const to: Cell[] = [];
    const entering = [cell(3, 0, 0.8), cell(4, 0, 0.2), cell(5, 0, 0.5)];

    const diff = diffCells(from, entering);

    expect(diff.exiting.map((c) => c.threshold)).toEqual([0.2, 0.5, 0.8]);
    expect(diff.entering.map((c) => c.threshold)).toEqual([0.8, 0.5, 0.2]);
  });

  it('breaks threshold ties by ascending (j, i), deterministically', () => {
    // Same threshold, varying (j, i) — order must not depend on input order.
    const from = [cell(5, 1, 0.5), cell(2, 0, 0.5), cell(9, 0, 0.5), cell(1, 1, 0.5)];

    const diff = diffCells(from, []);

    expect(diff.exiting.map((c) => [c.i, c.j])).toEqual([
      [2, 0],
      [9, 0],
      [1, 1],
      [5, 1],
    ]);

    const diff2 = diffCells([], from);
    // entering is sorted descending by threshold, but the tie-break stays
    // ascending (j, i) — ties don't reverse with the primary key.
    expect(diff2.entering.map((c) => [c.i, c.j])).toEqual([
      [2, 0],
      [9, 0],
      [1, 1],
      [5, 1],
    ]);
  });
});

describe('exitAt / enterAt', () => {
  it('space exiting cells evenly across [0, EXIT_END)', () => {
    expect(exitAt(0, 3)).toBeCloseTo((1 / 4) * EXIT_END);
    expect(exitAt(2, 3)).toBeCloseTo((3 / 4) * EXIT_END);
    // the last cell (by rank) always survives past the schedule's midpoint
    expect(exitAt(2, 3)).toBeLessThan(EXIT_END);
    expect(exitAt(2, 3)).toBeGreaterThan(EXIT_END / 2);
  });

  it('space entering cells evenly across [ENTER_START, 1)', () => {
    expect(enterAt(0, 3)).toBe(ENTER_START);
    expect(enterAt(2, 3)).toBeCloseTo(ENTER_START + (2 / 3) * (1 - ENTER_START));
    expect(enterAt(2, 3)).toBeLessThan(1);
  });
});

describe('transitionCells', () => {
  function makeDiff(n: number, m: number, sharedCount = 2): CellDiff {
    const shared = Array.from({ length: sharedCount }, (_, k) => cell(k, 0, 0.5));
    const exiting = Array.from({ length: n }, (_, k) => cell(100 + k, 1, (k + 1) / (n + 2)));
    const entering = Array.from({ length: m }, (_, k) => cell(200 + k, 2, (k + 1) / (m + 2)));
    return { shared, exiting, entering };
  }

  it('at p = 0, equals the source set (all shared + all exiting, no entering)', () => {
    const diff = makeDiff(4, 3);
    const drawn = transitionCells(diff, 0);
    expect(byPosition(drawn)).toEqual(byPosition([...diff.shared, ...diff.exiting]));
  });

  it('at p = 1, equals the target set (all shared + all entering, no exiting)', () => {
    const diff = makeDiff(4, 3);
    const drawn = transitionCells(diff, 1);
    expect(byPosition(drawn)).toEqual(byPosition([...diff.shared, ...diff.entering]));
  });

  it('is monotone: exiting cells only ever leave and entering cells only ever arrive as p increases', () => {
    const diff = makeDiff(5, 5);
    const exitingKeys = diff.exiting.map((c) => `${c.i},${c.j}`);
    const enteringKeys = diff.entering.map((c) => `${c.i},${c.j}`);

    let prevExitingPresent = new Set(exitingKeys);
    let prevEnteringPresent = new Set<string>();

    for (let step = 1; step <= 200; step++) {
      const p = step / 200;
      const drawnKeys = new Set(transitionCells(diff, p).map((c) => `${c.i},${c.j}`));

      for (const key of exitingKeys) {
        const present = drawnKeys.has(key);
        // Once gone, never comes back.
        if (!prevExitingPresent.has(key)) expect(present).toBe(false);
      }
      for (const key of enteringKeys) {
        const present = drawnKeys.has(key);
        // Once arrived, never leaves.
        if (prevEnteringPresent.has(key)) expect(present).toBe(true);
      }

      prevExitingPresent = new Set(exitingKeys.filter((k) => drawnKeys.has(k)));
      prevEnteringPresent = new Set(enteringKeys.filter((k) => drawnKeys.has(k)));
    }
  });

  it('is never empty for any p in [0, 1], swept finely, including the disjoint case', () => {
    // Every case here keeps both `from` (shared + exiting) and `to`
    // (shared + entering) non-empty — a transition always morphs between
    // two real, sampled shapes. (A diff with, say, shared = entering = 0
    // describes a `to` shape with zero cells at all, which has nothing to
    // guarantee non-emptiness *of* — there is no target to reach.)
    const cases: CellDiff[] = [
      makeDiff(6, 6, 3), // ordinary case, some shared cells
      makeDiff(6, 6, 0), // disjoint: no shared cells at all
      makeDiff(1, 1, 0), // smallest possible non-trivial disjoint sets
      makeDiff(4, 0, 2), // `to` entirely contained in `from`: no entering
      makeDiff(0, 4, 2), // `from` entirely contained in `to`: no exiting
    ];

    for (const diff of cases) {
      for (let step = 0; step <= 500; step++) {
        const p = step / 500;
        expect(transitionCells(diff, p).length).toBeGreaterThan(0);
      }
    }
  });
});

describe('toLevel', () => {
  it('coerces booleans to 1/0 and passes numbers through unchanged', () => {
    expect(toLevel(true)).toBe(1);
    expect(toLevel(false)).toBe(0);
    expect(toLevel(0.37)).toBe(0.37);
    expect(toLevel(1.5)).toBe(1.5); // brightness can exceed 1; not this function's job to clamp
  });
});

describe('blend', () => {
  const c = cell(0, 0, 0.5);

  it('is exact at mix = 0 and mix = 1', () => {
    const a = () => 0.2;
    const b = () => 0.8;
    expect(blend(a, b, 0)(c, 0)).toBe(0.2);
    expect(blend(a, b, 1)(c, 0)).toBe(0.8);
  });

  it('is linear in between', () => {
    const a = () => 0;
    const b = () => 1;
    expect(blend(a, b, 0.25)(c, 0)).toBeCloseTo(0.25);
    expect(blend(a, b, 0.5)(c, 0)).toBeCloseTo(0.5);
    expect(blend(a, b, 0.75)(c, 0)).toBeCloseTo(0.75);
  });

  it('clamps mix outside [0, 1]', () => {
    const a = () => 0.2;
    const b = () => 0.8;
    expect(blend(a, b, -5)(c, 0)).toBe(0.2);
    expect(blend(a, b, 5)(c, 0)).toBe(0.8);
  });

  it('coerces boolean brightness before blending, matching the documented draw decisions', () => {
    const alwaysTrue = () => true;
    const alwaysFalse = () => false;
    const half = () => 0.5;

    // mix = 0 -> pure `a`; a coerced `true` always beats a threshold in (0, 1).
    expect(blend(alwaysTrue, alwaysFalse, 0)(c, 0)).toBe(1);
    // mix = 1 -> pure `b`; a coerced `false` never beats a threshold in (0, 1).
    expect(blend(alwaysTrue, alwaysFalse, 1)(c, 0)).toBe(0);
    // true (1) blended halfway with false (0) lands exactly on 0.5.
    expect(blend(alwaysTrue, alwaysFalse, 0.5)(c, 0)).toBe(0.5);
    // true (1) blended halfway with a raw 0.5 level lands on 0.75.
    expect(blend(alwaysTrue, half, 0.5)(c, 0)).toBe(0.75);
  });
});

describe('blendPhases', () => {
  it('samples each side at its own phase rather than a shared t', () => {
    const a = (_: Cell, t: number) => t; // reports back whatever phase it was called with
    const b = (_: Cell, t: number) => t;
    const blended = blendPhases(a, b, 0, 0.1, 0.9);
    // mix = 0 -> pure `a`, sampled at ta = 0.1, not at whatever `t` is passed in.
    expect(blended(cell(0, 0, 0.5), 0.5)).toBeCloseTo(0.1);

    const blended2 = blendPhases(a, b, 1, 0.1, 0.9);
    expect(blended2(cell(0, 0, 0.5), 0.5)).toBeCloseTo(0.9);
  });
});

describe('createTransition', () => {
  const fromCells = [cell(0, 0, 0.1), cell(1, 0, 0.9)];
  const toCells = [cell(0, 0, 0.1), cell(2, 0, 0.5)];

  it('progressAt is linear in wall-clock time and clamps to [0, 1]', () => {
    const t = createTransition(
      { cells: fromCells, brightness: () => true, period: 1000, frames: 10 },
      { cells: toCells, brightness: () => true, period: 1000, frames: 10 },
      1000, // startedAt
      400, // duration
    );

    expect(t.progressAt(1000)).toBe(0);
    expect(t.progressAt(1200)).toBeCloseTo(0.5);
    expect(t.progressAt(1400)).toBe(1);
    // clamps: before start, and long after completion.
    expect(t.progressAt(900)).toBe(0);
    expect(t.progressAt(5000)).toBe(1);
  });

  it('drives each side from its own period/frames when brightnessAt is called', () => {
    const seenFrom: number[] = [];
    const seenTo: number[] = [];
    const fromBrightness = (_: Cell, t: number) => {
      seenFrom.push(t);
      return true;
    };
    const toBrightness = (_: Cell, t: number) => {
      seenTo.push(t);
      return true;
    };

    const t = createTransition(
      { cells: fromCells, brightness: fromBrightness, period: 1000, frames: 10 },
      { cells: toCells, brightness: toBrightness, period: 500, frames: 5 },
      0,
      400,
    );

    // now = 250ms: from (period 1000, frames 10) -> phase 250/1000=0.25 -> frame 2 -> t=0.2
    // to   (period 500,  frames 5)  -> phase 250/500=0.5   -> frame 2 -> t=0.4
    const brightness = t.brightnessAt(0.5, 250);
    brightness(cell(0, 0, 0.5), 0.5 /* ignored: each side uses its own phase */);

    expect(seenFrom[0]).toBeCloseTo(0.2);
    expect(seenTo[0]).toBeCloseTo(0.4);
  });

  it('cellsAt delegates to transitionCells over the diff of from/to cells', () => {
    const t = createTransition(
      { cells: fromCells, brightness: () => true, period: 1000, frames: 10 },
      { cells: toCells, brightness: () => true, period: 1000, frames: 10 },
      0,
      400,
    );

    expect(byPosition(t.cellsAt(0))).toEqual(byPosition(fromCells));
    expect(byPosition(t.cellsAt(1))).toEqual(byPosition(toCells));
  });
});
