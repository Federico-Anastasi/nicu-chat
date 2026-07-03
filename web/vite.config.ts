import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  plugins: [react()],

  // Exclude onnxruntime-web from pre-bundling so its WASM imports work correctly
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },

  // NIENTE COOP/COEP: con numThreads=1 il WASM gira single-thread senza SAB →
  // funziona su iOS Safari (che deve usare WASM). Con COOP/COEP ORT prova il
  // multi-thread+SAB e su iOS l'init fallisce. WebGPU (desktop) non li richiede.
  // `proxy` inoltra /api/* al backend di logging locale (:8100), come Caddy in prod.
  server: {
    proxy: {
      '/api': 'http://localhost:8100',
    },
  },

  preview: {
    proxy: {
      '/api': 'http://localhost:8100',
    },
  },

  build: {
    // Keep WASM assets from being inlined
    assetsInlineLimit: 0,
    rollupOptions: {
      output: {
        // Don't chunk ort - it has dynamic WASM loading
        manualChunks: undefined,
      },
    },
  },
})
