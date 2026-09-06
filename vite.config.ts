import { defineConfig } from 'vite';

export default defineConfig({
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        react: 'src/react.tsx',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // Keep react/react-dom out of the bundle: core users never pay for
      // them, and dithered/react users get whatever copy their app ships.
      external: ['react', 'react-dom', 'react/jsx-runtime'],
      output: {
        // A shared chunk (renderer/shape/noise/presets/shapes) is emitted
        // once and imported by both entries, so dithered/react does not
        // inline a second copy of the core.
        chunkFileNames: 'shared-[hash].js',
      },
    },
    sourcemap: true,
    emptyOutDir: false,
  },
});
