import type { Avviso, Fase } from './lib/chat'

const mobile = /Android|iPhone|iPod|Mobile/i.test(navigator.userAgent)
const tablet = /iPad|Tablet/i.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)
export const DISPOSITIVO = tablet ? 'tablet' : mobile ? 'telefono' : 'computer'
export const SUL_DISPOSITIVO = `sul tuo ${DISPOSITIVO}`

export const SUGGERIMENTI = [
  'Come va, Nicu?',
  'Che si mangia di bello a Catania?',
  'Quanto fa 7 per 8?',
  "Com'è la festa di Sant'Agata?",
]

export const CLAIM = { inizio: 'La prima AI che ti vuole ', accento: 'felice', fine: ', non produttivo.' }
export const SOTTOCLAIM = 'Due chiacchiere, una risata, buona compagnia.'
export const TAGLINE = "l'amico catanese che ti strappa un sorriso"
export const ETICHETTA_AI = 'intelligenza artificiale'

export const BATTUTE_ATTESA = [
  'Sto accendendo la griglia…',
  'Chiamo mio cugino, un attimo…',
  "Scendo dall'Etna, arrivo…",
  'Mi metto la coppola…',
  'Sciacquo le cozze, mbare…',
  'Preparo le polpette di cavallo…',
  'Parcheggio in doppia fila…',
]

export const SOGLIA_CONTATORE = 400
export const PESO_MODELLO = 'circa 24 MB'

export const TESTI_AVVISO: Record<Avviso, string> = {
  'ripiego-telefono': `Il server è occupato o non risponde: ti ha risposto Nicu dal tuo ${DISPOSITIVO}.`,
  'ripiego-server': `${SUL_DISPOSITIVO[0].toUpperCase()}${SUL_DISPOSITIVO.slice(1)} Nicu si è impallato: ti ha risposto il server.`,
  'locale-fallito': 'Su questo dispositivo Nicu non riesce a partire: per ora ti risponde il server.',
  'modello-perso': `Nicu non è più ${SUL_DISPOSITIVO}: il browser ha fatto pulizia. Se vuoi, scaricalo di nuovo.`,
}

export const TESTO_FERMATO = 'Va bene, mi fermo.'
export const TESTO_INTERROTTA = 'Risposta interrotta.'
export const TESTO_LENTO = "Nicu sta arrivando, c'è un po' di coda…"

export type GuastoVisibile = Extract<Fase, 'pieno' | 'limite' | 'offline' | 'errore'>

export function testoGuasto(guasto: GuastoVisibile, secondi: number, scaduto: boolean): string {
  switch (guasto) {
    case 'pieno':
      return scaduto ? 'Dovrebbe esserci posto adesso: riprova.' : `C'è troppa gente da Nicu, mbare.${secondi ? ` Riprova tra ${secondi} s.` : ' Riprova fra poco.'}`
    case 'limite':
      return scaduto ? 'Ora puoi riscrivere a Nicu.' : `Piano piano, mbare! Aspetta${secondi ? ` ${secondi} s` : ' un attimo'} prima di scrivere ancora.`
    case 'offline':
      return scaduto ? 'Sei di nuovo online: riprova.' : 'Qui non prende, mbare: sei offline. Appena torna la rete, riprova.'
    default:
      return "Mbare, mi si è inceppato il cervello. Riprova, va'."
  }
}

export const CONSENSO = {
  titolo: 'Due cose, mbare',
  righe: [
    "Nicu è un'intelligenza artificiale, non una persona. A volte sbaglia o dice cose senza senso.",
    'Le nostre chiacchierate vengono salvate: servono a rendere Nicu sempre più simpatico.',
    'Per questo non scrivere dati personali, tuoi o di altri: nomi, telefoni, indirizzi, salute.',
  ],
  eta: 'Ho almeno 14 anni',
  conferma: 'Va bene, cominciamo',
  senzaSalvare: 'Chatta senza salvare',
  interruttore: 'Salva le mie chat per migliorare Nicu',
}

export const LINEA_PRIVACY = 'Le chat vengono salvate per migliorare Nicu: niente dati personali.'
export const LINEA_PRIVACY_NO = 'Le chat non vengono salvate.'
