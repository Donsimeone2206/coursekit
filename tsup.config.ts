import { defineConfig } from 'tsup';

export default defineConfig({
  entry: {
    'server/index': 'src/server/index.ts',
    'cli/index': 'src/cli/index.ts',
  },
  format: ['esm'],
  platform: 'node',
  target: 'node22',
  outDir: 'dist',
  // Each entry is self-contained so both live one level below dist/ and can find dist/web.
  splitting: false,
  sourcemap: true,
  // dist/web is produced by Vite first, so never wipe the folder here.
  clean: false,
  dts: false,
  // Keep `node:` prefixes: `node:sqlite` only exists under its prefixed name.
  removeNodeProtocol: false,
  onSuccess: 'tsc -p tsconfig.build.json',
});
