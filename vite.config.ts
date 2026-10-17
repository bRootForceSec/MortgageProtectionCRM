import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// In development the UI runs on 5173 and proxies /api to the backend on 5170.
// Production serves the built UI from the backend itself (same origin, no proxy).
export default defineConfig({
  root: 'src/web',
  plugins: [react()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:5170', headers: { host: '127.0.0.1:5170', origin: 'http://127.0.0.1:5170' } } } },
});
