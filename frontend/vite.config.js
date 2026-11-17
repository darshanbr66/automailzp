import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The backend runs on 127.0.0.1:4000. The frontend calls it through this proxy,
// so the browser only ever talks to http://localhost:5173.
const backend = 'http://127.0.0.1:4000';

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    strictPort: true,
    host: 'localhost',
    proxy: {
      '/api': { target: backend, changeOrigin: false },
    },
  },
});
