/**
 * prompt.ts — costruzione del prompt del nano: canon PINNATO + finestra di chat che scorre.
 *
 * ⭐ Regola d'oro: il dataset di training deve avere la forma ESATTA di ciò che si costruisce qui.
 *    Un campo visto in training in una forma e in produzione in un'altra è un campo mai visto — è
 *    così che si è rotto il canale `[utente:]` (nome ripreso 4,7%).
 *
 * Le due parti NON sono la stessa cosa e non vanno concatenate alla cieca:
 *
 *   [canon]   nota di sistema · PINNATA · mai troncata · non è un turno di chat
 *   [chat]    finestra che SCORRE nello spazio che resta
 *   Nicu:     ← il prompt finisce qui
 *
 * ⚠️ Il bug che questo modulo esiste per togliere: `ids.slice(-BLOCK_SIZE)` sull'intera stringa
 *    tronca DAL FONDO, quindi appena il prompt supera i 512 token butta via per primo il canon,
 *    che sta in testa. La troncatura deve agire solo sulla chat.
 */

import { MODELLO } from './config.ts'

/** I campi del canon. Tutti opzionali: a runtime il nome si conosce solo dopo che è stato detto. */
export interface Canon {
  stagione?: string
  momento?: string
  nome?: string
  fatti?: string[]
}

export interface TurnoChat {
  user: string
  nicu: string
}

/** Contesto del modello servito. */
export const BLOCK_SIZE = MODELLO.blocco

/**
 * Token riservati alla risposta. È il **p99 misurato** delle battute di Nicu
 * (corpus v11: mediana 24-28 · p95 41-46 · p99 55), non il `maxNew` nominale: `maxNew = 200` è un tetto di
 * sicurezza contro i loop, usarlo come riserva sprecherebbe ~150 token di contesto.
 */
export const RISERVA_OUTPUT = MODELLO.riservaOutput

/**
 * Cap sui turni, OLTRE al budget in token. È una proprietà **del modello servito**, misurata con
 * un confronto A/B sulla finestra: il v10 peggiorava oltre 3 turni, v11 no (cap tolto).
 * `null` = nessun cap, comanda solo il budget in token.
 */
export const MAX_HISTORY_TURNS: number | null = MODELLO.maxTurniStoria

/**
 * Il canon è servito al modello solo se il modello è stato ADDESTRATO col canon.
 * ⚠️ Nessun nano servito finora lo è: attivarlo qui gli metterebbe davanti proprio il
 *    "campo mai visto" che stiamo cercando di evitare. Si accende insieme al modello che lo capisce.
 */
export const CANON_ATTIVO: boolean = MODELLO.canonAttivo

/**
 * La riga di canon, nella forma canonica UNICA.
 * Stringa vuota se non c'è nessun campo: un canon vuoto non deve produrre righe vuote nel prompt.
 *
 * ⚠️ `[scambi: N]` NON compare qui: è un campo del GENERATORE (gli si chiede di produrre N scambi),
 *    mentre il nano risponde un turno per volta.
 */
export function formattaCanon(canon?: Canon | null): string {
  if (!canon) return ''
  let out = ''

  const mondo = [canon.stagione, canon.momento].filter(Boolean)
  if (mondo.length) out += `[mondo: ${mondo.join(' · ')}]\n`

  const utente = [canon.nome, ...(canon.fatti ?? [])].filter(Boolean)
  if (utente.length) out += `[utente: ${utente.join(', ')}]\n`

  return out
}

export interface PromptCostruito {
  /** Il prompt completo, canon incluso. */
  testo: string
  /** Quanti token occupa il canon in testa: sono i token da PROTEGGERE dalla troncatura. */
  tokenCanon: number
  /** Quanti scambi della storia sono entrati nella finestra (diagnostica). */
  turniTenuti: number
}

/**
 * Costruisce il prompt: canon pinnato + gli scambi più recenti che entrano nel budget.
 *
 * La finestra si CALCOLA, non si decide: `BLOCK_SIZE − |canon| − RISERVA_OUTPUT − |turno corrente|`.
 * Si tengono scambi **interi**, dal più recente all'indietro: mezzo scambio non entra, perché a
 * runtime un "Nicu:" senza il suo "Utente:" non si presenta mai.
 */
export function costruisciPrompt(
  userMsg: string,
  history: TurnoChat[],
  encode: (s: string) => number[],
  canon?: Canon | null
): PromptCostruito {
  const testaCanon = CANON_ATTIVO ? formattaCanon(canon) : ''
  const tokenCanon = testaCanon ? encode(testaCanon).length : 0

  const coda = `Utente: ${userMsg}\nNicu:`
  const budget = BLOCK_SIZE - tokenCanon - RISERVA_OUTPUT - encode(coda).length

  // Dal più recente all'indietro: si accumula finché lo scambio INTERO ci sta.
  const candidati = MAX_HISTORY_TURNS === null ? history : history.slice(-MAX_HISTORY_TURNS)
  const tenuti: string[] = []
  let usati = 0
  for (let i = candidati.length - 1; i >= 0; i--) {
    const scambio = `Utente: ${candidati[i].user}\nNicu: ${candidati[i].nicu}\n`
    const costo = encode(scambio).length
    if (usati + costo > budget) break
    tenuti.unshift(scambio)
    usati += costo
  }

  return {
    testo: testaCanon + tenuti.join('') + coda,
    tokenCanon,
    turniTenuti: tenuti.length,
  }
}

/**
 * Troncatura DURANTE la generazione, quando prompt + token generati superano il contesto.
 *
 * ⚠️ Non è `ids.slice(-BLOCK_SIZE)`: quello butterebbe via il canon, che sta in testa. Il canon si
 *    tiene sempre e si taglia dalla chat, che è ciò che a runtime scorre davvero.
 */
export function troncaPreservandoCanon(ids: number[], tokenCanon: number): number[] {
  if (ids.length <= BLOCK_SIZE) return ids

  // ⚠️ Clamp obbligatorio: con `n = BLOCK_SIZE - tokenCanon` uguale a 0, `slice(-0)` in JS è
  //    `slice(0)` — restituisce TUTTO invece di niente, e la sequenza uscirebbe dal block_size.
  //    Un canon che si mangia il contesto è comunque un bug a monte, ma qui non deve propagarsi.
  const nCanon = Math.max(0, Math.min(tokenCanon, BLOCK_SIZE - 1))
  if (nCanon === 0) return ids.slice(-BLOCK_SIZE)

  const testa = ids.slice(0, nCanon)
  const coda = ids.slice(nCanon).slice(-(BLOCK_SIZE - nCanon))
  return [...testa, ...coda]
}
