// @vitest-environment node
//
// esbuild refuses to run under jsdom: its startup check
// (`new TextEncoder().encode("") instanceof Uint8Array`) fails because
// jsdom's `TextEncoder` produces `Uint8Array` instances from a different
// realm than the one esbuild's own `Uint8Array` check compares against. This
// file needs no DOM, only `node:vm`, so it opts back into the plain Node
// environment rather than fighting jsdom for something it doesn't need.
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import vm from 'node:vm';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { transformWithEsbuild } from 'vite';
import type { Brightness } from './core';

// compose.ts's `devWarningsEnabled` guard (see the block of comments right
// above it) has been rejected twice in review, in two different broken
// shapes, and both times the entire suite — 170/170, including every other
// test in this file — stayed green: `pnpm typecheck`, `pnpm build`, and even
// the ADR's own `dist/` grep don't distinguish them from the real
// implementation either, because all three forms fold to the same thing once
// a bundler substitutes the `process.env.NODE_ENV` token. Nothing in the
// existing suite constructs the module in an environment where `process` is
// genuinely absent *and* the substitution has genuinely happened — the two
// conditions that only arise together after a browser app has been through a
// bundler. This file constructs exactly that environment.
//
// This does NOT use `pnpm build`'s output — `dist/` may not exist on a clean
// checkout — it builds a throwaway CJS chunk from `compose.ts`'s *source*
// with `vite`'s bundled esbuild (a direct devDependency already used by
// `vite build`), optionally pre-substituting the `process.env.NODE_ENV`
// token the way a consumer's bundler would, then runs that chunk in a fresh
// `node:vm` context that has no `process` global at all — simulating an
// unbundled `<script type="module">` consumer, or (for the substituted
// cases) a bundled browser app after tree-shaking/minification has already
// resolved the token and left no `process` reference behind.
//
// Verified by deliberately reintroducing each of the two previously-rejected
// forms in place of the real guard and rerunning this file:
//
// - `const devWarningsEnabled = typeof process !== 'undefined' &&
//   process.env.NODE_ENV !== 'production';` (the round-2 regression, dead in
//   every browser bundler): passed the "does not throw" case, but FAILED
//   "warns after a bundler substitutes ... 'development'" — with `process`
//   substituted away, `typeof process !== 'undefined'` is `false` at
//   runtime, so the guard never opens and `timeScale` never warns, in either
//   the "development" or "production" substituted case.
// - `const devWarningsEnabled = process.env.NODE_ENV !== 'production';` (no
//   `try`/`catch`): FAILED "does not throw with no substitution at all" —
//   with no bundler define applied and no `process` global, the bare
//   property read throws a `ReferenceError` while the module's top-level
//   code is still running, so the whole module fails to load.
//
// Both rejected forms pass `pnpm typecheck`/`pnpm build`/every other test in
// this suite; this is the only coverage for the guard's actual runtime
// behavior in the environment the warning exists for.

const composeSource = readFileSync(join(process.cwd(), 'src', 'compose.ts'), 'utf8');

/**
 * Transforms `compose.ts`'s source to a CommonJS chunk (optionally
 * pre-substituting `process.env.NODE_ENV` the way a bundler's `define`
 * would) and evaluates it in a fresh `vm` context with no `process` global.
 * Returns the module's exports, or the error thrown while loading it.
 */
async function loadComposeInSandbox(
  substitutedNodeEnv?: 'development' | 'production',
): Promise<
  | { threw: false; exports: { timeScale: typeof import('./compose').timeScale } }
  | { threw: true; error: unknown }
> {
  const { code } = await transformWithEsbuild(composeSource, 'compose.ts', {
    loader: 'ts',
    format: 'cjs',
    ...(substitutedNodeEnv !== undefined
      ? { define: { 'process.env.NODE_ENV': JSON.stringify(substitutedNodeEnv) } }
      : {}),
  });

  const sandboxModule: { exports: unknown } = { exports: {} };
  // Deliberately no `process` on this sandbox: that's the condition under
  // test. `console` is provided so `console.warn` calls land somewhere
  // observable; standard globals (`Object`, `Math`, `Set`, `Number`, ...)
  // come from the V8 context itself and need no explicit binding.
  const context = vm.createContext({
    module: sandboxModule,
    exports: sandboxModule.exports,
    require: () => {
      throw new Error('unexpected require() call — compose.ts should have no runtime imports');
    },
    console,
  });

  try {
    new vm.Script(code, { filename: 'compose.sandbox.cjs' }).runInContext(context);
  } catch (error) {
    return { threw: true, error };
  }
  return {
    threw: false,
    exports: sandboxModule.exports as { timeScale: typeof import('./compose').timeScale },
  };
}

const stubSource: Brightness = () => 0.5;

function unwrap(result: Awaited<ReturnType<typeof loadComposeInSandbox>>) {
  if (result.threw) {
    // Not `new Error(msg, { cause })` — this package's lib target (ES2020)
    // predates the `ErrorOptions` overload, so `tsc` rejects the second
    // argument even though it runs fine under Node/vitest.
    throw new Error(`module load threw: ${String(result.error)}`);
  }
  return result.exports;
}

describe('compose.ts dev-warning guard in a process-less sandbox', () => {
  let warnSpy: ReturnType<typeof vi.spyOn>;

  afterEach(() => {
    warnSpy?.mockRestore();
  });

  it('does not throw with no bundler substitution and no process global (unbundled ESM in a browser)', async () => {
    const result = await loadComposeInSandbox();
    const composeExports = unwrap(result);
    // Also confirm the module is actually usable afterwards, not merely
    // "didn't throw while some later step silently no-ops".
    expect(() => composeExports.timeScale(stubSource, 1.5)).not.toThrow();
  });

  it('warns for a non-integer factor once a bundler has substituted the token with "development"', async () => {
    const composeExports = unwrap(await loadComposeInSandbox('development'));
    // The sandbox's `console` is the real global `console` (there's no
    // reason to fake it out — only `process` needs to be absent), so a
    // normal `vi.spyOn` on it observes `console.warn` calls made from
    // inside the vm context.
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    composeExports.timeScale(stubSource, 1.5);
    expect(warnSpy).toHaveBeenCalledTimes(1);
  });

  it('does not warn once a bundler has substituted the token with "production"', async () => {
    const composeExports = unwrap(await loadComposeInSandbox('production'));
    warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    composeExports.timeScale(stubSource, 1.5);
    expect(warnSpy).not.toHaveBeenCalled();
  });
});
