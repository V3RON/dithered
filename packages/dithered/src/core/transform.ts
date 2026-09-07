/**
 * 2x3 affine matrices for SVG `transform` attributes.
 *
 * Represented as `[a b c d e f]` in SVG's own convention:
 *
 * ```
 * x' = a*x + c*y + e
 * y' = b*x + d*y + f
 * ```
 *
 * Platform-free (no DOM types) so it can be shared by `shapeFromSvgLite`
 * and `dithered/native`.
 */
export interface Matrix {
  a: number;
  b: number;
  c: number;
  d: number;
  e: number;
  f: number;
}

export const IDENTITY: Matrix = { a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 };

/**
 * Composes `m1` and `m2` as `m1 x m2`: a point is transformed by `m2`
 * first, then `m1` — the same convention as SVG's own transform list, so
 * `multiply(parseTransform('translate(10,0) rotate(45)'))` applies the
 * rotation before the translation, matching a literal reading of
 * `T x R`.
 */
export function multiply(m1: Matrix, m2: Matrix): Matrix {
  return {
    a: m1.a * m2.a + m1.c * m2.b,
    b: m1.b * m2.a + m1.d * m2.b,
    c: m1.a * m2.c + m1.c * m2.d,
    d: m1.b * m2.c + m1.d * m2.d,
    e: m1.a * m2.e + m1.c * m2.f + m1.e,
    f: m1.b * m2.e + m1.d * m2.f + m1.f,
  };
}

/** Applies `m` to a point, returning the transformed coordinates. */
export function apply(m: Matrix, x: number, y: number): [number, number] {
  return [m.a * x + m.c * y + m.e, m.b * x + m.d * y + m.f];
}

/** Whether `m` is (exactly) the identity matrix — the fast path for baking. */
export function isIdentity(m: Matrix): boolean {
  return m.a === 1 && m.b === 0 && m.c === 0 && m.d === 1 && m.e === 0 && m.f === 0;
}

const FUNCTION_RE = /([a-zA-Z]+)\s*\(([^)]*)\)/g;

/**
 * Parses an SVG `transform` attribute value into one composed {@link Matrix}.
 *
 * Supports `translate`, `scale`, `rotate` (with or without a center),
 * `skewX`, `skewY` and `matrix`, composed left to right as SVG specifies
 * (see {@link multiply}). Throws on an unknown function name or a wrong
 * argument count rather than ignoring the offending term, which would
 * silently misplace the geometry it applies to.
 */
export function parseTransform(value: string): Matrix {
  const trimmed = value.trim();
  // `none` is a legal value of the transform presentation attribute (SVG 2
  // / CSS transforms) and browsers honor it as the identity, same as an
  // absent or blank attribute.
  if (!trimmed || trimmed === 'none') return IDENTITY;

  let matrix = IDENTITY;
  let cursor = 0;
  let matched = false;
  let match: RegExpExecArray | null;
  FUNCTION_RE.lastIndex = 0;
  while ((match = FUNCTION_RE.exec(trimmed))) {
    const between = trimmed.slice(cursor, match.index);
    if (!/^[\s,]*$/.test(between)) {
      throw new Error(`parseTransform: could not parse "${value}".`);
    }
    matrix = multiply(matrix, functionMatrix(match[1], match[2], value));
    cursor = FUNCTION_RE.lastIndex;
    matched = true;
  }
  const trailing = trimmed.slice(cursor);
  if (!matched || !/^[\s,]*$/.test(trailing)) {
    throw new Error(`parseTransform: could not parse "${value}".`);
  }
  return matrix;
}

function functionMatrix(rawName: string, rawArgs: string, original: string): Matrix {
  const name = rawName.toLowerCase();
  const args = parseNumberList(rawArgs, original);

  switch (name) {
    case 'translate': {
      requireArgCount(name, args, [1, 2], original);
      const [tx, ty = 0] = args;
      return { a: 1, b: 0, c: 0, d: 1, e: tx, f: ty };
    }
    case 'scale': {
      requireArgCount(name, args, [1, 2], original);
      const [sx, sy = sx] = args;
      return { a: sx, b: 0, c: 0, d: sy, e: 0, f: 0 };
    }
    case 'rotate': {
      requireArgCount(name, args, [1, 3], original);
      const [angle, cx = 0, cy = 0] = args;
      const rad = (angle * Math.PI) / 180;
      const cos = Math.cos(rad);
      const sin = Math.sin(rad);
      const rotation: Matrix = { a: cos, b: sin, c: -sin, d: cos, e: 0, f: 0 };
      if (args.length === 1) return rotation;
      // rotate(a cx cy) = translate(cx,cy) x rotate(a) x translate(-cx,-cy)
      return multiply(multiply({ a: 1, b: 0, c: 0, d: 1, e: cx, f: cy }, rotation), {
        a: 1,
        b: 0,
        c: 0,
        d: 1,
        e: -cx,
        f: -cy,
      });
    }
    case 'skewx': {
      requireArgCount(name, args, [1], original);
      return { a: 1, b: 0, c: Math.tan((args[0] * Math.PI) / 180), d: 1, e: 0, f: 0 };
    }
    case 'skewy': {
      requireArgCount(name, args, [1], original);
      return { a: 1, b: Math.tan((args[0] * Math.PI) / 180), c: 0, d: 1, e: 0, f: 0 };
    }
    case 'matrix': {
      requireArgCount(name, args, [6], original);
      const [a, b, c, d, e, f] = args;
      return { a, b, c, d, e, f };
    }
    default:
      throw new Error(`parseTransform: unknown function "${rawName}" in "${original}".`);
  }
}

function parseNumberList(text: string, original: string): number[] {
  const trimmed = text.trim();
  if (!trimmed) return [];
  const values = trimmed.split(/[\s,]+/).map(Number);
  if (values.some((n) => Number.isNaN(n))) {
    throw new Error(`parseTransform: could not parse "${original}".`);
  }
  return values;
}

function requireArgCount(name: string, args: number[], allowed: number[], original: string): void {
  if (!allowed.includes(args.length)) {
    throw new Error(
      `parseTransform: ${name}() takes ${allowed.join(' or ')} argument(s), got ${args.length}, in "${original}".`,
    );
  }
}
