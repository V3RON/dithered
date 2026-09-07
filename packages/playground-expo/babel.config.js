module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Reanimated's plugin turns the `'worklet'` callbacks in
    // `dithered/native` into UI-thread functions. It must stay last.
    plugins: ['react-native-reanimated/plugin'],
  };
};
