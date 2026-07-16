import { fileURLToPath, URL } from 'node:url'
import react from '@vitejs/plugin-react'
import { defineConfig } from 'vite'

// The Worker (wrangler dev, :8787) is the single origin in production and the
// canonical target for full end-to-end/auth testing. This Vite dev server
// (:5173) is a convenience for fast SPA iteration with HMR and proxies API,
// webhook, and Slack paths through to the Worker.
const WORKER_ORIGIN = 'http://localhost:8787'

export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('./shared', import.meta.url)),
    },
  },
  build: {
    outDir: 'dist/client',
    emptyOutDir: true,
  },
  server: {
    port: 5173,
    proxy: {
      '/api': { target: WORKER_ORIGIN, changeOrigin: true },
      '/webhooks': { target: WORKER_ORIGIN, changeOrigin: true },
      '/slack': { target: WORKER_ORIGIN, changeOrigin: true },
    },
  },
})
