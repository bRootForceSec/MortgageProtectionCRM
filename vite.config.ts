import fs from 'node:fs';
import path from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';

// The PDF viewer needs a few of pdf.js's own files to draw every kind of page: image decoders for
// scanned pages (JPEG 2000 and JBIG2, which otherwise show as a blank white page), color profiles,
// and fonts. They're served at /pdfjs/ (copied into the build, served from node_modules in development).
const PDFJS_DIRS = ['wasm', 'standard_fonts', 'cmaps', 'iccs'];
const pdfjsRoot = path.resolve('node_modules/pdfjs-dist');

function pdfjsFiles(): Plugin {
  let outDir = '';
  return {
    name: 'pdfjs-files',
    configResolved(c) {
      outDir = path.resolve(c.root, c.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use('/pdfjs', (req, res, next) => {
        const rel = decodeURIComponent((req.url ?? '').split('?')[0]!).replace(/^\/+/, '');
        const file = path.resolve(pdfjsRoot, rel);
        if (!PDFJS_DIRS.some((d) => file.startsWith(path.join(pdfjsRoot, d) + path.sep)) || !fs.existsSync(file)) return next();
        if (file.endsWith('.wasm')) res.setHeader('content-type', 'application/wasm');
        fs.createReadStream(file).pipe(res);
      });
    },
    closeBundle() {
      for (const d of PDFJS_DIRS) fs.cpSync(path.join(pdfjsRoot, d), path.join(outDir, 'pdfjs', d), { recursive: true });
    },
  };
}

// In development the UI runs on 5173 and proxies /api to the backend on 5170.
// Production serves the built UI from the backend itself (same origin, no proxy).
export default defineConfig({
  root: 'src/web',
  plugins: [react(), pdfjsFiles()],
  build: { outDir: '../../dist/web', emptyOutDir: true, sourcemap: false },
  server: { host: '127.0.0.1', port: 5173, proxy: { '/api': { target: 'http://127.0.0.1:5170', headers: { host: '127.0.0.1:5170', origin: 'http://127.0.0.1:5170' } } } },
});
