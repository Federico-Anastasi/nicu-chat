/**
 * inference.ts — punto d'ingresso pubblico dell'inferenza di Nicu.
 *
 * Da qui in poi l'inferenza vera gira in un **Web Worker**
 * (`inference.worker.ts`): il main thread resta libero per l'UI (streaming
 * token, animazioni CSS) invece di bloccarsi durante la generazione — il
 * "la pagina sembra bloccata" segnalato su iPad/iPhone lenti era proprio
 * questo: ORT sul main thread.
 *
 * Questo modulo espone le STESSE firme di prima (`loadModel`, `generate`,
 * `DEFAULT_PARAMS`, `MODEL_ID`, …) e fa da PROXY verso il worker via
 * `postMessage`. App.tsx non cambia: chiama queste funzioni esattamente come
 * prima, senza sapere se dietro c'è un worker o il main thread.
 *
 * Fallback robusto: se la creazione del Worker fallisce, o il worker non
 * risponde entro `WORKER_INIT_TIMEOUT_MS`, si ripiega in modo trasparente su
 * `inference.mainthread.ts` (il vecchio percorso, invariato) — stesso
 * risultato funzionale, solo senza il beneficio del thread separato.
 *
 * ⚠️ onnxruntime-web resta pinnato a 1.18 con `onnxruntime-web/wasm` — vedi
 * web/README.md §"onnxruntime-web: versione bloccata" PRIMA di toccare
 * inference.worker.ts o inference.mainthread.ts.
 */

import * as mainthread from './inference.mainthread'
import type { BPETokenizer } from './tokenizer'
import type {
  MainToWorkerMsg,
  WorkerToMainMsg,
  HistoryTurn as WorkerHistoryTurn,
  GenerationParams as WorkerGenerationParams,
} from './inference.worker'

// ---------------------------------------------------------------------------
// Configurazione
// ---------------------------------------------------------------------------

// Identificativo del modello attivo — fonte unica, loggato a ogni turno così
// nel DB si distinguono le conversazioni per versione di modello.
export const MODEL_ID = 'nicu-L-v9-sft'

// Il worker carica anche il tokenizer (lui esegue encode/decode durante la
// generazione); il main thread ne carica una seconda copia leggera (~0,8 MB,
// dalla cache HTTP dopo il primo giro) solo per soddisfare l'API esistente
// di App.tsx (che chiama `loadTokenizer` da ./tokenizer prima di loadModel).
const TOKENIZER_URL = '/bpe_synth.json'

// Se il worker non risponde con 'ready' entro questa soglia (creazione fallita,
// bloccato, CSP che vieta i module worker, …) → fallback main-thread.
const WORKER_INIT_TIMEOUT_MS = 20_000

export type ExecutionBackend = 'wasm' | 'unknown'

/** Dove gira davvero la generazione: utile per diagnosi (mostrato nei Parametri). */
export type EngineMode = 'worker' | 'mainthread'

/**
 * Handle opaco della sessione. Col worker non esiste una vera
 * `ort.InferenceSession` sul main thread (vive dentro il worker); col
 * fallback main-thread invece è la sessione ONNX reale. App.tsx non guarda
 * mai dentro: si limita a tenerlo in un ref e a passarlo a `generate`.
 */
export type SessionHandle =
  | { mode: 'worker' }
  | { mode: 'mainthread'; session: mainthread.LoadResult['session'] }

export interface LoadResult {
  session: SessionHandle
  backend: ExecutionBackend
  mode: EngineMode
}

export interface GenerationParams {
  temperature: number  // default 1.0
  topP: number         // default 0.92
  repPenalty: number   // default 1.15
  maxNew: number        // default 200
}

export const DEFAULT_PARAMS: GenerationParams = {
  temperature: 1.0,
  topP: 0.92,
  repPenalty: 1.15,
  maxNew: 200,
}

export interface HistoryTurn { user: string; nicu: string }

// ---------------------------------------------------------------------------
// Stato del proxy verso il worker
// ---------------------------------------------------------------------------

let worker: Worker | null = null
let genCounter = 0

interface PendingGen {
  onToken: (partial: string) => void
  resolve: (text: string) => void
  reject: (err: unknown) => void
}
const pending = new Map<number, PendingGen>()

function createInferenceWorker(): Worker {
  // Vite bundla il worker come modulo separato grazie a `new URL(...)`.
  // Safari 15+ supporta i module worker (iPad target 15.5 → ok).
  return new Worker(new URL('./inference.worker.ts', import.meta.url), { type: 'module' })
}

/** Collega i listener "a regime" (post-init) che smistano token/done/error alle generazioni pendenti. */
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
      if (msg.id !== undefined) {
        const p = pending.get(msg.id)
        if (p) {
          pending.delete(msg.id)
          p.reject(new Error(msg.message))
        }
      } else {
        console.error('[inference worker] errore non associato a una generazione:', msg.message)
      }
    }
  }
  w.onerror = (ev) => {
    console.error('[inference worker] errore runtime:', ev.message)
  }
}

/**
 * Prova a creare e inizializzare il worker (carica modello+tokenizer al suo
 * interno). Risolve `true` se il worker è pronto entro il timeout, `false`
 * altrimenti (mai rigetta: il chiamante decide il fallback).
 */
function tryInitWorker(
  w: Worker,
  modelUrl: string,
  onProgress: (pct: number, msg: string) => void
): Promise<boolean> {
  return new Promise(resolve => {
    let settled = false
    const finish = (ok: boolean) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      resolve(ok)
    }

    const timer = setTimeout(() => finish(false), WORKER_INIT_TIMEOUT_MS)

    w.onerror = () => finish(false)
    w.onmessage = (ev: MessageEvent<WorkerToMainMsg>) => {
      const msg = ev.data
      if (msg.type === 'progress') onProgress(msg.pct, msg.msg)
      else if (msg.type === 'ready') finish(true)
      else if (msg.type === 'error') {
        console.error('[inference worker] errore di init:', msg.message)
        finish(false)
      }
    }

    const load: MainToWorkerMsg = { type: 'load', modelUrl, tokenizerUrl: TOKENIZER_URL }
    w.postMessage(load)
  })
}

// ---------------------------------------------------------------------------
// API pubblica — stesse firme di prima
// ---------------------------------------------------------------------------

/**
 * Carica il modello. Prova prima il Web Worker; se non si inizializza in
 * tempo, ripiega in modo trasparente sul main thread.
 */
export async function loadModel(
  modelUrl: string,
  onProgress: (pct: number, msg: string) => void
): Promise<LoadResult> {
  try {
    const w = createInferenceWorker()
    const ok = await tryInitWorker(w, modelUrl, onProgress)
    if (ok) {
      worker = w
      attachSteadyStateListeners(w)
      return { session: { mode: 'worker' }, backend: 'wasm', mode: 'worker' }
    }
    w.terminate()
    console.warn('[inference] Worker non pronto entro il timeout, ripiego sul main thread.')
  } catch (e) {
    console.warn('[inference] Impossibile creare il Worker, ripiego sul main thread:', e)
  }

  // Fallback: identico comportamento di prima (blocca il main thread durante
  // la generazione, ma funziona sempre).
  const { session, backend } = await mainthread.loadModel(modelUrl, onProgress)
  return { session: { mode: 'mainthread', session }, backend, mode: 'mainthread' }
}

/**
 * Genera la risposta di Nicu in streaming. Instrada verso il worker o verso
 * il main thread a seconda di come `session` (l'handle restituito da
 * `loadModel`) è stato ottenuto.
 */
/**
 * Turni di storia passati al modello quando la memoria è attiva. N_eff ≈ 24
 * token (probe_context): oltre ~1-2 turni il contesto in più non aiuta e
 * allunga solo il prompt — 3 è il compromesso (recall del nome + niente rumore).
 */
export const MAX_HISTORY_TURNS = 3

export async function generate(
  session: SessionHandle,
  tokenizer: BPETokenizer,
  userMsg: string,
  params: GenerationParams,
  onToken: (partial: string) => void,
  signal?: AbortSignal,
  historyFull: HistoryTurn[] = []
): Promise<string> {
  const history = historyFull.slice(-MAX_HISTORY_TURNS)
  if (session.mode === 'mainthread') {
    return mainthread.generate(session.session, tokenizer, userMsg, params, onToken, signal, history)
  }

  if (!worker) throw new Error('Worker di inferenza non inizializzato')
  const w = worker
  const id = ++genCounter

  return new Promise<string>((resolve, reject) => {
    pending.set(id, { onToken, resolve, reject })

    if (signal) {
      const onAbort = () => {
        const msg: MainToWorkerMsg = { type: 'abort', id }
        w.postMessage(msg)
      }
      if (signal.aborted) onAbort()
      else signal.addEventListener('abort', onAbort, { once: true })
    }

    const gen: MainToWorkerMsg = {
      type: 'generate',
      id,
      prompt: userMsg,
      history: history as WorkerHistoryTurn[],
      params: params as WorkerGenerationParams,
    }
    w.postMessage(gen)
  })
}

/**
 * Greedy decoding (solo per test di verità / dev, niente sampling, nessuno
 * streaming). Non è usata dalla UI: bypassa il worker e richiede una
 * sessione main-thread reale — usa `inference.mainthread.loadModel` per
 * ottenerla se ti serve per uno script di verifica.
 */
export const greedyGenerate = mainthread.greedyGenerate
