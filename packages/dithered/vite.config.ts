import { defineConfig } from 'vite';

export default defineConfig({
  // Keep `process.env.NODE_ENV` checks (see compose.ts's timeScale warning)
  // verbatim in the built output. Vite's library build otherwise inlines
  // the literal `"production"`, which would hard-disable the check for
  // every consumer including in development — defining the expression to
  // itself leaves the decision to the *consumer's* bundler.
  define: { 'process.env.NODE_ENV': 'process.env.NODE_ENV' },
  build: {
    lib: {
      entry: {
        index: 'src/index.ts',
        react: 'src/react.tsx',
        'react-native': 'src/react-native.ts',
      },
      formats: ['es'],
      fileName: (_format, entryName) => `${entryName}.js`,
    },
    rollupOptions: {
      // Keep react/react-dom out of the bundle: core users never pay for
      // them, and dithered/react users get whatever copy their app ships.
      // The React Native peers are external for the same reason, and
      // because they resolve to native modules the bundler must own.
      external: [
        'react',
        'react-dom',
        'react/jsx-runtime',
        'react-native',
        'react-native-reanimated',
        '@shopify/react-native-skia',
      ],
      output: {
        // A shared chunk (core/shape/noise/presets/shapes) is emitted once
        // and imported by the entries that need it, so dithered/react and
        // dithered/react-native do not inline second copies of the core.
        chunkFileNames: 'shared-[hash].js',
      },
    },
    sourcemap: true,
    emptyOutDir: false,
  },
});
