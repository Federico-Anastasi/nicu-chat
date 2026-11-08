import type { TurnoStoria } from './motore.ts'

export type Modalita = 'server' | 'telefono'
export type Consenso = 'si' | 'no'
export type StatoMessaggio = 'ok' | 'scrive' | 'interrotto' | 'errore'

export interface Messaggio {
  id: number
  role: 'user' | 'nicu'
  text: string
  stato: StatoMessaggio
}

export interface ChatSalvata {
  sessione: string
  messaggi: Messaggio[]
  storia: TurnoStoria[]
}

const CHIAVE_CHAT = 'nicu_chat_v1'
const CHIAVE_MODALITA = 'nicu_modalita'
const CHIAVE_CONSENSO = 'nicu_consenso_v2'
const MAX_MESSAGGI = 200
export const MAX_STORIA = 20
const STATI: StatoMessaggio[] = ['ok', 'scrive', 'interrotto', 'errore']

export const taglia = <T>(v: T[], n: number) => (v.length > n ? v.slice(-n) : v)

export function leggiModalita(): Modalita | null {
  try {
    const v = localStorage.getItem(CHIAVE_MODALITA)
    return v === 'server' || v === 'telefono' ? v : null
  } catch {
    return null
  }
}

export function salvaModalita(m: Modalita): void {
  try { localStorage.setItem(CHIAVE_MODALITA, m) } catch { return }
}

export function leggiConsenso(): Consenso | null {
  try {
    const v = localStorage.getItem(CHIAVE_CONSENSO)
    return v === 'si' || v === 'no' ? v : null
  } catch {
    return null
  }
}

export function salvaConsenso(v: Consenso): void {
  try { localStorage.setItem(CHIAVE_CONSENSO, v) } catch { return }
}

function messaggioValido(m: unknown): m is Messaggio {
  const x = m as Messaggio
  return !!x && Number.isInteger(x.id) && (x.role === 'user' || x.role === 'nicu') && typeof x.text === 'string' && STATI.includes(x.stato)
}

function turnoValido(t: unknown): t is TurnoStoria {
  const x = t as TurnoStoria
  return !!x && typeof x.user === 'string' && typeof x.nicu === 'string'
}

export function leggiChat(): ChatSalvata | null {
  try {
    const grezzo = localStorage.getItem(CHIAVE_CHAT)
    if (!grezzo) return null
    const d = JSON.parse(grezzo)
    if (!Array.isArray(d.messaggi) || !Array.isArray(d.storia) || typeof d.sessione !== 'string') return null
    // Una generazione rimasta a metà (pagina chiusa mentre scriveva) diventa «interrotta»: si può rigenerare.
    const messaggi = d.messaggi.filter(messaggioValido).map((m: Messaggio): Messaggio => (m.stato === 'scrive' ? { ...m, stato: 'interrotto' } : m))
    return messaggi.length ? { sessione: d.sessione, messaggi, storia: d.storia.filter(turnoValido) } : null
  } catch {
    return null
  }
}

export function salvaChat(chat: ChatSalvata): void {
  try {
    if (!chat.messaggi.length) localStorage.removeItem(CHIAVE_CHAT)
    else localStorage.setItem(CHIAVE_CHAT, JSON.stringify({ ...chat, messaggi: taglia(chat.messaggi, MAX_MESSAGGI), storia: taglia(chat.storia, MAX_STORIA) }))
  } catch { return }
}
