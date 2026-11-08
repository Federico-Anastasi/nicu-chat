import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import { createHash } from 'node:crypto'
import { readFileSync, writeFileSync } from 'node:fs'
import { join, resolve } from 'node:path'

const EXTRA_PRECACHE = ['/nicu-idle-128.webp', '/nicu-happy-128.webp', '/nicu-happy-256.webp', '/icon-192.png']

// Genera dist/sw.js dal modello sw.template.js: shell = ciò che index.html referenzia + le immagini sempre visibili.
// I chunk caricati a richiesta (motore locale), il wasm e il tokenizer entrano in cache quando servono, non alla prima visita.
function serviceWorker(): Plugin {
  let radice = ''
  let uscita = ''
  return {
    name: 'nicu-service-worker',
    apply: 'build',
    configResolved(config) {
      radice = config.root
      uscita = resolve(config.root, config.build.outDir)
    },
    closeBundle() {
      const html = readFileSync(join(uscita, 'index.html'), 'utf8')
      const riferiti = [...html.matchAll(/(?:src|href)="(\/[^"#?]+)"/g)].map(m => m[1])
      const precache = [...new Set(['/index.html', ...riferiti, ...EXTRA_PRECACHE])].sort()
      const modello = readFileSync(join(radice, 'sw.template.js'), 'utf8')
      const ort = JSON.parse(readFileSync(join(radice, 'node_modules/onnxruntime-web/package.json'), 'utf8')).version
      const build = createHash('sha1').update(html).update(modello).update(precache.join()).digest('hex').slice(0, 10)
      const sw = modello
        .replace(/__BUILD__/g, build)
        .replace(/__ORT__/g, ort)
        .replace('__PRECACHE__', JSON.stringify(precache))
      writeFileSync(join(uscita, 'sw.js'), sw)
    },
  }
}

// Il server di inferenza (:8300, o NICU_INFER) prima del backend di logging (:8100): vince la prima regola che combacia.
const proxyApi = {
  '/api/chat': process.env.NICU_INFER ?? 'http://localhost:8300',
  '/api': 'http://localhost:8100',
}

export default defineConfig({
  plugins: [react(), serviceWorker()],

  // Exclude onnxruntime-web from pre-bundling so its WASM imports work correctly
  optimizeDeps: {
    exclude: ['onnxruntime-web'],
  },

  // NIENTE COOP/COEP: con numThreads=1 il WASM gira single-thread senza SAB →
  // funziona su iOS Safari (che deve usare WASM). Con COOP/COEP ORT prova il
  // multi-thread+SAB e su iOS l'init fallisce. WebGPU (desktop) non li richiede.
  server: { proxy: proxyApi },
  preview: { proxy: proxyApi },

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
