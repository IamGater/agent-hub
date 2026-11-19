import { defineConfig } from 'vite';

export default defineConfig({
  root: import.meta.dirname,
  publicDir: 'public',
  oxc: { jsx: { runtime: 'automatic' } },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    // The polyfill would be an inline script, which the CSP forbids.
    modulePreload: { polyfill: false },
    sourcemap: false,
    // One bundle is fine here: xterm dominates the size and the app is useless without it.
    chunkSizeWarningLimit: 800,
  },
});
