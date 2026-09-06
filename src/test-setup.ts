// jsdom does not implement Path2D. Several tests only need a constructible
// stand-in — anything exercising it mocks isPointInPath and never inspects
// the path's contents.
if (typeof globalThis.Path2D === 'undefined') {
  (globalThis as { Path2D?: unknown }).Path2D = class {
    constructor(_d?: string) {}
  };
}
