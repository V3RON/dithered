import path from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

export default defineConfig({
  root: 'playground',
  plugins: [react()],
  resolve: {
    alias: [
      // Longest/most specific first: alias matching is prefix-based.
      { find: 'dithered/react', replacement: path.resolve(__dirname, 'src/react.tsx') },
      { find: 'dithered', replacement: path.resolve(__dirname, 'src/index.ts') },
    ],
  },
  build: {
    outDir: 'dist', // resolved relative to `root`, so playground/dist
    emptyOutDir: true,
  },
});
