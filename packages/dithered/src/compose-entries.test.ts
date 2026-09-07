import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as compose from './compose';
import * as root from './index';

// PRD acceptance criterion: "Helpers exported from the root entry and typed
// against Brightness." `compose.test.ts` only imports from `./compose`
// directly, so it never notices if a re-export line in `./index` or
// `./native` is dropped — `pnpm test` and `pnpm typecheck` would stay green
// even if that happened. This file closes that gap.
const COMPOSE_RUNTIME_NAMES = [
  'compose',
  'blend',
  'mask',
  'timeScale',
  'reverse',
  'offset',
  'invert',
  'clamp',
] as const;

describe('compose is re-exported from the root entry (./index)', () => {
  it('exposes all eight compose names, as the same references as ./compose', () => {
    for (const name of COMPOSE_RUNTIME_NAMES) {
      expect(root).toHaveProperty(name);
      expect((root as Record<string, unknown>)[name]).toBe(
        (compose as unknown as Record<string, unknown>)[name],
      );
    }
  });
});

// `./native` re-exports `compose.ts`'s runtime names verbatim (it has no
// runtime imports of its own from `compose.ts`), but it also imports
// `react-native` and friends for its renderer pieces, and those don't
// resolve under vitest's jsdom environment: `import('./native')` here throws
// `Failed to resolve import "./Libraries/Image/Image" from ".../react-native/index.js"`
// (confirmed by actually attempting the dynamic import while writing this
// test) — a genuine tooling limit, not something to route around by mocking
// `react-native` and hoping the mock stays representative. So this asserts
// on `native.ts`'s source text instead of importing it, per the source's own
// note that it re-exports the "seven helpers plus the compose namespace" —
// still a real check: it fails if any of the eight names is dropped or
// misspelled in the re-export line, which is the regression this exists to
// catch, and it fails loudly (not silently skips) if that line's shape ever
// changes enough that this string match stops being meaningful.
describe('compose is re-exported from the native entry (./native)', () => {
  // vitest runs with cwd at the package root (packages/dithered), so this
  // is stable regardless of how the test file itself was resolved.
  const nativeSource = readFileSync(join(process.cwd(), 'src', 'native.ts'), 'utf8');

  // Matched against the whole file, not line-by-line: prettier wraps an
  // `export { ... } from '...'` across multiple lines once it exceeds
  // `printWidth` (100 here), and this statement is already 91 characters on
  // one line — one more helper (the PRD names `compose.transform` as the
  // next one) pushes it over and prettier reformats it to
  //   export {
  //     compose,
  //     blend,
  //     ...
  //   } from './compose';
  // A line-based `line.startsWith('export {') && line.includes("from
  // './compose'")` search would then find no single line satisfying both
  // halves and silently produce `undefined` (loudly failing both tests
  // below, but for the wrong reason — a spurious failure, not a real
  // regression). Matching the whole source, with the capture allowed to span
  // newlines, keeps this working whether the statement is on one line or
  // wrapped across many.
  //
  // `export\s*\{` (not `export\s+type\s*\{`) is what excludes the type-only
  // `export type { MixAmount, CellPredicate } from './compose';` line right
  // above it — only the runtime re-export is under test here. The capture
  // excludes `;` so a lazy match starting at some *other*, earlier
  // `export { ... } from '...';` statement can't skip past its own
  // terminating semicolon and accidentally swallow everything up to the
  // eventual `'./compose'` (including the type-only line's closing brace) —
  // every export statement in this file ends in `;` and none of the
  // identifier lists contain one, so `;` is a safe statement boundary.
  const composeExportMatch = nativeSource.match(/export\s*\{([^;]*?)\}\s*from\s*'\.\/compose';/);

  // Match only the text *inside* the braces, not the whole statement: the
  // statement also ends in `from './compose';`, and `\bcompose\b` matches
  // that module specifier regardless of whether `compose` itself is
  // actually re-exported — the exact gap this test exists to close.
  // Verified by removing `compose` from native.ts's re-export list: against
  // a whole-statement match this test still passed (168 tests green);
  // against the braces-only match below it fails, as it should.
  const exportedNames = composeExportMatch?.[1] ?? '';

  it("has a `export { ... } from './compose'` statement", () => {
    expect(composeExportMatch).not.toBeNull();
  });

  it('that line names all eight compose runtime exports', () => {
    for (const name of COMPOSE_RUNTIME_NAMES) {
      // Word-boundary match so `mask` doesn't accidentally match inside a
      // longer identifier.
      expect(exportedNames).toMatch(new RegExp(`\\b${name}\\b`));
    }
  });
});
