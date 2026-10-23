import { defineConfig } from 'vite';

export default defineConfig({
  // Relative asset paths so the build works on GitHub Pages (and any subpath).
  base: './',
  server: {
    port: 5173,
    host: '127.0.0.1',
    open: false
  },
  build: {
    target: 'es2020',
    outDir: 'dist',
    sourcemap: true,
    chunkSizeWarningLimit: 1200
  }
});
