const path = require('node:path');
const { getDefaultConfig } = require('expo/metro-config');

const projectRoot = __dirname;
const workspaceRoot = path.resolve(projectRoot, '../..');

const config = getDefaultConfig(projectRoot);

// Metro has to see the whole workspace: `dithered` is a symlinked
// workspace package, and pnpm keeps its real files (and every shared
// dependency) outside this project's own node_modules.
//
// Note: do NOT set `disableHierarchicalLookup`. The usual monorepo recipe
// assumes a hoisted (npm/yarn) tree, but pnpm gives every package its own
// nested node_modules under `.pnpm`, and walking up to those directories is
// the only way a dependency finds its own dependencies.
config.watchFolders = [workspaceRoot];
config.resolver.nodeModulesPaths = [
  path.resolve(projectRoot, 'node_modules'),
  path.resolve(workspaceRoot, 'node_modules'),
];

// `dithered` only exposes `./react` and `./native` through its `exports`
// map, which Metro still ignores by default on this Expo version.
config.resolver.unstable_enablePackageExports = true;

module.exports = config;
