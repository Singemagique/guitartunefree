import { defineConfig } from 'vite';

export default defineConfig({
  base: './',
  build: {
    target: 'es2022',
    assetsInlineLimit: 8192,
  },
  server: {
    // The preview harness assigns a port via PORT; 5173 is the bare-`npm run dev` default.
    port: Number(process.env.PORT) || 5173,
  },
});
