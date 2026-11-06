import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works on any static host / sub-path (e.g. GitHub Pages)
  base: './',
  // unique per build: appended to model/texture URLs so browsers never pair new code with a stale cached model
  define: { __BUILD_ID__: JSON.stringify(Date.now().toString(36)) },
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
