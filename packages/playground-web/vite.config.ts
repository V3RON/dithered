import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  base: '/dithered/',
  plugins: [react()],
  resolve: {
    alias: [
      // Point at the library's source rather than its build output, so
      // `pnpm dev` picks up edits without a rebuild step. Longest/most
      // specific first: alias matching is prefix-based.
      { find: 'dithered/react', replacement: path.resolve(__dirname, '../dithered/src/react.tsx') },
      { find: 'dithered', replacement: path.resolve(__dirname, '../dithered/src/index.ts') },
    ],
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
