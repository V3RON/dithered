import { defineConfig } from 'vite';

// Pin NODE_ENV for the whole vitest process rather than trusting vitest's own
// "defaults to test" behavior: an ambient `NODE_ENV=production` (common in
// Node base images / CI containers) otherwise leaks in from the shell and
// breaks three unrelated things at once — compose.ts's dev-warning tests
// (which construct a fresh module instance and read this at module load),
// React itself (which switches to its production build, and that build
// doesn't support `act(...)`, breaking every react.test.tsx test that
// renders), and Vite's own dev-server mode (which changes how it resolves
// Node builtins like `node:fs`/`node:path` for the jsdom test environment,
// breaking compose-entries.test.ts). `test.env` in the `test` block below
// only sets `process.env` inside the test workers — it runs too late to
// affect Vite's own mode, which is decided while this config module is
// loaded — so the assignment has to happen here, at the top of the file,
// before `defineConfig` runs.
process.env.NODE_ENV = 'test';

export default defineConfig({
  test: {
    environment: 'jsdom',
    globals: false,
    setupFiles: ['./src/test-setup.ts'],
    // Belt-and-braces: also pin it for the worker processes themselves, in
    // case a future change runs tests in a way that no longer shares the
    // main process's `process.env` (e.g. isolated workers with their own
    // environment).
    env: { NODE_ENV: 'test' },
  },
});
