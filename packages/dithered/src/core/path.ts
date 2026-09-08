import { apply, type Matrix } from './transform';

/**
 * One SVG path command as written: the command letter (case preserved,
 * so `l` is relative and `L` is absolute) plus its numeric arguments.
 * Implicit repeats (`M 0 0 10 10` — a lone-`M` followed by extra
 * coordinate pairs) are expanded by {@link parsePath}, so every segment
 * here carries exactly one command's worth of arguments.
 */
export interface PathSegment {
  command: string;
  values: number[];
}

const ARG_COUNTS: Record<string, number> = {
  M: 2,
  L: 2,
  H: 1,
  V: 1,
  C: 6,
  S: 4,
  Q: 4,
  T: 2,
  A: 7,
  Z: 0,
};

const COMMAND_LETTERS = new Set(Object.keys(ARG_COUNTS).flatMap((c) => [c, c.toLowerCase()]));

const isDigit = (ch: string | undefined) => ch !== undefined && ch >= '0' && ch <= '9';

/**
 * Reads one number token — SVG's shared grammar for path data and
 * `points` lists: an optional sign, digits, an optional fraction, an
 * optional exponent — from `s` starting at `i`, which must not be on
 * whitespace or a comma (the caller skips separators; the two callers
 * disagree on what those are).
 *
 * Returns `null`, rather than throwing, when `s[i..]` doesn't start with
 * a valid number: `parsePath` turns that into a thrown error (a bad `d`
 * is a loader error), while `svg-shapes.ts`'s `points` scanner turns it
 * into "stop scanning here", keeping whatever valid prefix it already
 * collected (a bad `points` value just means the list ends early, like a
 * renderer parsing up to the error).
 */
export function readNumberToken(s: string, i: number): { value: number; end: number } | null {
  const start = i;
  if (s[i] === '+' || s[i] === '-') i++;
  while (isDigit(s[i])) i++;
  if (s[i] === '.') {
    i++;
    while (isDigit(s[i])) i++;
  }
  if (s[i] === 'e' || s[i] === 'E') {
    i++;
    if (s[i] === '+' || s[i] === '-') i++;
    while (isDigit(s[i])) i++;
  }
  const text = s.slice(start, i);
  const value = Number(text);
  if (!text || text === '+' || text === '-' || text === '.' || Number.isNaN(value)) return null;
  return { value, end: i };
}

/**
 * Tokenizes an SVG path `d` attribute into {@link PathSegment}s.
 *
 * Implicit command repeats are expanded (a lone `M`/`m` repeats as
 * `L`/`l`, per spec), but relative commands and shorthand curves
 * (`H`/`V`/`S`/`T`) are otherwise left as written — see {@link toAbsolute}.
 * Throws on an unknown command letter, a wrong argument count, or an
 * unparseable number, rather than truncating and returning a half-path.
 */
export function parsePath(d: string): PathSegment[] {
  const segments: PathSegment[] = [];
  const n = d.length;
  let i = 0;
  let currentCommand: string | null = null;

  const isSeparator = (ch: string) =>
    ch === ' ' || ch === '\t' || ch === '\n' || ch === '\r' || ch === ',';
  const skipSeparators = () => {
    while (i < n && isSeparator(d[i])) i++;
  };

  const readNumber = (): number => {
    skipSeparators();
    const token = readNumberToken(d, i);
    if (!token) {
      throw new Error(`parsePath: expected a number at position ${i} in "${d}".`);
    }
    i = token.end;
    return token.value;
  };

  const readFlag = (): number => {
    skipSeparators();
    const ch = d[i];
    if (ch !== '0' && ch !== '1') {
      throw new Error(`parsePath: expected a flag (0 or 1) at position ${i} in "${d}".`);
    }
    i++;
    return Number(ch);
  };

  skipSeparators();
  while (i < n) {
    let command: string;
    if (COMMAND_LETTERS.has(d[i])) {
      command = d[i];
      i++;
      currentCommand = command;
    } else {
      if (currentCommand === null) {
        throw new Error(`parsePath: expected a command letter at position ${i} in "${d}".`);
      }
      if (currentCommand.toUpperCase() === 'Z') {
        throw new Error(`parsePath: unexpected data after "Z" at position ${i} in "${d}".`);
      }
      // Implicit repeat: a lone M/m continues as L/l, everything else repeats itself.
      command = currentCommand === 'M' ? 'L' : currentCommand === 'm' ? 'l' : currentCommand;
      currentCommand = command;
    }

    const upper = command.toUpperCase();
    if (upper === 'Z') {
      segments.push({ command, values: [] });
      skipSeparators();
      continue;
    }

    const values: number[] =
      upper === 'A'
        ? [
            readNumber(),
            readNumber(),
            readNumber(),
            readFlag(),
            readFlag(),
            readNumber(),
            readNumber(),
          ]
        : Array.from({ length: ARG_COUNTS[upper] }, () => readNumber());

    segments.push({ command, values });
    skipSeparators();
  }

  return segments;
}

/**
 * Normalizes segments to absolute coordinates, folding shorthand
 * commands into their general form: `H`/`V` become `L`, `S` becomes `C`
 * (reflecting the previous cubic's control point, or the current point
 * if the previous command wasn't a cubic), `T` becomes `Q` likewise.
 * `A` and `Z` pass through unchanged apart from making `A`'s endpoint
 * absolute.
 */
export function toAbsolute(segments: PathSegment[]): PathSegment[] {
  const result: PathSegment[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;
  let prevCommand = '';
  let prevControl: [number, number] = [0, 0];

  for (const seg of segments) {
    const upper = seg.command.toUpperCase();
    const rel = seg.command !== upper;
    const v = seg.values;

    switch (upper) {
      case 'M': {
        const px = rel ? x + v[0] : v[0];
        const py = rel ? y + v[1] : v[1];
        result.push({ command: 'M', values: [px, py] });
        x = px;
        y = py;
        startX = px;
        startY = py;
        break;
      }
      case 'L': {
        const px = rel ? x + v[0] : v[0];
        const py = rel ? y + v[1] : v[1];
        result.push({ command: 'L', values: [px, py] });
        x = px;
        y = py;
        break;
      }
      case 'H': {
        const px = rel ? x + v[0] : v[0];
        result.push({ command: 'L', values: [px, y] });
        x = px;
        break;
      }
      case 'V': {
        const py = rel ? y + v[0] : v[0];
        result.push({ command: 'L', values: [x, py] });
        y = py;
        break;
      }
      case 'C': {
        const x1 = rel ? x + v[0] : v[0];
        const y1 = rel ? y + v[1] : v[1];
        const x2 = rel ? x + v[2] : v[2];
        const y2 = rel ? y + v[3] : v[3];
        const px = rel ? x + v[4] : v[4];
        const py = rel ? y + v[5] : v[5];
        result.push({ command: 'C', values: [x1, y1, x2, y2, px, py] });
        prevControl = [x2, y2];
        x = px;
        y = py;
        break;
      }
      case 'S': {
        const x2 = rel ? x + v[0] : v[0];
        const y2 = rel ? y + v[1] : v[1];
        const px = rel ? x + v[2] : v[2];
        const py = rel ? y + v[3] : v[3];
        const [x1, y1] =
          prevCommand === 'C' || prevCommand === 'S'
            ? [2 * x - prevControl[0], 2 * y - prevControl[1]]
            : [x, y];
        result.push({ command: 'C', values: [x1, y1, x2, y2, px, py] });
        prevControl = [x2, y2];
        x = px;
        y = py;
        break;
      }
      case 'Q': {
        const x1 = rel ? x + v[0] : v[0];
        const y1 = rel ? y + v[1] : v[1];
        const px = rel ? x + v[2] : v[2];
        const py = rel ? y + v[3] : v[3];
        result.push({ command: 'Q', values: [x1, y1, px, py] });
        prevControl = [x1, y1];
        x = px;
        y = py;
        break;
      }
      case 'T': {
        const px = rel ? x + v[0] : v[0];
        const py = rel ? y + v[1] : v[1];
        const [qx, qy] =
          prevCommand === 'Q' || prevCommand === 'T'
            ? [2 * x - prevControl[0], 2 * y - prevControl[1]]
            : [x, y];
        result.push({ command: 'Q', values: [qx, qy, px, py] });
        prevControl = [qx, qy];
        x = px;
        y = py;
        break;
      }
      case 'A': {
        const px = rel ? x + v[5] : v[5];
        const py = rel ? y + v[6] : v[6];
        result.push({ command: 'A', values: [v[0], v[1], v[2], v[3], v[4], px, py] });
        x = px;
        y = py;
        break;
      }
      case 'Z': {
        result.push({ command: 'Z', values: [] });
        x = startX;
        y = startY;
        break;
      }
      default:
        throw new Error(`toAbsolute: unsupported command "${seg.command}".`);
    }
    prevCommand = upper;
  }

  return result;
}

/**
 * Applies `m` to every coordinate in `segments`. Expects segments already
 * absolutized (as from {@link toAbsolute}) — only `M`, `L`, `C`, `Q`, `A`
 * and `Z` are handled.
 *
 * Every `A` is converted to one or more `C`s first: an elliptical arc
 * under a non-uniform scale or a skew isn't an ellipse any more, and
 * cubics are closed under affine transforms, so converting before
 * transforming is exact regardless of what `m` does. See {@link arcToCubics}.
 */
export function transformSegments(segments: PathSegment[], m: Matrix): PathSegment[] {
  const result: PathSegment[] = [];
  let x = 0;
  let y = 0;
  let startX = 0;
  let startY = 0;

  for (const seg of segments) {
    switch (seg.command) {
      case 'M':
      case 'L': {
        const [px, py] = apply(m, seg.values[0], seg.values[1]);
        result.push({ command: seg.command, values: [px, py] });
        x = seg.values[0];
        y = seg.values[1];
        if (seg.command === 'M') {
          startX = x;
          startY = y;
        }
        break;
      }
      case 'C': {
        const values: number[] = [];
        for (let k = 0; k < 6; k += 2) {
          values.push(...apply(m, seg.values[k], seg.values[k + 1]));
        }
        result.push({ command: 'C', values });
        x = seg.values[4];
        y = seg.values[5];
        break;
      }
      case 'Q': {
        const values: number[] = [];
        for (let k = 0; k < 4; k += 2) {
          values.push(...apply(m, seg.values[k], seg.values[k + 1]));
        }
        result.push({ command: 'Q', values });
        x = seg.values[2];
        y = seg.values[3];
        break;
      }
      case 'A': {
        const [rx, ry, rotation, largeArc, sweep, ex, ey] = seg.values;
        const cubics = arcToCubics(x, y, rx, ry, rotation, largeArc, sweep, ex, ey);
        for (const cubic of cubics) {
          const values: number[] = [];
          for (let k = 0; k < 6; k += 2) {
            values.push(...apply(m, cubic[k], cubic[k + 1]));
          }
          result.push({ command: 'C', values });
        }
        x = ex;
        y = ey;
        break;
      }
      case 'Z':
        result.push({ command: 'Z', values: [] });
        // Restore the current point to the subpath start, exactly as
        // `toAbsolute` does — otherwise an `A` right after a `Z` would be
        // converted from the wrong start point (see `arcToCubics`'s x0/y0).
        x = startX;
        y = startY;
        break;
      default:
        throw new Error(
          `transformSegments: unsupported command "${seg.command}" (expected absolutized input).`,
        );
    }
  }

  return result;
}

/**
 * Converts one SVG elliptical arc to a chain of cubic Bézier segments
 * (endpoint-to-center parameterization, split into pieces of at most 90°),
 * each returned as `[c1x, c1y, c2x, c2y, x, y]`.
 *
 * A degenerate arc (zero radius, or a start point equal to the end point)
 * has no well-defined ellipse; SVG renders that case as a straight line,
 * so this does too.
 */
export function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  xAxisRotationDeg: number,
  largeArcFlag: number,
  sweepFlag: number,
  x: number,
  y: number,
): number[][] {
  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);

  if (rx === 0 || ry === 0 || (x0 === x && y0 === y)) {
    return [
      [
        x0 + (x - x0) / 3,
        y0 + (y - y0) / 3,
        x0 + (2 * (x - x0)) / 3,
        y0 + (2 * (y - y0)) / 3,
        x,
        y,
      ],
    ];
  }

  const phi = (xAxisRotationDeg * Math.PI) / 180;
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // Step 1: compute (x1', y1') — the endpoints in the ellipse's own frame.
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // Scale up radii that are too small to reach between the endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // Step 2 & 3: compute the ellipse center (cx, cy).
  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const sign = largeArcFlag !== sweepFlag ? 1 : -1;
  const num = Math.max(rxSq * rySq - rxSq * y1pSq - rySq * x1pSq, 0);
  const co = sign * Math.sqrt(num / (rxSq * y1pSq + rySq * x1pSq));
  const cxp = (co * (rx * y1p)) / ry;
  const cyp = (co * -(ry * x1p)) / rx;
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  // Step 4: compute the start angle and the angular sweep.
  const vectorAngle = (ux: number, uy: number, vx: number, vy: number) => {
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    let angle = Math.acos(Math.min(1, Math.max(-1, dot / len)));
    if (ux * vy - uy * vx < 0) angle = -angle;
    return angle;
  };

  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = vectorAngle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweepFlag && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweepFlag && dTheta < 0) dTheta += 2 * Math.PI;

  // Step 5: split into <=90deg segments and build one cubic per segment,
  // using the standard 4/3*tan(delta/4) control-point construction.
  const segmentCount = Math.ceil(Math.abs(dTheta) / (Math.PI / 2));
  const delta = dTheta / segmentCount;
  const t = (4 / 3) * Math.tan(delta / 4);

  const pointOnEllipse = (theta: number): [number, number] => [
    cx + rx * Math.cos(theta) * cosPhi - ry * Math.sin(theta) * sinPhi,
    cy + rx * Math.cos(theta) * sinPhi + ry * Math.sin(theta) * cosPhi,
  ];
  const tangentAtEllipse = (theta: number): [number, number] => [
    -rx * Math.sin(theta) * cosPhi - ry * Math.cos(theta) * sinPhi,
    -rx * Math.sin(theta) * sinPhi + ry * Math.cos(theta) * cosPhi,
  ];

  const cubics: number[][] = [];
  let theta = theta1;
  for (let i = 0; i < segmentCount; i++) {
    const nextTheta = theta + delta;
    const [p1x, p1y] = pointOnEllipse(theta);
    const [p2x, p2y] = pointOnEllipse(nextTheta);
    const [d1x, d1y] = tangentAtEllipse(theta);
    const [d2x, d2y] = tangentAtEllipse(nextTheta);

    cubics.push([p1x + t * d1x, p1y + t * d1y, p2x - t * d2x, p2y - t * d2y, p2x, p2y]);
    theta = nextTheta;
  }

  // Snap the last point to the exact endpoint — the trig above accumulates
  // floating-point drift over multiple segments.
  const last = cubics[cubics.length - 1];
  last[4] = x;
  last[5] = y;

  return cubics;
}

function formatNumber(n: number): string {
  const rounded = Math.round(n * 1e6) / 1e6;
  return Object.is(rounded, -0) ? '0' : String(rounded);
}

/** Serializes segments back to a `d` string: command letter, space, space-joined arguments. */
export function serializePath(segments: PathSegment[]): string {
  return segments
    .map((seg) =>
      seg.values.length ? `${seg.command} ${seg.values.map(formatNumber).join(' ')}` : seg.command,
    )
    .join(' ');
}
