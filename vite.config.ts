import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

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

export default defineConfig({
  plugins: [react()],
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
