import { readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { defineConfig, type Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import { baseManifest } from './src/lib/basePath.ts';

// COOP/COEP would enable multi-threaded WASM inference (SharedArrayBuffer),
// but Google's pop-up sign-in requires `same-origin-allow-popups`, which does
// not count as cross-origin isolated in Chromium. The web build therefore keeps
// the pop-up working and runs inference single-threaded. The Tauri shell sets
// `same-origin` + `require-corp` in tauri.conf.json instead, because embedded
// Google sign-in is blocked there anyway.
const isolationHeaders = {
  'Cross-Origin-Opener-Policy': 'same-origin-allow-popups',
  'Cross-Origin-Embedder-Policy': 'require-corp',
};

/**
 * Public files are copied verbatim, so the manifest would still point at `/`
 * when the app is deployed under `/Coso/app/`. Rewrite it after the build.
 */
function baseManifestPlugin(): Plugin {
  let outDir = 'dist';
  let base = '/';

  return {
    name: 'coso:base-manifest',
    apply: 'build',
    configResolved(config) {
      outDir = resolve(config.root, config.build.outDir);
      base = config.base;
    },
    closeBundle() {
      if (base === '/') return;
      const file = resolve(outDir, 'manifest.webmanifest');
      try {
        const manifest = readFileSync(file, 'utf8');
        writeFileSync(file, baseManifest(manifest, base));
      } catch {
        // The manifest is optional; a missing one must not fail a release build.
      }
    },
  };
}

/**
 * The shared analytics client lives in `analytics/client.js` (outside `src/`)
 * because the download page publishes the same file. In development the web
 * app asks for `/analytics/client.js`; without this it would 404.
 */
function analyticsClientPlugin(): Plugin {
  const serve = (server: { middlewares: { use: Function } }) => {
    server.middlewares.use('/analytics/client.js', (_request: unknown, response: any, next: () => void) => {
      try {
        const code = readFileSync(new URL('./analytics/client.js', import.meta.url));
        response.setHeader('content-type', 'text/javascript; charset=utf-8');
        response.setHeader('cache-control', 'no-store');
        response.end(code);
      } catch {
        next();
      }
    });
  };

  return {
    name: 'coso:analytics-client',
    configureServer: serve,
    configurePreviewServer: serve,
  };
}

export default defineConfig({
  base: process.env.COSO_BASE || '/',
  plugins: [react(), baseManifestPlugin(), analyticsClientPlugin()],
  build: {
    outDir: 'dist',
    target: 'es2022',
    chunkSizeWarningLimit: 4000,
  },
  optimizeDeps: {
    exclude: ['@huggingface/transformers'],
  },
  worker: {
    format: 'es',
  },
  server: {
    port: 3000,
    strictPort: true,
    headers: isolationHeaders,
  },
  preview: {
    port: 4173,
    headers: isolationHeaders,
  },
});
