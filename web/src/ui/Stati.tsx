import { azioni } from '../lib/chat'
import type { StatoChat } from '../lib/chat'
import { SUL_DISPOSITIVO, TESTI_AVVISO } from '../testi'
import { IconaChiudi } from './icone'

interface Toast {
  chiave: string
  testo: string
  azione?: { etichetta: string; onClick: () => void }
  chiudi?: () => void
}

export function Avvisi({ chat }: { chat: StatoChat }) {
  const toast: Toast[] = []
  if (chat.nuovaVersione) {
    toast.push({ chiave: 'versione', testo: "C'è una versione nuova di Nicu.", azione: { etichetta: 'Aggiorna', onClick: azioni.aggiornaApp } })
  }
  if (chat.annullaFino) {
    toast.push({ chiave: 'annulla', testo: 'Chat cancellata', azione: { etichetta: 'Annulla', onClick: azioni.annullaNuovaChat } })
  }
  if (chat.avviso) {
    toast.push({ chiave: 'avviso', testo: TESTI_AVVISO[chat.avviso], chiudi: azioni.chiudiAvviso })
  }
  if (!toast.length) return null
  return (
    <div className="avvisi">
      {toast.map(t => (
        <div className="toast" role="status" key={t.chiave}>
          <span>{t.testo}</span>
          {t.azione && <button type="button" className="tasto" onClick={t.azione.onClick}>{t.azione.etichetta}</button>}
          {t.chiudi && (
            <button type="button" className="toast-chiudi" onClick={t.chiudi} aria-label="Chiudi l'avviso">
              <IconaChiudi />
            </button>
          )}
        </div>
      ))}
    </div>
  )
}

export function StatoRete({ chat }: { chat: StatoChat }) {
  const { locale } = chat
  const scarica = chat.modalita === 'telefono' && (locale.fase === 'scarica' || locale.fase === 'avvio')
  const offline = !chat.online
  if (!scarica && !offline) return null
  return (
    <div className="stato-rete">
      {offline && (
        <p className="banner" role="status">
          {chat.motore === 'wasm' ? `Sei offline, ma Nicu è ${SUL_DISPOSITIVO}: puoi continuare a scrivergli.` : 'Sei offline: per parlare con Nicu serve la connessione.'}
        </p>
      )}
      {scarica && (
        <div className="banner banner-download" role="status">
          <div className="barra" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(locale.pct)} aria-label="Download di Nicu">
            <div className="barra-piena" style={{ width: `${locale.pct}%` }} />
          </div>
          <span>{locale.msg || `Porto Nicu ${SUL_DISPOSITIVO}…`}</span>
          <button type="button" className="tasto-testo" onClick={() => azioni.scegliModalita('server')}>Annulla</button>
        </div>
      )}
    </div>
  )
}
