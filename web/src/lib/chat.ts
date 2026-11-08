import { useSyncExternalStore } from 'react'
import { MODELLO, PARAMETRI_DEFAULT, type GenerationParams } from '../core/config.ts'
import { IS_HF_SPACE } from './ambiente.ts'
import { MAX_STORIA, leggiChat, leggiModalita, salvaChat, salvaModalita, taglia, type Messaggio, type Modalita } from './archivio.ts'
import { logTurn, newSession, ripristinaSessione, sessioneCorrente } from './logger.ts'
import { ErroreMotore, creaMotoreRemoto, puoRipiegare, type Motore, type TurnoStoria } from './motore.ts'
import { modelloInCache } from './cacheModello.ts'

export type { Messaggio, Modalita, StatoMessaggio } from './archivio.ts'

export const MAX_CARATTERI = 500
export const caratteri = (s: string) => Array.from(s.trim()).length
const LENTO_MS = 4_000
const SERVER_GIU_MS = 30_000
const ANNULLA_MS = 5_000

export type Fase = 'pronto' | 'scrive' | 'lento' | 'pieno' | 'limite' | 'offline' | 'errore'
export type Avviso = 'ripiego-telefono' | 'ripiego-server' | 'locale-fallito' | 'modello-perso'
export type FaseLocale = 'assente' | 'scaricato' | 'scarica' | 'avvio' | 'pronto' | 'errore'

export interface StatoLocale {
  fase: FaseLocale
  pct: number
  msg: string
  errore: string | null
}

export interface StatoChat {
  messaggi: Messaggio[]
  fase: Fase
  /** Preferenza salvata dell'utente. */
  modalita: Modalita
  /** Chi risponderà alla prossima richiesta (può differire dalla preferenza: download in corso, ripiego). */
  motore: 'server' | 'wasm'
  /** false sullo Space HF, dove esiste solo il telefono. */
  serverDisponibile: boolean
  /** false se non c'è nessun motore pronto (Space mentre carica). */
  puoiScrivere: boolean
  locale: StatoLocale
  online: boolean
  avviso: Avviso | null
  /** Epoch ms: fino a quando il server chiede di aspettare (fasi `pieno` e `limite`). */
  riprovaAlle: number | null
  puoiRiprovare: boolean
  /** Il guasto è del server e il telefono non è scaricato: è il momento di proporre il download. */
  offertaTelefono: boolean
  /** Epoch ms: finché vale, `annullaNuovaChat()` ripristina la chat appena svuotata. */
  annullaFino: number | null
  nuovaVersione: boolean
  memoria: boolean
  params: GenerationParams
}

interface Guasto { fase: 'pieno' | 'limite' | 'offline' | 'errore'; riprovaAlle: number | null }
interface Generazione { ctrl: AbortController; lento: boolean; timerLento: ReturnType<typeof setTimeout> }
interface ChatAnnullabile { messaggi: Messaggio[]; storia: TurnoStoria[]; sessione: string }

const serverDisponibile = !IS_HF_SPACE
const remoto = creaMotoreRemoto()

let messaggi: Messaggio[] = []
let storia: TurnoStoria[] = []
let contatore = 0
let preferenza: Modalita = serverDisponibile ? (leggiModalita() ?? 'server') : 'telefono'
let locale: StatoLocale = { fase: 'assente', pct: 0, msg: '', errore: null }
let motoreLocale: Motore | null = null
let caricamento: { promessa: Promise<Motore>; ctrl: AbortController } | null = null
let generazione: Generazione | null = null
let guasto: Guasto | null = null
let timerGuasto: ReturnType<typeof setTimeout> | undefined
let avviso: Avviso | null = null
let online = typeof navigator === 'undefined' ? true : navigator.onLine
let serverGiuFino = 0
let annulla: { chat: ChatAnnullabile; fino: number; timer: ReturnType<typeof setTimeout> } | null = null
let nuovaVersione = false
let memoria = true
let params: GenerationParams = { ...PARAMETRI_DEFAULT }
let avviato = false

const salvata = leggiChat()
if (salvata) {
  messaggi = salvata.messaggi
  storia = salvata.storia
  contatore = Math.max(0, ...messaggi.map(m => m.id))
  ripristinaSessione(salvata.sessione)
}

const localeUsabile = () => locale.fase === 'pronto' || locale.fase === 'scaricato'

const ascoltatori = new Set<() => void>()
let stato: StatoChat = calcola()

function calcola(): StatoChat {
  const usaTelefono = !serverDisponibile || (preferenza === 'telefono' && locale.fase === 'pronto') || (!online && localeUsabile())
  const motore = usaTelefono ? 'wasm' : 'server'
  const ultimo = messaggi[messaggi.length - 1]
  const fase: Fase = generazione
    ? generazione.lento ? 'lento' : 'scrive'
    : guasto?.fase ?? (!online && motore === 'server' ? 'offline' : 'pronto')
  const telefonoNonPronto = locale.fase === 'assente' || locale.fase === 'errore'
  return {
    messaggi,
    fase,
    modalita: preferenza,
    motore,
    serverDisponibile,
    puoiScrivere: serverDisponibile || locale.fase === 'pronto',
    locale,
    online,
    avviso,
    riprovaAlle: guasto?.riprovaAlle ?? null,
    puoiRiprovare: !generazione && !!ultimo && ultimo.role === 'nicu' && (ultimo.stato === 'errore' || ultimo.stato === 'interrotto'),
    offertaTelefono: serverDisponibile && online && telefonoNonPronto && (fase === 'pieno' || fase === 'offline' || fase === 'errore'),
    annullaFino: annulla?.fino ?? null,
    nuovaVersione,
    memoria,
    params,
  }
}

function aggiorna() {
  stato = calcola()
  ascoltatori.forEach(l => l())
}

function salva() {
  salvaChat({ sessione: sessioneCorrente(), messaggi, storia })
}

function impostaGuasto(g: Guasto | null) {
  clearTimeout(timerGuasto)
  guasto = g
  if (g?.riprovaAlle) {
    timerGuasto = setTimeout(() => {
      guasto = null
      aggiorna()
    }, Math.max(0, g.riprovaAlle - Date.now()))
  }
}

function guastoDa(e: ErroreMotore): Guasto {
  const fra = (s: number | null, predefinito: number | null) => {
    const secondi = s ?? predefinito
    return secondi === null ? null : Date.now() + secondi * 1000
  }
  if (e.codice === 'limite') return { fase: 'limite', riprovaAlle: fra(e.riprovaTraS, 30) }
  if (e.codice === 'occupato') return { fase: 'pieno', riprovaAlle: fra(e.riprovaTraS, null) }
  if (e.codice === 'offline') return { fase: 'offline', riprovaAlle: null }
  return { fase: 'errore', riprovaAlle: null }
}

function modificaMessaggio(id: number, patch: Partial<Messaggio>) {
  messaggi = messaggi.map(m => (m.id === id ? { ...m, ...patch } : m))
}

function impostaLocale(patch: Partial<StatoLocale>) {
  locale = { ...locale, ...patch }
  aggiorna()
}

function avviaLocale(): Promise<Motore> {
  if (motoreLocale) return Promise.resolve(motoreLocale)
  if (caricamento) return caricamento.promessa
  const ctrl = new AbortController()
  impostaLocale({ fase: 'scarica', pct: 0, msg: '', errore: null })
  const promessa = (async () => {
    try {
      const { caricaMotoreLocale } = await import('./motoreLocale.ts')
      const motore = await caricaMotoreLocale((pct, msg) => impostaLocale({ pct, msg, fase: pct >= 92 ? 'avvio' : 'scarica' }), ctrl.signal)
      motoreLocale = motore
      impostaLocale({ fase: 'pronto', pct: 100, msg: '' })
      return motore
    } catch (e) {
      if (ctrl.signal.aborted) {
        impostaLocale({ fase: (await modelloInCache()) ? 'scaricato' : 'assente', pct: 0, msg: '' })
      } else {
        console.error('[locale] inizializzazione fallita:', e)
        avviso = 'locale-fallito'
        if (preferenza === 'telefono' && serverDisponibile) {
          preferenza = 'server'
          salvaModalita(preferenza)
        }
        impostaLocale({ fase: 'errore', errore: String(e) })
      }
      throw new ErroreMotore('locale', null, String(e))
    } finally {
      caricamento = null
    }
  })()
  caricamento = { promessa, ctrl }
  return promessa
}

const abortita = (segnale: AbortSignal) =>
  new Promise<null>(resolve => segnale.addEventListener('abort', () => resolve(null), { once: true }))

function scegliPrimario(): { tipo: Motore['tipo']; perRipiego: boolean } {
  if (!serverDisponibile || (preferenza === 'telefono' && locale.fase === 'pronto')) return { tipo: 'wasm', perRipiego: false }
  if (localeUsabile() && (!online || Date.now() < serverGiuFino)) return { tipo: 'wasm', perRipiego: true }
  return { tipo: 'server', perRipiego: false }
}

async function avvia(idNicu: number, domanda: string) {
  const ctrl = new AbortController()
  const timerLento = setTimeout(() => {
    if (generazione?.ctrl !== ctrl) return
    generazione.lento = true
    aggiorna()
  }, LENTO_MS)
  generazione = { ctrl, lento: false, timerLento }
  aggiorna()

  const storiaUsata = memoria ? taglia(storia, MODELLO.maxTurniStoria ?? storia.length) : []
  const { tipo: primo, perRipiego } = scegliPrimario()
  const alternativa: Motore['tipo'] | null =
    primo === 'server' ? (localeUsabile() ? 'wasm' : null) : serverDisponibile && online ? 'server' : null
  let parziale = ''
  let testo: string | null = null
  let usato = primo
  let primoErrore: ErroreMotore | null = null

  for (const tipo of alternativa ? [primo, alternativa] : [primo]) {
    usato = tipo
    if (tipo !== primo || perRipiego) {
      avviso = tipo === 'wasm' ? 'ripiego-telefono' : 'ripiego-server'
    }
    if (tipo !== primo) {
      parziale = ''
      modificaMessaggio(idNicu, { text: '' })
    }
    aggiorna()
    try {
      const motore = tipo === 'server' ? remoto : await Promise.race([avviaLocale(), abortita(ctrl.signal)])
      testo = motore
        ? await motore.genera({
            messaggio: domanda,
            storia: storiaUsata,
            params,
            sessione: sessioneCorrente(),
            segnale: ctrl.signal,
            onToken: p => {
              if (generazione?.ctrl !== ctrl) return
              parziale = p
              modificaMessaggio(idNicu, { text: p })
              if (generazione.lento) generazione.lento = false
              aggiorna()
            },
          })
        : ''
      primoErrore = null
      break
    } catch (e) {
      const errore = e instanceof ErroreMotore ? e : new ErroreMotore('interno', null, String(e))
      primoErrore ??= errore
      if (!puoRipiegare(errore)) break
      if (tipo === 'server') serverGiuFino = Date.now() + SERVER_GIU_MS
    }
  }

  clearTimeout(timerLento)
  if (generazione?.ctrl !== ctrl) return
  generazione = null

  const interrotto = ctrl.signal.aborted
  const finale = (testo ?? parziale).trim()
  if (!interrotto && testo !== null && finale) {
    const prima = storiaUsata.length
    storia = taglia([...storia, { user: domanda, nicu: finale }], MAX_STORIA)
    modificaMessaggio(idNicu, { text: finale, stato: 'ok' })
    impostaGuasto(null)
    logTurn({
      user: domanda,
      nicu: finale,
      params: { ...params, memory: memoria, turns: prima },
      backend: usato,
      model: MODELLO.id,
    })
  } else if (interrotto) {
    modificaMessaggio(idNicu, { text: finale, stato: 'interrotto' })
    impostaGuasto(null)
  } else {
    modificaMessaggio(idNicu, { text: finale, stato: 'errore' })
    impostaGuasto(guastoDa(primoErrore ?? new ErroreMotore('interno', null, 'risposta vuota')))
    if (avviso === 'ripiego-telefono' || avviso === 'ripiego-server') avviso = null
  }
  salva()
  aggiorna()
}

function scartaAnnullamento() {
  if (!annulla) return
  clearTimeout(annulla.timer)
  annulla = null
}

export function invia(testo: string): boolean {
  const pulito = testo.trim()
  if (!pulito || caratteri(pulito) > MAX_CARATTERI || generazione || !stato.puoiScrivere) return false
  if (guasto?.fase === 'limite' && guasto.riprovaAlle && guasto.riprovaAlle > Date.now()) return false
  scartaAnnullamento()
  impostaGuasto(null)
  avviso = null
  const utente: Messaggio = { id: ++contatore, role: 'user', text: pulito, stato: 'ok' }
  const nicu: Messaggio = { id: ++contatore, role: 'nicu', text: '', stato: 'scrive' }
  messaggi = [...messaggi, utente, nicu]
  salva()
  void avvia(nicu.id, pulito)
  return true
}

export function ferma(): void {
  generazione?.ctrl.abort()
}

export function riprova(): boolean {
  if (!stato.puoiRiprovare) return false
  const nicu = messaggi[messaggi.length - 1]
  const utente = messaggi[messaggi.length - 2]
  if (!utente || utente.role !== 'user') return false
  impostaGuasto(null)
  avviso = null
  modificaMessaggio(nicu.id, { text: '', stato: 'scrive' })
  void avvia(nicu.id, utente.text)
  return true
}

export function nuovaChat(): void {
  if (!messaggi.length) return
  if (generazione) {
    generazione.ctrl.abort()
    clearTimeout(generazione.timerLento)
    generazione = null
  }
  scartaAnnullamento()
  const chat: ChatAnnullabile = {
    messaggi: messaggi.map((m): Messaggio => (m.stato === 'scrive' ? { ...m, stato: 'interrotto' } : m)),
    storia,
    sessione: sessioneCorrente(),
  }
  annulla = { chat, fino: Date.now() + ANNULLA_MS, timer: setTimeout(() => { annulla = null; aggiorna() }, ANNULLA_MS) }
  newSession()
  messaggi = []
  storia = []
  impostaGuasto(null)
  avviso = null
  salva()
  aggiorna()
}

export function annullaNuovaChat(): void {
  if (!annulla) return
  const { chat } = annulla
  scartaAnnullamento()
  ripristinaSessione(chat.sessione)
  messaggi = chat.messaggi
  storia = chat.storia
  salva()
  aggiorna()
}

export function scegliModalita(m: Modalita): void {
  if (!serverDisponibile || m === preferenza) return
  preferenza = m
  salvaModalita(m)
  avviso = null
  impostaGuasto(null)
  if (m === 'telefono') {
    try { void navigator.storage?.persist?.() } catch { /* nessun effetto sul funzionamento */ }
    void avviaLocale().catch(() => undefined)
  } else if (caricamento && locale.fase === 'scarica') {
    caricamento.ctrl.abort()
  }
  aggiorna()
}

export function chiudiAvviso(): void {
  avviso = null
  aggiorna()
}

export function impostaMemoria(v: boolean): void {
  memoria = v
  aggiorna()
}

export function impostaParametri(p: GenerationParams): void {
  params = p
  aggiorna()
}

export function segnalaNuovaVersione(): void {
  nuovaVersione = true
  aggiorna()
}

export const aggiornaApp = () => location.reload()

async function avvio() {
  const sulTelefono = await modelloInCache()
  if (sulTelefono && locale.fase === 'assente') impostaLocale({ fase: 'scaricato' })
  if (!serverDisponibile) {
    void avviaLocale().catch(() => undefined)
  } else if (preferenza === 'telefono') {
    if (sulTelefono) {
      void avviaLocale().catch(() => undefined)
    } else {
      preferenza = 'server'
      salvaModalita(preferenza)
      avviso = 'modello-perso'
      aggiorna()
    }
  }
}

function cambiaRete() {
  online = navigator.onLine
  if (online) {
    serverGiuFino = 0
    if (guasto?.fase === 'offline') impostaGuasto(null)
  }
  aggiorna()
}

function avviaAscolto() {
  if (avviato) return
  avviato = true
  window.addEventListener('online', cambiaRete)
  window.addEventListener('offline', cambiaRete)
  window.addEventListener('pagehide', salva)
  document.addEventListener('visibilitychange', () => { if (document.visibilityState === 'hidden') salva() })
  cambiaRete()
  void avvio()
}

function iscrivi(l: () => void) {
  avviaAscolto()
  ascoltatori.add(l)
  return () => { ascoltatori.delete(l) }
}

export const useChat = (): StatoChat => useSyncExternalStore(iscrivi, () => stato)

export const azioni = {
  invia,
  ferma,
  riprova,
  nuovaChat,
  annullaNuovaChat,
  scegliModalita,
  chiudiAvviso,
  impostaMemoria,
  impostaParametri,
  aggiornaApp,
}
