import { useEffect, useState } from 'react'
import { BATTUTE_ATTESA } from '../testi'

export function useBattuta() {
  const [i, setI] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setI(n => (n + 1) % BATTUTE_ATTESA.length), 2400)
    return () => clearInterval(t)
  }, [])
  return BATTUTE_ATTESA[i]
}

export function Avanzamento({ pct, messaggio, onAnnulla }: { pct: number; messaggio: string; onAnnulla?: () => void }) {
  const battuta = useBattuta()
  return (
    <div className="avanzamento" role="status">
      <div className="barra" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(pct)} aria-label="Avanzamento">
        <div className="barra-piena" style={{ width: `${pct}%` }} />
      </div>
      <p className="avanzamento-msg">{messaggio || 'Preparo…'}</p>
      <p className="avanzamento-battuta" key={battuta}>{battuta}</p>
      {onAnnulla && <button type="button" className="tasto-testo" onClick={onAnnulla}>Annulla</button>}
    </div>
  )
}
