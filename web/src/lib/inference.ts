// Inferenza locale: Web Worker con ripiego sul main thread. Solo la modalità «sul telefono» passa di qui,
// e solo via import() dinamico (vedi motoreLocale.ts). onnxruntime-web resta 1.18 wasm-only: web/README.md.

import * as mainthread from './inference.mainthread'
import { MODELLO, type GenerationParams } from '../core/config.ts'
import type { MainToWorkerMsg, WorkerToMainMsg } from './inference.worker'

const AVVIO_WORKER_MS = 20_000
const STALLO_DOWNLOAD_MS = 60_000
const INIT_MOTORE_MS = 20_000

export type SessionHandle = { mode: 'worker' } | { mode: 'mainthread'; caricato: mainthread.LoadResult }

export interface HistoryTurn { user: string; nicu: string }

let worker: Worker | null = null
let genCounter = 0

interface PendingGen {
  onToken: (partial: string) => void
  resolve: (text: string) => void
  reject: (err: unknown) => void
}
const pending = new Map<number, PendingGen>()

function attachSteadyStateListeners(w: Worker) {
  w.onmessage = (ev: MessageEvent<WorkerToMainMsg>) => {
    const msg = ev.data
    if (msg.type === 'token') {
      pending.get(msg.id)?.onToken(msg.text)
    } else if (msg.type === 'done') {
      const p = pending.get(msg.id)
      if (p) {
        pending.delete(msg.id)
        p.resolve(msg.text)
      }
    } else if (msg.type === 'error') {
      const p = msg.id === undefined ? undefined : pending.get(msg.id)
      if (p) {
        pending.delete(msg.id!)
        p.reject(new Error(msg.message))
      } else {
        console.error('[inference worker]', msg.message)
      }
    }
  }
  w.onerror = (ev) => console.error('[inference worker] errore runtime:', ev.message)
}

type EsitoWorker = 'pronto' | 'ripiego' | 'stallo' | 'annullato'

// Il timer non copre mai il download: si riarma a ogni avanzamento. Solo il silenzio lo fa scattare:
// all'avvio e dopo il download → ripiego sul main thread; durante il download → errore (riscaricare non aiuta).
function avviaWorker(
  w: Worker,
  modelUrl: string,
  onProgress: (pct: number, msg: string) => void,
  signal?: AbortSignal,
): Promise<EsitoWorker> {
  return new Promise(resolve => {
    let timer: ReturnType<typeof setTimeout>
    const fine = (esito: EsitoWorker) => {
      clearTimeout(timer)
      signal?.removeEventListener('abort', annulla)
      resolve(esito)
    }
    const arma = (ms: number, esito: EsitoWorker) => {
      clearTimeout(timer)
      timer = setTimeout(() => fine(esito), ms)
    }
    const annulla = () => fine('annullato')

    if (signal?.aborted) return fine('annullato')
    signal?.addEventListener('abort', annulla, { once: true })
    arma(AVVIO_WORKER_MS, 'ripiego')

    w.onerror = () => fine('ripiego')
    w.onmessage = (ev: MessageEvent<WorkerToMainMsg>) => {
      const msg = ev.data
      if (msg.type === 'progress') {
        onProgress(msg.pct, msg.msg)
        if (msg.fase === 'scarico') arma(STALLO_DOWNLOAD_MS, 'stallo')
        else arma(INIT_MOTORE_MS, 'ripiego')
      } else if (msg.type === 'ready') {
        fine('pronto')
      } else if (msg.type === 'error') {
        console.error('[inference worker] errore di init:', msg.message)
        fine('ripiego')
      }
    }

    const load: MainToWorkerMsg = { type: 'load', modelUrl, tokenizerUrl: MODELLO.tokenizer }
    w.postMessage(load)
  })
}

export async function loadModel(
  modelUrl: string,
  onProgress: (pct: number, msg: string) => void,
  signal?: AbortSignal,
): Promise<SessionHandle> {
  let esito: EsitoWorker = 'ripiego'
  try {
    // Vite bundla il worker come modulo separato; Safari 15+ supporta i module worker.
    const w = new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' })
    esito = await avviaWorker(w, modelUrl, onProgress, signal)
    if (esito === 'pronto') {
      worker = w
      attachSteadyStateListeners(w)
      return { mode: 'worker' }
    }
    w.terminate()
  } catch (e) {
    console.warn('[inference] Impossibile creare il Worker, ripiego sul main thread:', e)
  }
  if (esito === 'annullato') throw new DOMException('Download annullato', 'AbortError')
  if (esito === 'stallo') throw new Error('Il download si è fermato: la connessione non porta dati')

  console.warn('[inference] Worker non pronto, ripiego sul main thread.')
  // Il main thread non gestisce la KV cache: si scende al modello piatto (stessi pesi, stesso output).
  const caricato = await mainthread.loadModel(modelUrl.replace('.kv.', '.'), MODELLO.tokenizer, onProgress)
  if (signal?.aborted) throw new DOMException('Download annullato', 'AbortError')
  return { mode: 'mainthread', caricato }
}

export async function generate(
  session: SessionHandle,
  userMsg: string,
  params: GenerationParams,
  onToken: (partial: string) => void,
  signal?: AbortSignal,
  history: HistoryTurn[] = [],
): Promise<string> {
  if (session.mode === 'mainthread') {
    return mainthread.generate(session.caricato, userMsg, params, onToken, signal, history)
  }

  if (!worker) throw new Error('Worker di inferenza non inizializzato')
  if (signal?.aborted) return ''
  const w = worker
  const id = ++genCounter

  return new Promise<string>((resolve, reject) => {
    pending.set(id, { onToken, resolve, reject })
    signal?.addEventListener('abort', () => w.postMessage({ type: 'abort', id } satisfies MainToWorkerMsg), { once: true })
    w.postMessage({ type: 'generate', id, prompt: userMsg, history, params } satisfies MainToWorkerMsg)
  })
}
