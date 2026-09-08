#!/usr/bin/env node
/**
 * Generates `src/blue-noise.generated.ts`: a 16x16 table of the ranks
 * 0..255, each appearing exactly once, produced by Ulichney's
 * void-and-cluster method on a toroidal domain.
 *
 * Run with `pnpm --filter dithered generate:blue-noise`. The output is
 * deterministic (seeded PRNG below) and is committed — this script is
 * never run by the library itself, only by whoever regenerates the table.
 *
 * Reference: Robert Ulichney, "Void-and-cluster method for dither array
 * generation", 1993.
 */
import { writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const SIZE = 16;
const CELLS = SIZE * SIZE;
const SIGMA = 1.5;
// Fixed so re-running this script reproduces the committed table exactly.
const SEED = 0x5eed_1234;
// Ulichney's rule of thumb for the initial binary pattern: ~10% ones.
const INITIAL_ONES = Math.round(CELLS * 0.1);

// ---------------------------------------------------------------------------
// seeded PRNG (mulberry32) — deterministic across Node versions/platforms
// ---------------------------------------------------------------------------

function mulberry32(seed) {
  let state = seed >>> 0;
  return function next() {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// toroidal Gaussian filter
// ---------------------------------------------------------------------------

/** `kernel[dy][dx]`: filter weight at toroidal offset `(dx, dy)`. */
function buildKernel() {
  const kernel = Array.from({ length: SIZE }, () => new Float64Array(SIZE));
  for (let dy = 0; dy < SIZE; dy++) {
    const wy = Math.min(dy, SIZE - dy);
    for (let dx = 0; dx < SIZE; dx++) {
      const wx = Math.min(dx, SIZE - dx);
      kernel[dy][dx] = Math.exp(-(wx * wx + wy * wy) / (2 * SIGMA * SIGMA));
    }
  }
  return kernel;
}

const KERNEL = buildKernel();

/** Adds (or, with `sign: -1`, subtracts) pixel `(x0, y0)`'s contribution to every cell's density. */
function applyKernel(density, x0, y0, sign) {
  for (let y = 0; y < SIZE; y++) {
    const dy = (y - y0 + SIZE) % SIZE;
    const row = KERNEL[dy];
    for (let x = 0; x < SIZE; x++) {
      const dx = (x - x0 + SIZE) % SIZE;
      density[y * SIZE + x] += sign * row[dx];
    }
  }
}

function tightestCluster(density, pattern) {
  let best = -1;
  let bestDensity = -Infinity;
  for (let idx = 0; idx < CELLS; idx++) {
    if (pattern[idx] === 1 && density[idx] > bestDensity) {
      bestDensity = density[idx];
      best = idx;
    }
  }
  return best;
}

function largestVoid(density, pattern) {
  let best = -1;
  let bestDensity = Infinity;
  for (let idx = 0; idx < CELLS; idx++) {
    if (pattern[idx] === 0 && density[idx] < bestDensity) {
      bestDensity = density[idx];
      best = idx;
    }
  }
  return best;
}

function toggle(pattern, density, idx, on) {
  pattern[idx] = on ? 1 : 0;
  applyKernel(density, idx % SIZE, Math.floor(idx / SIZE), on ? 1 : -1);
}

// ---------------------------------------------------------------------------
// phase 1: initial binary pattern, relaxed by cluster/void swapping
// ---------------------------------------------------------------------------

function buildInitialPattern() {
  const random = mulberry32(SEED);
  const pattern = new Uint8Array(CELLS);
  const density = new Float64Array(CELLS);

  const positions = Array.from({ length: CELLS }, (_, i) => i);
  for (let i = positions.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [positions[i], positions[j]] = [positions[j], positions[i]];
  }
  for (const idx of positions.slice(0, INITIAL_ONES)) {
    toggle(pattern, density, idx, true);
  }

  // Relax: swap the tightest cluster for the largest void until the pair
  // coincides (removing the tightest cluster would just reopen the void
  // it sits in), which is the method's definition of a stable pattern.
  for (let iterations = 0; iterations < CELLS * 4; iterations++) {
    const cluster = tightestCluster(density, pattern);
    toggle(pattern, density, cluster, false);
    const void_ = largestVoid(density, pattern);
    if (void_ === cluster) {
      toggle(pattern, density, cluster, true);
      break;
    }
    toggle(pattern, density, void_, true);
  }

  return { pattern, density };
}

// ---------------------------------------------------------------------------
// phases 2 & 3: rank below and above the initial pattern
// ---------------------------------------------------------------------------

function buildRanks() {
  const { pattern: initialPattern, density: initialDensity } = buildInitialPattern();
  const ranks = new Int32Array(CELLS).fill(-1);
  const initialOnes = initialPattern.reduce((sum, v) => sum + v, 0);

  // Phase 2: rank the initial pattern's ones downward from initialOnes - 1
  // to 0, repeatedly peeling off the tightest remaining cluster.
  {
    const pattern = initialPattern.slice();
    const density = initialDensity.slice();
    for (let rank = initialOnes - 1; rank >= 0; rank--) {
      const cluster = tightestCluster(density, pattern);
      ranks[cluster] = rank;
      toggle(pattern, density, cluster, false);
    }
  }

  // Phase 3: rank everything else upward from initialOnes to CELLS - 1,
  // repeatedly filling the largest remaining void.
  {
    const pattern = initialPattern.slice();
    const density = initialDensity.slice();
    for (let rank = initialOnes; rank < CELLS; rank++) {
      const void_ = largestVoid(density, pattern);
      ranks[void_] = rank;
      toggle(pattern, density, void_, true);
    }
  }

  return ranks;
}

// ---------------------------------------------------------------------------
// emit
// ---------------------------------------------------------------------------

function toTable(ranks) {
  const rows = [];
  for (let y = 0; y < SIZE; y++) {
    rows.push(Array.from(ranks.slice(y * SIZE, y * SIZE + SIZE)));
  }
  return rows;
}

function render(table) {
  const rowsSource = table.map((row) => `  [${row.join(', ')}],`).join('\n');
  return `/**
 * Generated file — do not edit by hand.
 *
 * A 16x16 blue-noise threshold matrix: the ranks 0..255, each appearing
 * exactly once, produced by Ulichney's void-and-cluster method on a
 * toroidal domain.
 *
 * Regenerate with \`pnpm --filter dithered generate:blue-noise\`, which
 * runs scripts/blue-noise.mjs (seed 0x${SEED.toString(16)}, Gaussian filter
 * sigma ${SIGMA}). The seed is fixed, so re-running the script reproduces
 * this table exactly.
 */
export const BLUE_NOISE_16: readonly (readonly number[])[] = [
${rowsSource}
];
`;
}

const ranks = buildRanks();
const table = toTable(ranks);
const outPath = join(dirname(fileURLToPath(import.meta.url)), '../src/blue-noise.generated.ts');
writeFileSync(outPath, render(table));
console.log(`Wrote ${outPath}`);
