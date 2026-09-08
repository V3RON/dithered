module.exports = function (api) {
  api.cache(true);
  return {
    presets: ['babel-preset-expo'],
    // Worklets' plugin turns the `'worklet'` callbacks in
    // `dithered/react-native` into UI-thread functions. It must stay last.
    plugins: ['react-native-worklets/plugin'],
  };
};
