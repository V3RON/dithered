/**
 * A deterministic 2D hash in [0, 1), used as the value-noise lattice
 * generator. Same maths as the Rozenite loader's animated light field.
 */
export function hash(i: number, j: number): number {
  const n = Math.sin(i * 127.1 + j * 311.7) * 43758.5453;
  return n - Math.floor(n);
}

/** Smooth (Hermite-interpolated) value noise, in [0, 1]. */
export function valueNoise(x: number, y: number): number {
  const i = Math.floor(x);
  const j = Math.floor(y);
  let fx = x - i;
  let fy = y - j;
  fx = fx * fx * (3 - 2 * fx);
  fy = fy * fy * (3 - 2 * fy);
  const a = hash(i, j);
  const b = hash(i + 1, j);
  const c = hash(i, j + 1);
  const d = hash(i + 1, j + 1);
  return a + (b - a) * fx + (c - a) * fy + (a - b - c + d) * fx * fy;
}

/** Two-octave fractal Brownian motion built from {@link valueNoise}. */
export function fbm(x: number, y: number): number {
  return 0.65 * valueNoise(x, y) + 0.35 * valueNoise(x * 2.1 + 5.2, y * 2.1 + 1.3);
}
