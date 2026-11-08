import type { StatoLocale } from '../lib/chat'
import { TAGLINE } from '../testi'
import { useBattuta } from './Attesa'
import { NicuFace } from './NicuFace'

export function Caricamento({ locale }: { locale: StatoLocale }) {
  const battuta = useBattuta()
  const inErrore = locale.fase === 'errore'
  return (
    <div className="schermata">
      <div className="scheda" role="status">
        <NicuFace umore="boh" size={104} className="scheda-volto" />
        <h1 className="scheda-titolo">Nicu</h1>
        <p className="scheda-tagline">{TAGLINE}</p>
        {inErrore ? (
          <>
            <p className="scheda-battuta">Mbare, su questo dispositivo non riesco a partire.</p>
            <button type="button" className="tasto" onClick={() => window.location.reload()}>Riprova</button>
          </>
        ) : (
          <>
            <div className="barra" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(locale.pct)} aria-label="Avanzamento">
              <div className="barra-piena" style={{ width: `${locale.pct}%` }} />
            </div>
            <p className="scheda-battuta" key={battuta}>{battuta}</p>
            <p className="scheda-nota">{locale.msg || 'Preparo Nicu…'} · si scarica una sola volta.</p>
          </>
        )}
      </div>
    </div>
  )
}
