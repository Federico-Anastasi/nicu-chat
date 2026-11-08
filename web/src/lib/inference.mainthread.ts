import * as ort from 'onnxruntime-web/wasm'
import { loadTokenizer, type BPETokenizer } from '../core/tokenizer.ts'
import type { TurnoChat } from '../core/prompt.ts'
import type { GenerationParams } from '../core/config.ts'
import { creaPasso, type CostruttoreTensore, type SessioneOrt } from '../core/passo.ts'
import { genera } from '../core/genera.ts'
import { configuraOrt, creaSessione } from './modelloLocale.ts'
import { precaricaWasm, pulisciVersioniVecchie, scaricaModello, type Avanzamento } from './cacheModello.ts'

export interface LoadResult {
  session: ort.InferenceSession
  tokenizer: BPETokenizer
}

export async function loadModel(modelUrl: string, tokenizerUrl: string, avanza: Avanzamento): Promise<LoadResult> {
  configuraOrt()
  const scalato = (da: number, a: number, max: number): Avanzamento => (pct, msg) => avanza(Math.round(da + (pct / max) * (a - da)), msg)
  const tokenizer = await loadTokenizer(tokenizerUrl)
  await precaricaWasm(scalato(2, 28, 100))
  const buffer = await scaricaModello(modelUrl, scalato(28, 91, 90))
  avanza(92, 'Inizializzo il motore…')
  let session: ort.InferenceSession
  try {
    session = await creaSessione(buffer)
  } catch (e) {
    throw new Error(`Impossibile creare la sessione ONNX: ${e}`)
  }
  await pulisciVersioniVecchie(modelUrl)
  avanza(100, 'Nicu è pronto!')
  return { session, tokenizer }
}

export function generate(
  { session, tokenizer }: LoadResult,
  userMsg: string,
  params: GenerationParams,
  onToken: (partial: string) => void,
  signal?: AbortSignal,
  history: TurnoChat[] = [],
): Promise<string> {
  const passo = creaPasso(session as unknown as SessioneOrt, ort.Tensor as unknown as CostruttoreTensore)
  return genera(passo, tokenizer, { userMsg, history, params }, {
    onToken,
    interrotta: () => signal?.aborted ?? false,
    cedi: () => new Promise<void>(r => setTimeout(r, 0)),
  })
}
