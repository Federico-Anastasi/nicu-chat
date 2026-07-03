/**
 * inference.worker.ts — inferenza ONNX per Nicu, dentro un Web Worker.
 *
 * PERCHÉ: l'inferenza ORT girava sul main thread → durante la generazione il
 * browser non dipingeva/animava niente (pagina "bloccata"), molto evidente sui
 * device lenti (iPad/iPhone vecchi). Spostando modello + tokenizer + loop di
 * generazione qui dentro, il main thread resta libero per l'UI (streaming dei
 * token, animazioni CSS) mentre il worker macina i tensori.
 *
 * Stessa identica config WASM-only di prima (⚠️ NON toccare senza rileggere
 * web/README.md §"onnxruntime-web: versione bloccata"): `onnxruntime-web/wasm`,
 * `numThreads=1`, niente SharedArrayBuffer/COOP-COEP. L'API `caches` (Cache
 * Storage) è disponibile anche nei Worker, quindi il modello resta cache-ato
 * come prima.
 *
 * Protocollo messaggi (vedi anche inference.ts, che consuma questo worker):
 *   main → worker: {type:'load', modelUrl, tokenizerUrl}
 *                  {type:'generate', id, prompt, history, params}
 *                  {type:'abort', id}
 *   worker → main: {type:'progress', pct, msg}
 *                  {type:'ready'}
 *                  {type:'token', id, text}
 *                  {type:'done', id, text}
 *                  {type:'error', message, id?}
 */

import * as ort from 'onnxruntime-web/wasm'
import { loadTokenizer, type BPETokenizer } from './tokenizer'

// ---------------------------------------------------------------------------
// Tipi del protocollo — condivisi (import type) con inference.ts
// ---------------------------------------------------------------------------

export interface HistoryTurn { user: string; nicu: string }

export interface GenerationParams {
  temperature: number
  topP: number
  repPenalty: number
  maxNew: number
}

export type MainToWorkerMsg =
  | { type: 'load'; modelUrl: string; tokenizerUrl: string }
  | { type: 'generate'; id: number; prompt: string; history: HistoryTurn[]; params: GenerationParams }
  | { type: 'abort'; id: number }

export type WorkerToMainMsg =
  | { type: 'progress'; pct: number; msg: string }
  | { type: 'ready' }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; text: string }
  | { type: 'error'; message: string; id?: number }

// `self` in un module worker è un DedicatedWorkerGlobalScope, ma il tsconfig
// del progetto usa solo lib "DOM" (niente "webworker", per evitare di dover
// gestire due lib-set nello stesso progetto) → castiamo esplicitamente
// l'interfaccia minima che usiamo, invece di introdurre la lib "webworker".
const ctx = self as unknown as {
  postMessage: (msg: WorkerToMainMsg) => void
  onmessage: ((ev: MessageEvent<MainToWorkerMsg>) => void) | null
  location: { origin: string }
}

function post(msg: WorkerToMainMsg) {
  ctx.postMessage(msg)
}

// ---------------------------------------------------------------------------
// Stato del worker
// ---------------------------------------------------------------------------

const CACHE_NAME = 'nicu-model-v1'
const BLOCK_SIZE = 512   // nicu-L-v9-sft: contesto 512
const VOCAB_SIZE = 6000  // nicu-L-v9-sft: BPE bpe_synth (6k)

let session: ort.InferenceSession | null = null
let tokenizer: BPETokenizer | null = null

// id delle generazioni in corso da abortire (processato tra un token e l'altro)
const abortedIds = new Set<number>()

// ---------------------------------------------------------------------------
// Sampling helpers (identici a inference.mainthread.ts)
// ---------------------------------------------------------------------------

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

function topPSample(probs: Float32Array, topP: number): number {
  const n = probs.length
  const indices = new Uint32Array(n)
  for (let i = 0; i < n; i++) indices[i] = i
  const sortedIdx = Array.from(indices).sort((a, b) => probs[b] - probs[a])

  const filtered = new Float32Array(n)
  let cumSum = 0
  let sum = 0
  for (let rank = 0; rank < sortedIdx.length; rank++) {
    const idx = sortedIdx[rank]
    const p = probs[idx]
    if (cumSum > topP) {
      filtered[idx] = 0
    } else {
      filtered[idx] = p
      sum += p
    }
    cumSum += p
  }

  if (sum === 0) {
    filtered[sortedIdx[0]] = 1
    sum = 1
  }
  for (let i = 0; i < n; i++) filtered[i] /= sum

  const r = Math.random()
  let acc = 0
  for (const idx of sortedIdx) {
    if (filtered[idx] === 0) continue
    acc += filtered[idx]
    if (r < acc) return idx
  }
  return sortedIdx[0]
}

async function runStep(ids: number[]): Promise<Float32Array> {
  const slice = ids.length > BLOCK_SIZE ? ids.slice(ids.length - BLOCK_SIZE) : ids
  const seqLen = slice.length

  const inputData = new BigInt64Array(seqLen)
  for (let i = 0; i < seqLen; i++) inputData[i] = BigInt(slice[i])
  const inputTensor = new ort.Tensor('int64', inputData, [1, seqLen])

  const outputs = await session!.run({ idx: inputTensor })
  const logitsAll = outputs['logits'].data as Float32Array
  const offset = (seqLen - 1) * VOCAB_SIZE
  return logitsAll.slice(offset, offset + VOCAB_SIZE)
}

// ---------------------------------------------------------------------------
// Caricamento (modello + tokenizer)
// ---------------------------------------------------------------------------

async function loadModelInWorker(modelUrl: string, tokenizerUrl: string): Promise<void> {
  try {
    ort.env.wasm.wasmPaths = '/wasm/'
    ort.env.wasm.numThreads = 1
    ort.env.wasm.proxy = false

    post({ type: 'progress', pct: 0, msg: 'Preparo il tokenizer…' })
    tokenizer = await loadTokenizer(tokenizerUrl)

    post({ type: 'progress', pct: 2, msg: 'Scarico Nicu… (84 MB, una volta sola)' })

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
          await cache.put(modelUrl, net.clone())
          resp = net
        }
      } catch {
        resp = await fetch(modelUrl)
        if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
      }

      if (fromCache) post({ type: 'progress', pct: 10, msg: 'Carico Nicu dalla cache… (già scaricato)' })

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
        post({ type: 'progress', pct, msg: `Scarico Nicu… ${(received / 1_048_576).toFixed(1)} / ${(total / 1_048_576).toFixed(0)} MB` })
      }

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

    post({ type: 'progress', pct: 92, msg: 'Inizializzo il motore…' })

    try {
      session = await ort.InferenceSession.create(modelBuffer, {
        executionProviders: ['wasm'],
        graphOptimizationLevel: 'all',
      })
    } catch (e) {
      throw new Error(`Impossibile creare la sessione ONNX: ${e}`)
    }

    // Cleanup: rimuove dalla cache le versioni vecchie del modello (chiavi
    // diverse dal modelUrl corrente) — evita di accumulare più .onnx da
    // ~39 MB l'uno nella Cache Storage a ogni cambio di versione.
    try {
      const cache = await caches.open(CACHE_NAME)
      const keys = await cache.keys()
      const currentAbs = new URL(modelUrl, ctx.location.origin).toString()
      for (const req of keys) {
        if (req.url !== currentAbs) await cache.delete(req)
      }
    } catch {
      // Cache Storage non disponibile: nessun cleanup da fare
    }

    post({ type: 'progress', pct: 100, msg: 'Nicu è pronto!' })
    post({ type: 'ready' })
  } catch (e) {
    post({ type: 'error', message: String(e) })
  }
}

// ---------------------------------------------------------------------------
// Generazione autoregressiva con streaming
// ---------------------------------------------------------------------------

async function generateInWorker(
  id: number,
  userMsg: string,
  history: HistoryTurn[],
  params: GenerationParams
): Promise<void> {
  if (!session || !tokenizer) {
    post({ type: 'error', id, message: 'Modello non ancora caricato nel worker' })
    return
  }
  abortedIds.delete(id)

  let prompt = ''
  for (const t of history) prompt += `Utente: ${t.user}\nNicu: ${t.nicu}\n`
  prompt += `Utente: ${userMsg}\nNicu:`
  const promptIds = tokenizer.encode(prompt)
  const eotId = tokenizer.eotTokenId

  // Repetition penalty SOLO su turno corrente + token generati, MAI sulla
  // storia: penalizzare tutto il prompt spinge il modello fuori dai token
  // comuni dell'italiano e con 3+ turni di memoria produce risposte garble
  // (bug osservato nei log del 2026-07-02). Lo scopo della penalty è evitare
  // loop nella RISPOSTA, non punire le parole già dette in conversazione.
  const penalized = new Set(tokenizer.encode(`Utente: ${userMsg}\nNicu:`))

  const allIds = [...promptIds]
  const generatedIds: number[] = []

  try {
    for (let step = 0; step < params.maxNew; step++) {
      if (abortedIds.has(id)) break

      const logits = await runStep(allIds)

      for (const t of penalized) logits[t] /= params.repPenalty
      for (let i = 0; i < logits.length; i++) logits[i] /= params.temperature

      const probs = softmax(logits)
      const nextId = topPSample(probs, params.topP)

      if (nextId === eotId) break

      allIds.push(nextId)
      generatedIds.push(nextId)
      penalized.add(nextId)

      const partial = tokenizer.decode(generatedIds).trimStart()

      const stop = partial.match(/\n\s*(Utente|Nicu)\s*:/)
      if (stop) {
        const clean = partial.slice(0, stop.index).trimEnd()
        post({ type: 'done', id, text: clean })
        abortedIds.delete(id)
        return
      }

      // Non mostrare una stop-sequence incompleta in coda (es. "\nUtente"
      // senza i due punti): resterebbe nel testo se la generazione finisce lì.
      post({ type: 'token', id, text: partial.replace(/\n\s*(Utente|Nicu)?\s*$/, '') })

      // Cede il controllo dopo ogni token: lascia il worker libero di
      // processare eventuali messaggi 'abort' in coda prima del prossimo step.
      await new Promise<void>(r => setTimeout(r, 0))
    }
  } catch (e) {
    post({ type: 'error', id, message: String(e) })
    abortedIds.delete(id)
    return
  }

  abortedIds.delete(id)
  const finalText = tokenizer
    .decode(generatedIds)
    .trimStart()
    .replace(/\n\s*(Utente|Nicu)\s*:?\s*$/, '')
    .trimEnd()
  post({ type: 'done', id, text: finalText })
}

// ---------------------------------------------------------------------------
// Dispatch messaggi
// ---------------------------------------------------------------------------

ctx.onmessage = (ev: MessageEvent<MainToWorkerMsg>) => {
  const msg = ev.data
  switch (msg.type) {
    case 'load':
      void loadModelInWorker(msg.modelUrl, msg.tokenizerUrl)
      break
    case 'generate':
      void generateInWorker(msg.id, msg.prompt, msg.history, msg.params)
      break
    case 'abort':
      abortedIds.add(msg.id)
      break
  }
}
