import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 8192,
  },
  server: {
    port: 5173,
  },
});
