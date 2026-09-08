import { afterEach } from 'vitest';

// A no-op under the node environment (`src/static.node.test.ts`), which
// has neither `document` nor `Path2D` to set up — and must not gain them
// as a side effect of this file, since that test's whole point is
// asserting they're absent.
if (typeof document !== 'undefined') {
  const { cleanup } = await import('@testing-library/react');
  await import('@testing-library/jest-dom/vitest');

  // `globals: false` in vitest.config.ts means Testing Library's own
  // auto-cleanup (which detects a global `afterEach`) never registers, so
  // unmount rendered trees between tests explicitly.
  afterEach(() => cleanup());

  // jsdom does not implement Path2D. Several tests only need a
  // constructible stand-in — anything exercising it mocks isPointInPath
  // and never inspects the path's contents.
  if (typeof globalThis.Path2D === 'undefined') {
    (globalThis as { Path2D?: unknown }).Path2D = class {
      constructor(_d?: string) {}
    };
  }
}
