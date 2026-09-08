import { fbm, hash } from './noise';
import type { Brightness } from './renderer';

/**
 * The Rozenite loader's animated light field: a rotating sweep plus a
 * travelling highlight blob and fbm grain. Ported line-for-line from
 * `packages/ui/src/rozenite-loader/rozenite-loader.tsx` so it reproduces
 * that loader visually; `noise` maps to its `noise` prop (default 0.8).
 */
export function gem(opts: { noise?: number } = {}): Brightness {
  const noiseAmt = opts.noise ?? 0.8;
  return (cell, t) => {
    const A = t * Math.PI * 2;
    const ca = Math.cos(A);
    const sa = Math.sin(A);
    const hx = 0.24 * Math.cos(A + 1);
    const hy = 0.24 * Math.sin(A + 1) * 0.85;
    const sweepTerm = (cell.u * ca + cell.v * sa) * 1.9;
    const dx = cell.u - hx;
    const dy = cell.v - hy;
    const blob = Math.exp(-(dx * dx + dy * dy) / 0.02);
    const n = (fbm(cell.u * 3 + ca * 0.8 + 9, cell.v * 4.2 + sa * 0.8) - 0.5) * noiseAmt;
    return 0.5 + 0.45 * sweepTerm + blob + n;
  };
}

/** Wraps `x` into the half-open range `[-1, 1)`. */
function wrapSigned(x: number): number {
  return ((((x + 1) % 2) + 2) % 2) - 1;
}

/**
 * A soft band of light travelling across the shape once per loop.
 * `angle` (radians, default 0 = left to right) sets the travel direction;
 * `width` (default 0.35) sets the band's softness.
 */
export function sweep(opts: { angle?: number; width?: number } = {}): Brightness {
  const angle = opts.angle ?? 0;
  const width = opts.width ?? 0.35;
  const ca = Math.cos(angle);
  const sa = Math.sin(angle);
  return (cell, t) => {
    const axis = cell.u * ca + cell.v * sa;
    // The band centre travels the full [-1, 1] span exactly once as t
    // goes 0 -> 1, so wrapping it into [-1, 1) lands on the same value
    // at t=0 and t=1 — seamless looping.
    const rel = wrapSigned(axis - (2 * t - 1));
    return Math.exp(-(rel * rel) / (2 * width * width));
  };
}

/** Radial breathing: brightest at the centre, oscillating once per loop. */
export function pulse(opts: { min?: number; max?: number } = {}): Brightness {
  const min = opts.min ?? 0.15;
  const max = opts.max ?? 0.95;
  return (cell, t) => {
    const r = Math.sqrt(cell.u * cell.u + cell.v * cell.v);
    const osc = 0.5 + 0.5 * Math.cos(t * Math.PI * 2);
    const level = min + (max - min) * osc;
    return level * Math.max(0, 1 - r * 1.6);
  };
}

/**
 * Vertical drops falling per column. `density` narrows/widens each drop
 * (default 1); `seed` reseeds the per-column offsets (default 0).
 */
export function rain(opts: { density?: number; seed?: number } = {}): Brightness {
  const density = opts.density ?? 1;
  const seed = opts.seed ?? 0;
  const dropWidth = 0.15 / Math.max(density, 0.0001);
  return (cell, t) => {
    const offset = hash(cell.i, seed);
    const v = cell.v + 0.5; // 0 (top) .. 1 (bottom)
    const dropPhase = (((v + t + offset) % 1) + 1) % 1;
    const dist = Math.min(dropPhase, 1 - dropPhase);
    return Math.exp(-(dist * dist) / (2 * dropWidth * dropWidth));
  };
}

/** A horizontal sine wave moving through the shape. */
export function wave(opts: { amplitude?: number; frequency?: number } = {}): Brightness {
  const amplitude = opts.amplitude ?? 0.25;
  const frequency = opts.frequency ?? 2;
  return (cell, t) => {
    const phase = t * Math.PI * 2;
    const waveY = amplitude * Math.sin(cell.u * frequency * Math.PI * 2 + phase);
    const dy = cell.v - waveY;
    return Math.exp(-(dy * dy) / (2 * 0.06 * 0.06));
  };
}

/**
 * A progress-style fill: the fraction `t` of the shape is lit, growing
 * from `direction`'s starting edge. Unlike the other presets this is
 * intentionally *not* periodic (`t=0` is empty, `t=1` is full) — it is
 * meant to be driven by `renderFrame`/a determinate progress value, not
 * looped. Returns a boolean, bypassing the dither entirely for a crisp edge.
 */
export function fill(opts: { direction?: 'up' | 'down' | 'left' | 'right' } = {}): Brightness {
  const direction = opts.direction ?? 'up';
  return (cell, t) => {
    let coord: number;
    switch (direction) {
      case 'up':
        coord = 0.5 - cell.v; // bottom lights first, fill climbs upward
        break;
      case 'down':
        coord = cell.v + 0.5; // top lights first, fill grows downward
        break;
      case 'left':
        coord = 0.5 - cell.u; // right lights first, fill grows leftward
        break;
      case 'right':
        coord = cell.u + 0.5; // left lights first, fill grows rightward
        break;
    }
    return t >= coord;
  };
}

/**
 * Conway's Game of Life, simulated once up front on a wrapping (toroidal)
 * board and played back frame by frame. `seed` picks the starting pattern
 * (same seed always produces the same life and death); `density` (default
 * 0.35) is the initial fraction of live cells.
 *
 * Left fully to chance, some seeds die out completely partway through the
 * loop and stay dark for the rest of it. To keep that from happening, two
 * guardrails are baked into the simulation: the board wraps at its edges
 * (so gliders re-enter instead of vanishing off the side), and if a
 * generation's population ever crashes below a small floor, a sprinkle of
 * fresh cells is seeded back in — deterministically, from the same seed —
 * so the pattern keeps evolving instead of flatlining.
 */
export function gameOfLife(
  opts: { seed?: number; density?: number; frames?: number; boardSize?: number } = {},
): Brightness {
  const seed = opts.seed ?? 1;
  const density = Math.min(1, Math.max(0, opts.density ?? 0.35));
  const frames = Math.max(1, Math.round(opts.frames ?? 48));
  const size = Math.max(4, Math.round(opts.boardSize ?? 48));
  const minAlive = Math.max(4, Math.round(size * size * 0.05));

  const seeded = (i: number, j: number, salt: number): boolean =>
    hash(i + seed * 1013.9 + salt * 91.7, j + seed * 7919.3 - salt * 57.3) < density;

  let board = new Uint8Array(size * size);
  for (let j = 0; j < size; j++) {
    for (let i = 0; i < size; i++) {
      board[j * size + i] = seeded(i, j, 0) ? 1 : 0;
    }
  }

  const generations: Uint8Array[] = [board];
  for (let g = 1; g < frames; g++) {
    const prev = generations[g - 1];
    const next = new Uint8Array(size * size);
    let alive = 0;
    for (let j = 0; j < size; j++) {
      for (let i = 0; i < size; i++) {
        let neighbors = 0;
        for (let dj = -1; dj <= 1; dj++) {
          for (let di = -1; di <= 1; di++) {
            if (di === 0 && dj === 0) continue;
            const ni = (i + di + size) % size;
            const nj = (j + dj + size) % size;
            neighbors += prev[nj * size + ni];
          }
        }
        const wasAlive = prev[j * size + i] === 1;
        const willLive = wasAlive ? neighbors === 2 || neighbors === 3 : neighbors === 3;
        if (willLive) alive++;
        next[j * size + i] = willLive ? 1 : 0;
      }
    }
    // Guardrail: the population crashed, so seed a few fresh cells back in
    // (deterministically, from the same seed) instead of letting it flatline.
    if (alive < minAlive) {
      for (let j = 0; j < size; j++) {
        for (let i = 0; i < size; i++) {
          if (next[j * size + i] === 0 && seeded(i, j, g)) {
            next[j * size + i] = 1;
          }
        }
      }
    }
    generations.push(next);
  }

  return (cell, t) => {
    const g = ((Math.round(t * frames) % frames) + frames) % frames;
    const i = ((cell.i % size) + size) % size;
    const j = ((cell.j % size) + size) % size;
    return generations[g][j * size + i] === 1;
  };
}

export const presets = { gem, sweep, pulse, rain, wave, fill, gameOfLife };
