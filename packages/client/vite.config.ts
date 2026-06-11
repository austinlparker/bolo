import { defineConfig } from 'vite';

// In dev, the Vite server proxies API + WebSocket traffic to `wrangler dev`.
export default defineConfig({
  server: {
    proxy: {
      '/api': 'http://localhost:8787',
      '/ws': { target: 'ws://localhost:8787', ws: true },
    },
  },
  build: {
    target: 'es2022',
  },
});
