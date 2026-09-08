/**
 * SVG path-data geometry: a self-contained parser, flattener and arc
 * converter. Nothing here imports from the rest of the package — this
 * module is the foundation for the pure-JS hit tester
 * (`core/path-hit-test.ts`) and for static rendering (`core/static.ts`).
 * Keeping it import-free is deliberate: it is the one piece of geometry
 * code the library needs, and it should stay reusable on its own.
 *
 * Named `path-geometry.ts`, not `path.ts`, to avoid colliding with
 * `core/path.ts` (issue #10's SVG-segment parser/serializer, addressing
 * a different problem — building/transforming `d` strings from element
 * geometry — with an incompatible `PathSegment`-shaped model). The two
 * modules were developed independently and happen to overlap in name
 * and in a couple of function names (`parsePath`, `arcToCubics`); their
 * types (`PathCommand` vs `PathSegment`) are not interchangeable.
 */

export interface Point {
  x: number;
  y: number;
}

/**
 * Absolute, de-sugared path commands. `parsePath` normalizes away every
 * SVG path sugar — relative coordinates, `H`/`V`, `S`/`T` reflection,
 * arcs, implicit repeats — so consumers only ever see these five shapes.
 */
export type PathCommand =
  | { type: 'M'; x: number; y: number }
  | { type: 'L'; x: number; y: number }
  | { type: 'C'; x1: number; y1: number; x2: number; y2: number; x: number; y: number }
  | { type: 'Q'; x1: number; y1: number; x: number; y: number }
  | { type: 'Z' };

/**
 * Default flattening tolerance divisor: `tolerance = max(vb.width,
 * vb.height) / DEFAULT_TOLERANCE_DIVISOR`. See the ADR for the sizing
 * rationale (an error of about 1/60th of a cell at `cols = 64`).
 */
export const DEFAULT_TOLERANCE_DIVISOR = 4000;

const MAX_SUBDIVISION_DEPTH = 24;

// ---------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------

const COMMAND_LETTERS = /[MmLlHhVvCcSsQqTtAaZz]/;
const SEPARATOR = /[\s,]/;
const WSP = /\s/;
const NUMBER_RE = /^[+-]?(?:\d+\.\d*|\.\d+|\d+)(?:[eE][+-]?\d+)?/;

interface Cursor {
  readonly d: string;
  i: number;
}

function pathError(d: string, offset: number, message: string): Error {
  return new Error(`parsePath: ${message} (offset ${offset} in "${d}")`);
}

function skipSeparators(c: Cursor): void {
  while (c.i < c.d.length && SEPARATOR.test(c.d[c.i])) c.i++;
}

function skipWsp(c: Cursor): void {
  while (c.i < c.d.length && WSP.test(c.d[c.i])) c.i++;
}

function readNumber(c: Cursor): number {
  skipSeparators(c);
  const rest = c.d.slice(c.i);
  const match = NUMBER_RE.exec(rest);
  if (!match) throw pathError(c.d, c.i, 'expected a number');
  c.i += match[0].length;
  return parseFloat(match[0]);
}

/** Arc flags are a single `0`/`1` character, not a full number token. */
function readFlag(c: Cursor): boolean {
  skipSeparators(c);
  const ch = c.d[c.i];
  if (ch !== '0' && ch !== '1') throw pathError(c.d, c.i, 'expected a flag (0 or 1)');
  c.i++;
  return ch === '1';
}

/**
 * Parses SVG path `d` data into absolute, de-sugared {@link PathCommand}s.
 *
 * Relative commands are resolved against the running current point,
 * `H`/`V` become `L`, `S`/`T` resolve their reflected control point, `A`
 * is converted to cubics (via {@link arcToCubics}), and every implicit
 * repeat is expanded — including the moveto-repeat special case, where
 * `M 0 0 10 10` is a moveto followed by an implicit lineto. Malformed
 * input throws, naming the offending offset, rather than truncating
 * silently.
 */
export function parsePath(d: string): PathCommand[] {
  const c: Cursor = { d, i: 0 };
  const commands: PathCommand[] = [];

  let cur: Point = { x: 0, y: 0 };
  let subpathStart: Point = { x: 0, y: 0 };
  let active: string | null = null;
  /** Tracks reflection eligibility: the previous command's *family* ('C' for C/S, 'Q' for Q/T). */
  let curveFamily: 'C' | 'Q' | null = null;
  /** The control point to reflect for the next S/T, in absolute coordinates. */
  let lastControl: Point = { x: 0, y: 0 };

  skipSeparators(c);
  if (c.i >= c.d.length) throw pathError(d, 0, 'empty path');
  if (c.d[c.i] !== 'M' && c.d[c.i] !== 'm') {
    throw pathError(d, c.i, 'path data must begin with a moveto command');
  }

  while (true) {
    skipSeparators(c);
    if (c.i >= c.d.length) break;

    const ch = c.d[c.i];
    if (COMMAND_LETTERS.test(ch)) {
      active = ch;
      c.i++;
    } else if (active === null) {
      throw pathError(d, c.i, `unexpected character "${ch}"`);
    }
    // else: implicit repeat of `active`, operand(s) start right here.

    const activeCommand: string = active!;
    const isRelative: boolean = activeCommand === activeCommand.toLowerCase();
    const type = activeCommand.toUpperCase();
    const isFirstCommand = commands.length === 0;

    switch (type) {
      case 'M': {
        const x = readNumber(c);
        const y = readNumber(c);
        cur = isRelative && !isFirstCommand ? { x: cur.x + x, y: cur.y + y } : { x, y };
        subpathStart = cur;
        commands.push({ type: 'M', x: cur.x, y: cur.y });
        curveFamily = null;
        // Subsequent coordinate pairs without a new command letter are
        // implicit linetos (the moveto-repeat special case).
        active = isRelative ? 'l' : 'L';
        break;
      }
      case 'L': {
        const x = readNumber(c);
        const y = readNumber(c);
        cur = isRelative ? { x: cur.x + x, y: cur.y + y } : { x, y };
        commands.push({ type: 'L', x: cur.x, y: cur.y });
        curveFamily = null;
        break;
      }
      case 'H': {
        const x = readNumber(c);
        cur = { x: isRelative ? cur.x + x : x, y: cur.y };
        commands.push({ type: 'L', x: cur.x, y: cur.y });
        curveFamily = null;
        break;
      }
      case 'V': {
        const y = readNumber(c);
        cur = { x: cur.x, y: isRelative ? cur.y + y : y };
        commands.push({ type: 'L', x: cur.x, y: cur.y });
        curveFamily = null;
        break;
      }
      case 'C': {
        const x1 = readNumber(c);
        const y1 = readNumber(c);
        const x2 = readNumber(c);
        const y2 = readNumber(c);
        const x = readNumber(c);
        const y = readNumber(c);
        const ox = isRelative ? cur.x : 0;
        const oy = isRelative ? cur.y : 0;
        const c1 = { x: ox + x1, y: oy + y1 };
        const c2 = { x: ox + x2, y: oy + y2 };
        const end = { x: ox + x, y: oy + y };
        commands.push({ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
        cur = end;
        lastControl = c2;
        curveFamily = 'C';
        break;
      }
      case 'S': {
        const x2 = readNumber(c);
        const y2 = readNumber(c);
        const x = readNumber(c);
        const y = readNumber(c);
        const ox = isRelative ? cur.x : 0;
        const oy = isRelative ? cur.y : 0;
        const c1 =
          curveFamily === 'C'
            ? { x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y }
            : cur;
        const c2 = { x: ox + x2, y: oy + y2 };
        const end = { x: ox + x, y: oy + y };
        commands.push({ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
        cur = end;
        lastControl = c2;
        curveFamily = 'C';
        break;
      }
      case 'Q': {
        const x1 = readNumber(c);
        const y1 = readNumber(c);
        const x = readNumber(c);
        const y = readNumber(c);
        const ox = isRelative ? cur.x : 0;
        const oy = isRelative ? cur.y : 0;
        const c1 = { x: ox + x1, y: oy + y1 };
        const end = { x: ox + x, y: oy + y };
        commands.push({ type: 'Q', x1: c1.x, y1: c1.y, x: end.x, y: end.y });
        cur = end;
        lastControl = c1;
        curveFamily = 'Q';
        break;
      }
      case 'T': {
        const x = readNumber(c);
        const y = readNumber(c);
        const ox = isRelative ? cur.x : 0;
        const oy = isRelative ? cur.y : 0;
        const c1 =
          curveFamily === 'Q'
            ? { x: 2 * cur.x - lastControl.x, y: 2 * cur.y - lastControl.y }
            : cur;
        const end = { x: ox + x, y: oy + y };
        commands.push({ type: 'Q', x1: c1.x, y1: c1.y, x: end.x, y: end.y });
        cur = end;
        lastControl = c1;
        curveFamily = 'Q';
        break;
      }
      case 'A': {
        const rx = readNumber(c);
        const ry = readNumber(c);
        const xRot = readNumber(c);
        const largeArc = readFlag(c);
        const sweep = readFlag(c);
        const x = readNumber(c);
        const y = readNumber(c);
        const ox = isRelative ? cur.x : 0;
        const oy = isRelative ? cur.y : 0;
        const end = { x: ox + x, y: oy + y };
        commands.push(...arcToCubics(cur.x, cur.y, rx, ry, xRot, largeArc, sweep, end.x, end.y));
        cur = end;
        curveFamily = null;
        break;
      }
      case 'Z': {
        commands.push({ type: 'Z' });
        cur = subpathStart;
        curveFamily = null;
        active = null;
        break;
      }
      default:
        throw pathError(d, c.i, `unsupported command "${active}"`);
    }

    skipWsp(c);
  }

  return commands;
}

// ---------------------------------------------------------------------
// Flattening
// ---------------------------------------------------------------------

function mid(a: Point, b: Point): Point {
  return { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 };
}

/** Perpendicular distance from `p` to the (infinite) line through `a`/`b`. */
function distToLine(p: Point, a: Point, b: Point): number {
  const dx = b.x - a.x;
  const dy = b.y - a.y;
  const lenSq = dx * dx + dy * dy;
  if (lenSq < 1e-12) {
    const ex = p.x - a.x;
    const ey = p.y - a.y;
    return Math.sqrt(ex * ex + ey * ey);
  }
  const cross = Math.abs(dx * (a.y - p.y) - dy * (a.x - p.x));
  return cross / Math.sqrt(lenSq);
}

function flattenCubic(
  p0: Point,
  p1: Point,
  p2: Point,
  p3: Point,
  tolerance: number,
  depth: number,
  emit: (p: Point) => void,
): void {
  const flat = distToLine(p1, p0, p3) <= tolerance && distToLine(p2, p0, p3) <= tolerance;
  if (flat || depth >= MAX_SUBDIVISION_DEPTH) {
    emit(p3);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p23 = mid(p2, p3);
  const p012 = mid(p01, p12);
  const p123 = mid(p12, p23);
  const p0123 = mid(p012, p123);
  flattenCubic(p0, p01, p012, p0123, tolerance, depth + 1, emit);
  flattenCubic(p0123, p123, p23, p3, tolerance, depth + 1, emit);
}

function flattenQuadratic(
  p0: Point,
  p1: Point,
  p2: Point,
  tolerance: number,
  depth: number,
  emit: (p: Point) => void,
): void {
  const flat = distToLine(p1, p0, p2) <= tolerance;
  if (flat || depth >= MAX_SUBDIVISION_DEPTH) {
    emit(p2);
    return;
  }
  const p01 = mid(p0, p1);
  const p12 = mid(p1, p2);
  const p012 = mid(p01, p12);
  flattenQuadratic(p0, p01, p012, tolerance, depth + 1, emit);
  flattenQuadratic(p012, p12, p2, tolerance, depth + 1, emit);
}

/**
 * Converts absolute, de-sugared commands into polygons: one open point
 * list per subpath (the consumer treats the last point as implicitly
 * joined back to the first). Cubics and quadratics are adaptively
 * subdivided by the standard control-point-distance flatness test
 * against the chord, capped at 24 levels of recursion so a degenerate
 * curve cannot hang. Empty and single-point subpaths are dropped.
 */
export function flattenPath(commands: readonly PathCommand[], tolerance: number): Point[][] {
  const subpaths: Point[][] = [];
  let current: Point[] = [];
  let cur: Point = { x: 0, y: 0 };
  let start: Point = { x: 0, y: 0 };

  const emit = (p: Point) => {
    const last = current[current.length - 1];
    if (!last || last.x !== p.x || last.y !== p.y) current.push(p);
  };

  for (const cmd of commands) {
    switch (cmd.type) {
      case 'M':
        if (current.length > 1) subpaths.push(current);
        cur = { x: cmd.x, y: cmd.y };
        start = cur;
        current = [cur];
        break;
      case 'L':
        cur = { x: cmd.x, y: cmd.y };
        emit(cur);
        break;
      case 'C':
        flattenCubic(
          cur,
          { x: cmd.x1, y: cmd.y1 },
          { x: cmd.x2, y: cmd.y2 },
          { x: cmd.x, y: cmd.y },
          tolerance,
          0,
          emit,
        );
        cur = { x: cmd.x, y: cmd.y };
        break;
      case 'Q':
        flattenQuadratic(cur, { x: cmd.x1, y: cmd.y1 }, { x: cmd.x, y: cmd.y }, tolerance, 0, emit);
        cur = { x: cmd.x, y: cmd.y };
        break;
      case 'Z':
        // Close off the current subpath (a following drawing command
        // without an intervening `M` starts a *new* subpath at the
        // closed subpath's start point, per spec) rather than letting
        // later points bleed into this one's polygon.
        if (current.length > 1) subpaths.push(current);
        cur = start;
        current = [cur];
        break;
    }
  }
  if (current.length > 1) subpaths.push(current);

  return subpaths;
}

/** `flattenPath(parsePath(d), tolerance)`, for the common case of going straight from a `d` string to polygons. */
export function pathToPolygons(d: string, tolerance: number): Point[][] {
  return flattenPath(parsePath(d), tolerance);
}

// ---------------------------------------------------------------------
// Arcs
// ---------------------------------------------------------------------

/**
 * Converts one SVG elliptical arc (endpoint parameterization, as used by
 * the `A`/`a` path command) into one or more cubic {@link PathCommand}s,
 * each spanning at most 90 degrees. Follows SVG spec appendix F.6:
 * out-of-range radii are scaled up (F.6.6) before conversion.
 *
 * Degenerates to a single `L` when `rx` or `ry` is 0 (a zero-radius arc
 * is a straight line, per F.6.2), and to nothing when the endpoints
 * coincide.
 *
 * Exported separately from {@link parsePath} because issue #10 needs the
 * same conversion for `<ellipse>`/`<circle>` if it routes those through
 * path data.
 */
export function arcToCubics(
  x0: number,
  y0: number,
  rxIn: number,
  ryIn: number,
  xAxisRotationDeg: number,
  largeArc: boolean,
  sweep: boolean,
  x: number,
  y: number,
): PathCommand[] {
  if (x0 === x && y0 === y) return [];
  if (rxIn === 0 || ryIn === 0) return [{ type: 'L', x, y }];

  let rx = Math.abs(rxIn);
  let ry = Math.abs(ryIn);
  const phi = (((xAxisRotationDeg % 360) + 360) % 360) * (Math.PI / 180);
  const cosPhi = Math.cos(phi);
  const sinPhi = Math.sin(phi);

  // F.6.5.1 — compute (x1', y1'): the endpoints in the rotated,
  // translated coordinate system centred on the chord midpoint.
  const dx2 = (x0 - x) / 2;
  const dy2 = (y0 - y) / 2;
  const x1p = cosPhi * dx2 + sinPhi * dy2;
  const y1p = -sinPhi * dx2 + cosPhi * dy2;

  // F.6.6 — scale up radii that are too small to reach both endpoints.
  const lambda = (x1p * x1p) / (rx * rx) + (y1p * y1p) / (ry * ry);
  if (lambda > 1) {
    const s = Math.sqrt(lambda);
    rx *= s;
    ry *= s;
  }

  // F.6.5.2 — compute (cx', cy'): the ellipse centre in the same frame.
  const rxSq = rx * rx;
  const rySq = ry * ry;
  const x1pSq = x1p * x1p;
  const y1pSq = y1p * y1p;
  const num = Math.max(0, rxSq * rySq - rxSq * y1pSq - rySq * x1pSq);
  const denom = rxSq * y1pSq + rySq * x1pSq;
  const coef = (largeArc !== sweep ? 1 : -1) * Math.sqrt(denom === 0 ? 0 : num / denom);
  const cxp = (coef * (rx * y1p)) / ry;
  const cyp = (coef * (-ry * x1p)) / rx;

  // F.6.5.3 — transform the centre back to user space.
  const cx = cosPhi * cxp - sinPhi * cyp + (x0 + x) / 2;
  const cy = sinPhi * cxp + cosPhi * cyp + (y0 + y) / 2;

  // F.6.5.5 / F.6.5.6 — start angle and angular extent.
  const vectorAngle = (ux: number, uy: number, vx: number, vy: number): number => {
    const sign = ux * vy - uy * vx < 0 ? -1 : 1;
    const dot = ux * vx + uy * vy;
    const len = Math.sqrt((ux * ux + uy * uy) * (vx * vx + vy * vy));
    return sign * Math.acos(Math.min(1, Math.max(-1, dot / len)));
  };

  const theta1 = vectorAngle(1, 0, (x1p - cxp) / rx, (y1p - cyp) / ry);
  let dTheta = vectorAngle(
    (x1p - cxp) / rx,
    (y1p - cyp) / ry,
    (-x1p - cxp) / rx,
    (-y1p - cyp) / ry,
  );
  if (!sweep && dTheta > 0) dTheta -= 2 * Math.PI;
  if (sweep && dTheta < 0) dTheta += 2 * Math.PI;

  // Split into segments of at most 90 degrees, each approximated by one
  // cubic Bezier (the standard `4/3 * tan(delta/4)` control-point rule).
  const segmentCount = Math.max(1, Math.ceil(Math.abs(dTheta) / (Math.PI / 2)));
  const delta = dTheta / segmentCount;
  const t = (4 / 3) * Math.tan(delta / 4);

  const ellipsePoint = (theta: number): Point => {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return {
      x: cx + rx * cosPhi * cosT - ry * sinPhi * sinT,
      y: cy + rx * sinPhi * cosT + ry * cosPhi * sinT,
    };
  };
  const ellipseDeriv = (theta: number): Point => {
    const cosT = Math.cos(theta);
    const sinT = Math.sin(theta);
    return {
      x: -rx * cosPhi * sinT - ry * sinPhi * cosT,
      y: -rx * sinPhi * sinT + ry * cosPhi * cosT,
    };
  };

  const commands: PathCommand[] = [];
  let theta = theta1;
  for (let i = 0; i < segmentCount; i++) {
    const theta2 = theta + delta;
    const start = ellipsePoint(theta);
    const startDeriv = ellipseDeriv(theta);
    const end = ellipsePoint(theta2);
    const endDeriv = ellipseDeriv(theta2);
    const c1 = { x: start.x + t * startDeriv.x, y: start.y + t * startDeriv.y };
    const c2 = { x: end.x - t * endDeriv.x, y: end.y - t * endDeriv.y };
    commands.push({ type: 'C', x1: c1.x, y1: c1.y, x2: c2.x, y2: c2.y, x: end.x, y: end.y });
    theta = theta2;
  }

  // Snap the final endpoint to the requested (x, y) exactly, avoiding
  // floating-point drift from the trigonometric round trip.
  const last = commands[commands.length - 1] as Extract<PathCommand, { type: 'C' }>;
  last.x = x;
  last.y = y;

  return commands;
}
