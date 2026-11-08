// Protocollo: main→worker load | generate | abort; worker→main progress | ready | token | done | error.
// onnxruntime-web resta 1.18 wasm-only (web/README.md, «versione bloccata»).

import * as ort from 'onnxruntime-web/wasm'
import { loadTokenizer, type BPETokenizer } from '../core/tokenizer.ts'
import type { GenerationParams } from '../core/config.ts'
import { creaPasso, type CostruttoreTensore, type Passo, type SessioneOrt } from '../core/passo.ts'
import { genera } from '../core/genera.ts'
import { configuraOrt, creaSessione } from './modelloLocale.ts'
import { precaricaWasm, pulisciVersioniVecchie, scaricaModello } from './cacheModello.ts'

export type FaseCaricamento = 'scarico' | 'avvio'
export type { GenerationParams }
export interface HistoryTurn { user: string; nicu: string }

export type MainToWorkerMsg =
  | { type: 'load'; modelUrl: string; tokenizerUrl: string }
  | { type: 'generate'; id: number; prompt: string; history: HistoryTurn[]; params: GenerationParams }
  | { type: 'abort'; id: number }

export type WorkerToMainMsg =
  | { type: 'progress'; pct: number; msg: string; fase: FaseCaricamento }
  | { type: 'ready' }
  | { type: 'token'; id: number; text: string }
  | { type: 'done'; id: number; text: string }
  | { type: 'error'; message: string; id?: number }

const ctx = self as unknown as {
  postMessage: (msg: WorkerToMainMsg) => void
  onmessage: ((ev: MessageEvent<MainToWorkerMsg>) => void) | null
}

function post(msg: WorkerToMainMsg) {
  ctx.postMessage(msg)
}

let passo: Passo | null = null
let tokenizer: BPETokenizer | null = null
const abortedIds = new Set<number>()

const avanza = (fase: FaseCaricamento) => (pct: number, msg: string) => post({ type: 'progress', pct, msg, fase })

async function loadModelInWorker(modelUrl: string, tokenizerUrl: string): Promise<void> {
  const scarico = avanza('scarico')
  const avvio = avanza('avvio')
  const scalato = (da: number, a: number, max: number) => (pct: number, msg: string) => scarico(Math.round(da + (pct / max) * (a - da)), msg)
  try {
    configuraOrt()
    scarico(0, 'Preparo il tokenizer…')
    tokenizer = await loadTokenizer(tokenizerUrl)
    scarico(2, 'Scarico Nicu… (24 MB, una volta sola)')
    await precaricaWasm(scalato(2, 28, 100))

    // Se la variante con cache non si scarica o non parte (RAM scarsa su iOS, deploy parziale) si ripiega sul .onnx semplice.
    let urlUsato = modelUrl
    let session: ort.InferenceSession
    try {
      const buffer = await scaricaModello(modelUrl, scalato(28, 91, 90))
      avvio(92, 'Inizializzo il motore…')
      session = await creaSessione(buffer)
    } catch (e) {
      if (!modelUrl.includes('.kv.')) throw e
      scarico(30, 'Riprovo senza cache…')
      urlUsato = modelUrl.replace('.kv.', '.')
      const buffer = await scaricaModello(urlUsato, scalato(30, 91, 90))
      avvio(92, 'Inizializzo il motore…')
      session = await creaSessione(buffer)
    }

    // "invalid dimensions for input past_k_*" = strati/teste/dimTesta di core/config.ts non allineati al modello.
    passo = creaPasso(session as unknown as SessioneOrt, ort.Tensor as unknown as CostruttoreTensore)
    await pulisciVersioniVecchie(urlUsato)
    avvio(100, 'Nicu è pronto!')
    post({ type: 'ready' })
  } catch (e) {
    post({ type: 'error', message: String(e) })
  }
}

async function generateInWorker(
  id: number,
  userMsg: string,
  history: HistoryTurn[],
  params: GenerationParams
): Promise<void> {
  if (!passo || !tokenizer) {
    post({ type: 'error', id, message: 'Modello non ancora caricato nel worker' })
    return
  }
  abortedIds.delete(id)
  try {
    const text = await genera(passo, tokenizer, { userMsg, history, params }, {
      onToken: t => post({ type: 'token', id, text: t }),
      interrotta: () => abortedIds.has(id),
      cedi: () => new Promise<void>(r => setTimeout(r, 0)),
    })
    post({ type: 'done', id, text })
  } catch (e) {
    post({ type: 'error', id, message: String(e) })
  } finally {
    abortedIds.delete(id)
  }
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
