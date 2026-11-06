import { defineConfig } from 'vite';

export default defineConfig({
  // relative base so the build works on any static host / sub-path (e.g. GitHub Pages)
  base: './',
  build: { target: 'es2022', chunkSizeWarningLimit: 1200 },
});
