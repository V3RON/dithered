import { cleanup } from '@testing-library/react';
import { afterEach } from 'vitest';
import '@testing-library/jest-dom/vitest';

// `globals: false` in vitest.config.ts means Testing Library's own
// auto-cleanup (which detects a global `afterEach`) never registers, so
// unmount rendered trees between tests explicitly.
afterEach(() => cleanup());

// jsdom does not implement Path2D. Several tests only need a constructible
// stand-in — anything exercising it mocks isPointInPath and never inspects
// the path's contents.
if (typeof globalThis.Path2D === 'undefined') {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    constructor(_d?: string) {}
  };
}
