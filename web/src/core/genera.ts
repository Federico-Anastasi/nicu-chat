import type { GenerationParams } from './config.ts'
import { prossimoToken, type Casuale } from './campionatore.ts'
import { BLOCK_SIZE, costruisciPrompt, troncaPreservandoCanon, type Canon, type TurnoChat } from './prompt.ts'
import type { Cache, Passo } from './passo.ts'
import type { BPETokenizer } from './tokenizer.ts'

export interface Richiesta {
  userMsg: string
  history: TurnoChat[]
  params: GenerationParams
  canon?: Canon | null
}

export interface Opzioni {
  casuale?: Casuale
  onToken?: (parziale: string) => void
  interrotta?: () => boolean
  cedi?: () => Promise<void>
}

const STOP = /\n\s*(Utente|Nicu)\s*:/
const STOP_INCOMPLETO = /\n\s*(Utente|Nicu)?\s*$/
const STOP_IN_CODA = /\n\s*(Utente|Nicu)\s*:?\s*$/

export async function genera(passo: Passo, tokenizer: BPETokenizer, req: Richiesta, opz: Opzioni = {}): Promise<string> {
  const casuale = opz.casuale ?? Math.random
  const { userMsg, history, params } = req
  const costruito = costruisciPrompt(userMsg, history, s => tokenizer.encode(s), req.canon)
  const tokenCanon = costruito.tokenCanon
  const eot = tokenizer.eotTokenId
  const penalizzati = new Set(tokenizer.encode(`Utente: ${userMsg}\nNicu:`))

  const tutti = tokenizer.encode(costruito.testo)
  const generati: number[] = []
  let cache: Cache | null = null
  let daInviare = troncaPreservandoCanon(tutti, tokenCanon)

  for (let passoN = 0; passoN < params.maxNew; passoN++) {
    if (opz.interrotta?.()) break

    let logits: Float32Array
    if (passo.haKV) {
      const r = await passo.conCache(daInviare, cache)
      logits = r.logits
      cache = r.cache
    } else {
      logits = await passo.senzaCache(tutti, tokenCanon)
    }

    const prossimo = prossimoToken(logits, penalizzati, params, casuale)
    if (prossimo === eot) break

    tutti.push(prossimo)
    generati.push(prossimo)
    penalizzati.add(prossimo)

    if (passo.haKV) {
      if (tutti.length > BLOCK_SIZE) {
        cache = null
        daInviare = troncaPreservandoCanon(tutti, tokenCanon)
      } else {
        daInviare = [prossimo]
      }
    }

    const parziale = tokenizer.decode(generati).trimStart()
    const stop = parziale.match(STOP)
    if (stop) return parziale.slice(0, stop.index).trimEnd()

    opz.onToken?.(parziale.replace(STOP_INCOMPLETO, ''))
    if (opz.cedi) await opz.cedi()
  }

  return tokenizer.decode(generati).trimStart().replace(STOP_IN_CODA, '').trimEnd()
}
