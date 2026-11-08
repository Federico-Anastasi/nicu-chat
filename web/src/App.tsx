import { useId, useState } from 'react'
import { MAX_CARATTERI, azioni, caratteri, useChat } from './lib/chat'
import { MODELLO } from './core/config'
import { leggiConsenso, salvaConsenso } from './lib/archivio'
import type { Consenso as SceltaConsenso } from './lib/archivio'
import { CONSENSO, ETICHETTA_AI, TAGLINE } from './testi'
import { Caricamento } from './ui/Caricamento'
import { Composer } from './ui/Composer'
import { Conversazione } from './ui/Conversazione'
import { IconaInfo, IconaNuovaChat } from './ui/icone'
import { InfoModal } from './ui/InfoModal'
import { Modale } from './ui/Modale'
import { NicuFace } from './ui/NicuFace'
import { Avvisi, StatoRete } from './ui/Stati'
import { useAltezzaVisibile } from './ui/viewport'

interface InAttesa {
  testo: string
  daCampo: boolean
}

function Consenso({ onScegli, onClose }: { onScegli: (v: SceltaConsenso) => void; onClose: () => void }) {
  const [maggiore, setMaggiore] = useState(false)
  const idEta = useId()
  return (
    <Modale titolo={CONSENSO.titolo} onClose={onClose}>
      <div className="modale-testo">
        {CONSENSO.righe.map(r => <p key={r}>{r}</p>)}
      </div>
      <label className="consenso-eta" htmlFor={idEta}>
        <input id={idEta} type="checkbox" checked={maggiore} onChange={e => setMaggiore(e.target.checked)} data-focus-iniziale />
        {CONSENSO.eta}
      </label>
      <div className="consenso-azioni">
        <button type="button" className="tasto tasto-grande" disabled={!maggiore} onClick={() => onScegli('si')}>{CONSENSO.conferma}</button>
        <button type="button" className="tasto-testo" disabled={!maggiore} onClick={() => onScegli('no')}>{CONSENSO.senzaSalvare}</button>
      </div>
      <p className="modale-piede">
        <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy e condizioni d'uso</a>
      </p>
    </Modale>
  )
}

export default function App() {
  const chat = useChat()
  useAltezzaVisibile()
  const [input, setInput] = useState('')
  const [infoAperta, setInfoAperta] = useState(false)
  const [consenso, setConsenso] = useState(leggiConsenso)
  const [inAttesa, setInAttesa] = useState<InAttesa | null>(null)
  const [inviato, setInviato] = useState(0)

  const invia = (testo: string, daCampo: boolean) => {
    const pulito = testo.trim()
    if (!pulito || caratteri(pulito) > MAX_CARATTERI) return
    if (!consenso) {
      setInAttesa({ testo, daCampo })
      return
    }
    if (azioni.invia(testo)) {
      if (daCampo) setInput('')
      setInviato(n => n + 1)
    }
  }

  const cambiaConsenso = (v: SceltaConsenso) => {
    salvaConsenso(v)
    setConsenso(v)
  }

  const confermaConsenso = (v: SceltaConsenso) => {
    cambiaConsenso(v)
    const pendente = inAttesa
    setInAttesa(null)
    if (pendente && azioni.invia(pendente.testo)) {
      if (pendente.daCampo) setInput('')
      setInviato(n => n + 1)
    }
  }

  if (!chat.puoiScrivere) return <Caricamento locale={chat.locale} />

  const generando = chat.fase === 'scrive' || chat.fase === 'lento'
  const vuota = chat.messaggi.length === 0

  return (
    <div className="app">
      <header className="testata">
        <div className="testata-dentro">
          <div className="marchio">
            <NicuFace umore="idle" size={40} className="marchio-volto" />
            <div className="marchio-testo">
              <h1>Nicu <span className="versione">{MODELLO.etichetta}</span></h1>
              <p>
                <span className="solo-largo">{TAGLINE} · {ETICHETTA_AI}</span>
                <span className="solo-stretto">{ETICHETTA_AI}</span>
              </p>
            </div>
          </div>
          <div className="testata-azioni">
            {!vuota && (
              <button type="button" className="tasto-icona con-etichetta" onClick={azioni.nuovaChat} aria-label="Nuova chat">
                <IconaNuovaChat />
                <span className="etichetta" aria-hidden="true">Nuova chat</span>
              </button>
            )}
            <button type="button" className="tasto-icona" onClick={() => setInfoAperta(true)} aria-label="Cos'è Nicu?">
              <IconaInfo />
            </button>
          </div>
        </div>
        <Avvisi chat={chat} />
      </header>

      <main className="principale">
        <Conversazione chat={chat} onInvia={t => invia(t, false)} onApriTelefono={() => setInfoAperta(true)} inviato={inviato} />
      </main>

      <footer className="piede">
        <div className="piede-dentro">
          <StatoRete chat={chat} />
          <Composer
            valore={input}
            onChange={setInput}
            onInvia={() => invia(input, true)}
            onStop={azioni.ferma}
            generando={generando}
            inAttesa={chat.fase === 'limite'}
            vuota={vuota}
            salvate={consenso !== 'no'}
          />
        </div>
      </footer>

      {infoAperta && <InfoModal chat={chat} consenso={consenso} onCambiaConsenso={cambiaConsenso} onClose={() => setInfoAperta(false)} />}
      {inAttesa && <Consenso onScegli={confermaConsenso} onClose={() => setInAttesa(null)} />}
    </div>
  )
}
