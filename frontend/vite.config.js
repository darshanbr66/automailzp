import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// The frontend calls the backend through this proxy, so the browser only ever
// talks to the frontend's own address. Ports come from backend/.env (PORT for the
// backend, FRONTEND_URL for this dev server), so both always agree. That lets this
// version run next to another copy of the app (e.g. PORT=4100 and
// FRONTEND_URL=http://localhost:5174). Defaults: backend 4000, frontend 5173.
// Only these two values are read; nothing from backend/.env reaches the browser.
function backendSettings() {
  const file = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'backend', '.env');
  const values = {};
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const m = line.match(/^\s*(PORT|FRONTEND_URL)\s*=\s*(.*?)\s*$/);
      if (m) values[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  } catch {
    /* no backend/.env: defaults */
  }
  const backendPort = Number.parseInt(values.PORT, 10) || 4000;
  let frontendPort = 5173;
  try {
    frontendPort = Number.parseInt(new URL(values.FRONTEND_URL).port, 10) || 5173;
  } catch {
    /* default */
  }
  return { backendPort, frontendPort };
}

const { backendPort, frontendPort } = backendSettings();

export default defineConfig({
  plugins: [react()],
  server: {
    port: frontendPort,
    strictPort: true,
    host: 'localhost',
    proxy: {
      '/api': { target: `http://127.0.0.1:${backendPort}`, changeOrigin: false },
    },
  },
  preview: { port: frontendPort, strictPort: true },
});
