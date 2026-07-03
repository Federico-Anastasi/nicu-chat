/**
 * inference.mainthread.ts — ONNX inference + sampling per Nicu, eseguita sul
 * MAIN THREAD.
 *
 * Questo è il percorso ORIGINALE (pre-Web Worker): oggi è usato solo come
 * FALLBACK da `inference.ts` quando il Web Worker non si crea o non si
 * inizializza in tempo (vedi `WORKER_INIT_TIMEOUT_MS` in inference.ts).
 * Girare qui blocca il main thread durante la generazione (niente animazioni
 * CSS, niente token in streaming visibile) — accettabile solo come ripiego.
 *
 * Architettura: nanoGPT 9,5M parametri, block_size 512, vocab 12000.
 * Modello ONNX fp32: input `idx` int64 [batch, seq], output `logits` float32 [batch, seq, 12000].
 *
 * Sampling (da sample_synth.py):
 *   1. Repetition penalty: logit[t] /= rep_pen per ogni t già nella sequenza
 *   2. Temperature: logit /= temp
 *   3. Softmax → probabilità
 *   4. Top-p nucleus: tieni il prefisso di prob ordinate con cum_sum ≤ top_p, rinormalizza
 *   5. Multinomial sampling
 *   Stop: token id 0 (EOT) oppure max_new token generati.
 */

// WASM-only build di onnxruntime-web (niente WebGPU/JSEP). Motivo: su iOS WebGPU
// non c'è, e richiederlo per primo avvelenava il fallback WASM (initWasm()
// memoizzato come fallito → "no available backend found"). La build wasm-only
// lascia a ORT la scelta del binario a runtime: SIMD sui device moderni,
// NON-SIMD (ort-wasm.wasm) su iOS/iPadOS < 16.4 → Nicu gira anche sui vecchi.
//
// ⚠️ NON aggiornare onnxruntime-web / cambiare questo import senza rileggere
// web/README.md §"onnxruntime-web: versione bloccata".
import * as ort from 'onnxruntime-web/wasm'
import type { BPETokenizer } from './tokenizer'

// ---------------------------------------------------------------------------
// Configurazione dell'esecuzione ONNX
// ---------------------------------------------------------------------------

/** Chiave della Cache Storage dove persiste il modello scaricato. */
const CACHE_NAME = 'nicu-model-v1'

export interface LoadResult {
  session: ort.InferenceSession
  backend: 'wasm'
}

/**
 * Carica il modello ONNX (backend WASM, con selezione SIMD/non-SIMD a runtime).
 * Emette aggiornamenti di progresso via callback.
 */
export async function loadModel(
  modelUrl: string,
  onProgress: (pct: number, msg: string) => void
): Promise<LoadResult> {
  // Directory dei binari .wasm (copiati in public/wasm/ da setup-wasm). ORT vi
  // aggiunge il nome del file scelto in base alle capacità del device
  // (ort-wasm-simd.wasm se c'è SIMD, ort-wasm.wasm se no). nginx serve /wasm/
  // con Cache-Control:no-cache → niente binari stantii dopo un cambio versione.
  ort.env.wasm.wasmPaths = '/wasm/'
  // Single-thread: evita SharedArrayBuffer / cross-origin-isolation (gira ovunque, anche senza COOP/COEP)
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false

  // 1. Ottieni il modello: prima dalla Cache Storage persistente (così al
  //    reload NON si ri-scarica, neanche su mobile dove la cache HTTP sfratta
  //    i file grossi), altrimenti dalla rete salvandolo in cache.
  //    Chiave = modelUrl: il nome file contiene la versione (nicu-m-v9b) → un
  //    nuovo modello = nuova chiave = ri-scarica solo quello.
  onProgress(0, 'Scarico Nicu… (84 MB, una volta sola)')

  let modelBuffer: ArrayBuffer
  try {
    let resp: Response
    let fromCache = false
    try {
      const cache = await caches.open(CACHE_NAME)
      const hit = await cache.match(modelUrl)
      if (hit) {
        resp = hit
        fromCache = true
      } else {
        const net = await fetch(modelUrl)
        if (!net.ok) throw new Error(`HTTP ${net.status}`)
        // clona PRIMA di leggere: una copia in cache, una da streammare
        await cache.put(modelUrl, net.clone())
        resp = net
      }
    } catch {
      // Cache Storage non disponibile (o bloccata) → fetch diretto
      resp = await fetch(modelUrl)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    }

    if (fromCache) onProgress(10, 'Carico Nicu dalla cache… (già scaricato)')

    const contentLength = resp.headers.get('content-length')
    const total = contentLength ? parseInt(contentLength) : 84_000_000

    const reader = resp.body!.getReader()
    const chunks: Uint8Array[] = []
    let received = 0

    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      chunks.push(value)
      received += value.byteLength
      const pct = Math.min(90, Math.round((received / total) * 90))
      onProgress(pct, `Scarico Nicu… ${(received / 1_048_576).toFixed(1)} / ${(total / 1_048_576).toFixed(0)} MB`)
    }

    // Assembla in un unico ArrayBuffer
    const totalBytes = chunks.reduce((s, c) => s + c.byteLength, 0)
    const buf = new Uint8Array(totalBytes)
    let offset = 0
    for (const chunk of chunks) {
      buf.set(chunk, offset)
      offset += chunk.byteLength
    }
    modelBuffer = buf.buffer
  } catch (e) {
    throw new Error(`Impossibile scaricare il modello: ${e}`)
  }

  onProgress(92, 'Inizializzo il motore…')

  // Crea la sessione (backend WASM; ORT sceglie SIMD o non-SIMD da solo).
  let session: ort.InferenceSession
  try {
    session = await ort.InferenceSession.create(modelBuffer, {
      executionProviders: ['wasm'],
      graphOptimizationLevel: 'all',
    })
  } catch (e) {
    throw new Error(`Impossibile creare la sessione ONNX: ${e}`)
  }

  // Cleanup: rimuove dalla cache le versioni vecchie del modello (chiavi
  // diverse dal modelUrl corrente) — evita di accumulare più .onnx da ~84 MB
  // l'uno nella Cache Storage a ogni cambio di versione.
  try {
    const cache = await caches.open(CACHE_NAME)
    const keys = await cache.keys()
    const currentAbs = new URL(modelUrl, self.location.origin).toString()
    for (const req of keys) {
      if (req.url !== currentAbs) await cache.delete(req)
    }
  } catch {
    // Cache Storage non disponibile: nessun cleanup da fare
  }

  onProgress(100, 'Nicu è pronto!')
  return { session, backend: 'wasm' }
}

// ---------------------------------------------------------------------------
// Parametri di generazione
// ---------------------------------------------------------------------------

export interface GenerationParams {
  temperature: number  // default 1.0
  topP: number         // default 0.92
  repPenalty: number   // default 1.15
  maxNew: number       // default 200
}

export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 1.0,   // sweep: 1.0 = miglior colore senza sgrammaticare (0.8 più spento)
  topP: 0.92,
  repPenalty: 1.15,   // sweep: 1.15 = frasi più naturali (1.3 forza giri di parole strani)
  maxNew: 200,
}

// ---------------------------------------------------------------------------
// Sampling helpers
// ---------------------------------------------------------------------------

/** Softmax su array Float32Array (in-place sovrascrive values) */
function softmax(logits: Float32Array): Float32Array {
  let maxVal = -Infinity
  for (let i = 0; i < logits.length; i++) {
    if (logits[i] > maxVal) maxVal = logits[i]
  }
  let sum = 0
  const probs = new Float32Array(logits.length)
  for (let i = 0; i < logits.length; i++) {
    probs[i] = Math.exp(logits[i] - maxVal)
    sum += probs[i]
  }
  for (let i = 0; i < probs.length; i++) probs[i] /= sum
  return probs
}

/**
 * Top-p nucleus sampling.
 * Identico all'implementazione PyTorch di sample_synth.py:
 *   sort desc → cum_sum → mask (cum - p > top_p) → zero fuori nucleo → rinormalizza → multinomial
 */
function topPSample(probs: Float32Array, topP: number): number {
  const n = probs.length

  // Ordina indici per probabilità decrescente
  const indices = new Uint32Array(n)
  for (let i = 0; i < n; i++) indices[i] = i
  // Insertion sort è troppo lento su 12000 elementi; usiamo sort con comparatore
  const sortedIdx = Array.from(indices).sort((a, b) => probs[b] - probs[a])

  // Accumula probabilità e azzera ciò che supera top_p
  const filtered = new Float32Array(n) // probabilità filtrate (nella posizione dell'indice originale)
  let cumSum = 0
  let sum = 0
  for (let rank = 0; rank < sortedIdx.length; rank++) {
    const idx = sortedIdx[rank]
    const p = probs[idx]
    // mask: cum_sum - p > top_p → cum_sum PRIMA di aggiungere p > top_p
    if (cumSum > topP) {
      filtered[idx] = 0
    } else {
      filtered[idx] = p
      sum += p
    }
    cumSum += p
  }

  // Rinormalizza
  if (sum === 0) {
    // Fallback: usa solo il token più probabile
    filtered[sortedIdx[0]] = 1
    sum = 1
  }
  for (let i = 0; i < n; i++) filtered[i] /= sum

  // Multinomial sampling
  const r = Math.random()
  let acc = 0
  for (const idx of sortedIdx) {
    if (filtered[idx] === 0) continue
    acc += filtered[idx]
    if (r < acc) return idx
  }
  return sortedIdx[0] // fallback al token più probabile
}

/** Greedy argmax (usato per il test di verità) */
function argmax(logits: Float32Array): number {
  let best = 0
  for (let i = 1; i < logits.length; i++) {
    if (logits[i] > logits[best]) best = i
  }
  return best
}

// ---------------------------------------------------------------------------
// Un singolo step autoregressivo
// ---------------------------------------------------------------------------

const BLOCK_SIZE = 512   // nicu-L-v9-sft: contesto 512
const VOCAB_SIZE = 6000  // nicu-L-v9-sft: BPE bpe_synth (6k)

/**
 * Esegue un passo di inferenza e restituisce i logits dell'ultimo token.
 * @param session - sessione ONNX
 * @param ids     - sequenza di token finora (comprensiva del prompt)
 * @returns Float32Array di dimensione VOCAB_SIZE con i logits raw
 */
async function runStep(
  session: ort.InferenceSession,
  ids: number[]
): Promise<Float32Array> {
  // Tronca al block_size (massimo contesto del modello)
  const slice = ids.length > BLOCK_SIZE ? ids.slice(ids.length - BLOCK_SIZE) : ids
  const seqLen = slice.length

  // Crea tensore int64 [1, seqLen]
  const inputData = new BigInt64Array(seqLen)
  for (let i = 0; i < seqLen; i++) inputData[i] = BigInt(slice[i])
  const inputTensor = new ort.Tensor('int64', inputData, [1, seqLen])

  // Inferenza
  const outputs = await session.run({ idx: inputTensor })
  const logitsAll = outputs['logits'].data as Float32Array
  // Shape: [1, seqLen, VOCAB_SIZE] → prendi l'ultimo passo
  const offset = (seqLen - 1) * VOCAB_SIZE
  return logitsAll.slice(offset, offset + VOCAB_SIZE)
}

// ---------------------------------------------------------------------------
// Generazione autoregressiva con streaming
// ---------------------------------------------------------------------------

/**
 * Genera la risposta di Nicu in modalità streaming.
 * Chiama `onToken` ad ogni token generato (decodifica parziale).
 * @returns la stringa completa generata
 */
export interface HistoryTurn { user: string; nicu: string }

export async function generate(
  session: ort.InferenceSession,
  tokenizer: BPETokenizer,
  userMsg: string,
  params: GenerationParams,
  onToken: (partial: string) => void,
  signal?: AbortSignal,
  history: HistoryTurn[] = []
): Promise<string> {
  // Memoria: se `history` non è vuota, impacchetta i turni precedenti (Utente/Nicu
  // alternati) nel prompt, così il modello — addestrato su dialoghi multi-turno —
  // può richiamare i dettagli detti prima. Vuota = stateless (solo msg corrente).
  // runStep tronca comunque agli ultimi BLOCK_SIZE token (tiene i turni più recenti).
  let prompt = ''
  for (const t of history) prompt += `Utente: ${t.user}\nNicu: ${t.nicu}\n`
  prompt += `Utente: ${userMsg}\nNicu:`
  const promptIds = tokenizer.encode(prompt)
  const eotId = tokenizer.eotTokenId

  // Repetition penalty SOLO su turno corrente + generati, MAI sulla storia
  // (identico al worker): penalizzare tutto il prompt garble le risposte
  // quando la memoria è attiva (bug osservato nei log del 2026-07-02).
  const penalized = new Set(tokenizer.encode(`Utente: ${userMsg}\nNicu:`))

  const allIds = [...promptIds]
  const generatedIds: number[] = []

  for (let step = 0; step < params.maxNew; step++) {
    if (signal?.aborted) break

    // Ottieni logits raw per l'ultimo token
    const logits = await runStep(session, allIds)

    // 1. Repetition penalty sui soli token penalizzabili
    for (const t of penalized) {
      logits[t] /= params.repPenalty
    }

    // 2. Temperature
    for (let i = 0; i < logits.length; i++) logits[i] /= params.temperature

    // 3. Softmax
    const probs = softmax(logits)

    // 4. Top-p + campionamento
    const nextId = topPSample(probs, params.topP)

    // Stop su EOT
    if (nextId === eotId) break

    allIds.push(nextId)
    generatedIds.push(nextId)
    penalized.add(nextId)

    // Streaming: decodifica parziale e notifica
    const partial = tokenizer.decode(generatedIds).trimStart()

    // Stop-sequence: se il modello inizia un nuovo turno ("\nUtente:" o un
    // secondo "\nNicu:") tronca lì — evita che si auto-inventi un dialogo
    // che finirebbe dentro la risposta visibile.
    const stop = partial.match(/\n\s*(Utente|Nicu)\s*:/)
    if (stop) {
      const clean = partial.slice(0, stop.index).trimEnd()
      onToken(clean)
      return clean
    }

    // Non mostrare una stop-sequence incompleta in coda (es. "\nUtente" senza ":")
    onToken(partial.replace(/\n\s*(Utente|Nicu)?\s*$/, ''))
  }

  return tokenizer
    .decode(generatedIds)
    .trimStart()
    .replace(/\n\s*(Utente|Nicu)\s*:?\s*$/, '')
    .trimEnd()
}

/**
 * Greedy decoding (solo per test di verità / dev, niente sampling).
 * Utility non usata dalla UI: bypassa il worker, richiede una sessione
 * main-thread ottenuta da `loadModel` di questo stesso modulo.
 * @returns array di id generati (escluso il token EOT)
 */
export async function greedyGenerate(
  session: ort.InferenceSession,
  tokenizer: BPETokenizer,
  promptStr: string,
  maxNew: number
): Promise<number[]> {
  const promptIds = tokenizer.encode(promptStr)
  const eotId = tokenizer.eotTokenId

  const allIds = [...promptIds]
  const generatedIds: number[] = []

  for (let step = 0; step < maxNew; step++) {
    const logits = await runStep(session, allIds)
    const nextId = argmax(logits)
    if (nextId === eotId) break
    allIds.push(nextId)
    generatedIds.push(nextId)
  }

  return generatedIds
}
