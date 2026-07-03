// ---------------------------------------------------------------------------
// Logger — invia gli scambi di conversazione al backend per migliorare Nicu.
// Fire-and-forget: non blocca mai la chat, ingoia ogni errore.
// In dev (Vite) non c'è backend → fallisce in silenzio, nessun problema.
// ---------------------------------------------------------------------------

import type { GenerationParams } from './inference'

const ENDPOINT = '/api/log'

// Id di sessione effimero (un "giro" di chat), rigenerato a ogni reload.
function makeSessionId(): string {
  const k = 'nicu_session_id'
  try {
    const existing = sessionStorage.getItem(k)
    if (existing) return existing
    const id = 'sess_' + Math.random().toString(36).slice(2) + Date.now().toString(36)
    sessionStorage.setItem(k, id)
    return id
  } catch {
    return 'sess_anon'
  }
}

let sessionId = makeSessionId()

/** Avvia una nuova sessione di log (es. quando l'utente apre una "Nuova chat"). */
export function newSession(): void {
  try { sessionStorage.removeItem('nicu_session_id') } catch { /* ignore */ }
  sessionId = makeSessionId()
}

export interface TurnLog {
  user: string
  nicu: string
  // params + stato memoria (memory ON/OFF e n. turni di storia passati al
  // modello): indispensabile per diagnosticare dai log i problemi multi-turno.
  params: GenerationParams & { memory?: boolean; turns?: number }
  backend: string
  model: string
}

// Logga un singolo scambio utente→nicu. Mai await: parte e basta.
export function logTurn(turn: TurnLog): void {
  try {
    const body = JSON.stringify({
      session: sessionId,
      user: turn.user,
      nicu: turn.nicu,
      params: turn.params,
      backend: turn.backend,
      model: turn.model,
      ua: navigator.userAgent,
    })
    // keepalive: sopravvive anche se l'utente chiude la tab subito dopo.
    fetch(ENDPOINT, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body,
      keepalive: true,
    }).catch(() => { /* silenzio */ })
  } catch {
    /* silenzio */
  }
}
