/**
 * setup-wasm.mjs
 *
 * Copia i file .wasm di onnxruntime-web da node_modules a public/wasm/.
 * Viene eseguito automaticamente da `npm install` (postinstall).
 * Puoi eseguirlo manualmente con `npm run setup-wasm`.
 */

import { existsSync, mkdirSync, readdirSync, copyFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = join(__dirname, '..')

const SRC_DIR = join(ROOT, 'node_modules', 'onnxruntime-web', 'dist')
const DST_DIR = join(ROOT, 'public', 'wasm')

// Crea la directory di destinazione se non esiste
if (!existsSync(DST_DIR)) {
  mkdirSync(DST_DIR, { recursive: true })
}

// Copia tutti i file .wasm
if (!existsSync(SRC_DIR)) {
  console.warn('[setup-wasm] onnxruntime-web non trovato in node_modules — skip.')
  process.exit(0)
}

// ORT-web >=1.19 carica i .wasm tramite file glue .mjs CO-LOCATI: servono ENTRAMBI.
const wasmFiles = readdirSync(SRC_DIR).filter(f => f.endsWith('.wasm') || f.endsWith('.mjs'))

if (wasmFiles.length === 0) {
  console.warn('[setup-wasm] Nessun file .wasm/.mjs trovato in', SRC_DIR)
  process.exit(0)
}

for (const file of wasmFiles) {
  const src = join(SRC_DIR, file)
  const dst = join(DST_DIR, file)
  copyFileSync(src, dst)
  console.log(`[setup-wasm] Copiato: ${file}`)
}

console.log(`[setup-wasm] ${wasmFiles.length} file .wasm/.mjs copiati in public/wasm/`)
