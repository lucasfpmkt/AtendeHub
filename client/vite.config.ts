import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Faz proxy do frontend (5173) para a API (3001), inclusive o websocket
// do socket.io. Assim não há CORS no desenvolvimento.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: {
      '/api': { target: 'http://localhost:3001', changeOrigin: true },
      '/socket.io': { target: 'http://localhost:3001', ws: true },
    },
  },
});
