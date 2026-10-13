import react from '@vitejs/plugin-react';
import { defineConfig } from 'vite';

// The API and WebSocket live on the backend; in development Vite proxies them so the browser sees one origin.
const API = process.env.PI_API ?? 'http://localhost:3101';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    proxy: { '/api': API, '/healthz': API, '/ws': { target: API.replace(/^http/, 'ws'), ws: true } },
  },
  build: { outDir: 'dist', sourcemap: true },
  test: {
    environment: 'jsdom',
    globals: true,
    setupFiles: ['./src/test/setup.js'],
    css: false,
    testTimeout: 10000,
  },
});
