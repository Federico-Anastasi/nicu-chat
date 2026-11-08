import type { GenerationParams } from '../core/config.ts'

export interface TurnoStoria { user: string; nicu: string }

export interface RichiestaMotore {
  messaggio: string
  storia: TurnoStoria[]
  params: GenerationParams
  sessione: string
  segnale: AbortSignal
  onToken: (parziale: string) => void
}

// Un motore risolve col testo finale; se `segnale` è abortito risolve col testo parziale (anche vuoto), non lancia.
export interface Motore {
  readonly tipo: 'server' | 'wasm'
  genera(r: RichiestaMotore): Promise<string>
}

export type CodiceErrore =
  | 'offline'
  | 'rete'
  | 'timeout'
  | 'non_disponibile'
  | 'occupato'
  | 'limite'
  | 'troppo_lungo'
  | 'richiesta'
  | 'interno'
  | 'locale'

export class ErroreMotore extends Error {
  readonly codice: CodiceErrore
  readonly riprovaTraS: number | null

  constructor(codice: CodiceErrore, riprovaTraS: number | null = null, dettaglio = '') {
    super(dettaglio || codice)
    this.codice = codice
    this.riprovaTraS = riprovaTraS
  }
}

// Con questi errori ha senso passare all'altro motore; limite, messaggio troppo lungo e richiesta malformata no.
export const puoRipiegare = (e: ErroreMotore) => e.codice !== 'limite' && e.codice !== 'troppo_lungo' && e.codice !== 'richiesta'

const URL_CHAT = '/api/chat'
const PRIMO_EVENTO_MS = 8_000
const SILENZIO_MS = 20_000
const RETRY_AFTER_MAX_S = 300

async function erroreHttp(resp: Response): Promise<ErroreMotore> {
  const secondi = parseInt(resp.headers.get('Retry-After') ?? '')
  const riprova = secondi >= 0 ? Math.min(secondi, RETRY_AFTER_MAX_S) : null
  let codice = ''
  try {
    codice = (await resp.json()).error ?? ''
  } catch {
    codice = ''
  }
  if (resp.status === 429) return new ErroreMotore('limite', riprova)
  if (resp.status === 413) return new ErroreMotore('troppo_lungo')
  if (resp.status === 400) return new ErroreMotore(codice === 'too_long' ? 'troppo_lungo' : 'richiesta')
  if (resp.status === 503 && (codice === 'busy' || riprova !== null)) return new ErroreMotore('occupato', riprova)
  return new ErroreMotore('non_disponibile', null, `HTTP ${resp.status}`)
}

type EventoSse = { t: 'token' | 'done'; text: string } | { t: 'error'; code?: string }

function leggiEvento(blocco: string): EventoSse | null {
  const dati = blocco
    .split(/\r?\n/)
    .filter(riga => riga.startsWith('data:'))
    .map(riga => riga.slice(5).replace(/^ /, ''))
    .join('\n')
  if (!dati) return null
  try {
    return JSON.parse(dati) as EventoSse
  } catch {
    return null
  }
}

export function creaMotoreRemoto(): Motore {
  return {
    tipo: 'server',
    async genera(r) {
      if (r.segnale.aborted) return ''
      if (!navigator.onLine) throw new ErroreMotore('offline')

      const interno = new AbortController()
      let motivo: 'utente' | 'timeout' | 'silenzio' | null = null
      let timer: ReturnType<typeof setTimeout> | undefined
      const arma = (ms: number, perche: 'timeout' | 'silenzio') => {
        clearTimeout(timer)
        timer = setTimeout(() => {
          motivo ??= perche
          interno.abort()
        }, ms)
      }
      const dallUtente = () => {
        motivo ??= 'utente'
        interno.abort()
      }
      r.segnale.addEventListener('abort', dallUtente, { once: true })

      let parziale = ''
      try {
        arma(PRIMO_EVENTO_MS, 'timeout')
        const resp = await fetch(URL_CHAT, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', Accept: 'text/event-stream' },
          body: JSON.stringify({ message: r.messaggio, history: r.storia, params: r.params, session: r.sessione }),
          signal: interno.signal,
        })
        if (!resp.ok) throw await erroreHttp(resp)
        if (!resp.body) throw new ErroreMotore('non_disponibile', null, 'stream non supportato')

        const reader = resp.body.getReader()
        const decoder = new TextDecoder()
        let coda = ''
        while (true) {
          const { done, value } = await reader.read()
          arma(SILENZIO_MS, 'silenzio')
          if (done) break
          coda += decoder.decode(value, { stream: true })
          let fine: RegExpMatchArray | null
          while ((fine = coda.match(/\r?\n\r?\n/))) {
            const evento = leggiEvento(coda.slice(0, fine.index))
            coda = coda.slice(fine.index! + fine[0].length)
            if (!evento) continue
            if (evento.t === 'token') {
              parziale = evento.text
              r.onToken(parziale)
            } else if (evento.t === 'done') {
              return evento.text
            } else if (evento.t === 'error') {
              throw new ErroreMotore('interno', null, evento.code)
            }
          }
        }
        throw new ErroreMotore('rete', null, 'stream chiuso prima della fine')
      } catch (e) {
        if (motivo === 'utente') return parziale
        if (e instanceof ErroreMotore) throw e
        if (motivo === 'timeout') throw new ErroreMotore('timeout')
        if (motivo === 'silenzio') throw new ErroreMotore('rete', null, 'stream fermo')
        throw new ErroreMotore(navigator.onLine ? 'rete' : 'offline', null, String(e))
      } finally {
        clearTimeout(timer)
        r.segnale.removeEventListener('abort', dallUtente)
        interno.abort()
      }
    },
  }
}
