import { defineConfig } from 'vite';

export default defineConfig({
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
    // The default esbuild minifier restructures statements (e.g. joining
    // adjacent expressions with the comma operator) inside `'worklet'`
    // functions in `react-native/{Dithered,playback}.ts`. The Worklets
    // Babel plugin runs later, in a *consuming* app's own Metro/babel
    // pipeline, and its static analysis of a worklet's body (to find and
    // capture closed-over variables — here, one worklet calling another,
    // e.g. the frame callback invoking `applyPhase`) does not tolerate
    // that reshaping: a captured worklet reference is silently left
    // unprocessed and reaches the UI thread as a plain "remote" JS
    // function, throwing "Tried to synchronously call a Remote Function"
    // the first time it's invoked. Minification must stay off so the
    // shipped code keeps one statement per line, matching what the
    // plugin expects to see.
    minify: false,
  },
});
