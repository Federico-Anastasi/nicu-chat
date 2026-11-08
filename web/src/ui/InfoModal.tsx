import { useState } from 'react'
import { PARAMETRI_DEFAULT } from '../core/config.ts'
import { azioni } from '../lib/chat'
import type { StatoChat } from '../lib/chat'
import type { Consenso } from '../lib/archivio'
import { CONSENSO, DISPOSITIVO, PESO_MODELLO, SUL_DISPOSITIVO } from '../testi'
import { Avanzamento } from './Attesa'
import { IconaComputer, IconaFreccia, IconaNuvola, IconaTablet, IconaTelefono } from './icone'
import { Modale } from './Modale'

const LINK = [
  { etichetta: 'TikTok', href: 'https://www.tiktok.com/@federico_anastasi' },
  { etichetta: 'GitHub', href: 'https://github.com/Federico-Anastasi/nicu-chat' },
  { etichetta: 'Hugging Face', href: 'https://huggingface.co/federico-anastasi/nicu-20m' },
  { etichetta: 'X', href: 'https://x.com/FedeAnastasi' },
]

const IconaDispositivo = DISPOSITIVO === 'computer' ? IconaComputer : DISPOSITIVO === 'tablet' ? IconaTablet : IconaTelefono

const reteMobile = () => {
  const c = (navigator as Navigator & { connection?: { type?: string; saveData?: boolean } }).connection
  return c?.type === 'cellular' || c?.saveData === true
}

const suIphone = () =>
  (/iPhone|iPad|iPod/.test(navigator.userAgent) || (navigator.platform === 'MacIntel' && navigator.maxTouchPoints > 1)) &&
  !window.matchMedia('(display-mode: standalone)').matches &&
  !(navigator as Navigator & { standalone?: boolean }).standalone

function DoveVive({ chat }: { chat: StatoChat }) {
  const [conferma, setConferma] = useState(false)
  if (!chat.serverDisponibile) return null
  const { locale } = chat
  const inCorso = locale.fase === 'scarica' || locale.fase === 'avvio'
  const sulTelefono = chat.modalita === 'telefono'
  const daScaricare = locale.fase === 'assente' || locale.fase === 'errore'

  const scegliTelefono = () => {
    if (sulTelefono) return
    if (daScaricare && reteMobile()) setConferma(true)
    else azioni.scegliModalita('telefono')
  }
  const scegliOnline = () => {
    setConferma(false)
    azioni.scegliModalita('server')
  }

  return (
    <section className="sezione" aria-labelledby="dove-vive">
      <h3 id="dove-vive">Dove vive Nicu</h3>
      <div className="scelta" role="group" aria-labelledby="dove-vive">
        <button type="button" aria-pressed={!sulTelefono} onClick={scegliOnline}>
          <IconaNuvola />
          Online
        </button>
        <button type="button" aria-pressed={sulTelefono} onClick={scegliTelefono}>
          <IconaDispositivo />
          {SUL_DISPOSITIVO[0].toUpperCase() + SUL_DISPOSITIVO.slice(1)}
        </button>
      </div>

      {conferma && (
        <div className="conferma" role="group" aria-label="Conferma il download">
          <p>Sei sulla rete mobile: il download pesa {PESO_MODELLO}. Lo scarico lo stesso?</p>
          <div className="conferma-azioni">
            <button type="button" className="tasto" onClick={() => { setConferma(false); azioni.scegliModalita('telefono') }}>Scarica</button>
            <button type="button" className="tasto-testo" onClick={() => setConferma(false)}>Annulla</button>
          </div>
        </div>
      )}

      {inCorso && sulTelefono && <Avanzamento pct={locale.pct} messaggio={locale.msg} onAnnulla={scegliOnline} />}

      {!inCorso && !conferma && (
        <div className="nota">
          {sulTelefono && locale.fase === 'pronto' && (
            <>
              <p>Nicu è {SUL_DISPOSITIVO} e ti risponde da lì, anche senza connessione, finché il browser conserva i dati del sito.</p>
              {suIphone() && <p>Su iPhone, per non perderlo, aggiungi Nicu alla schermata Home dal menu di condivisione di Safari.</p>}
            </>
          )}
          {sulTelefono && locale.fase !== 'pronto' && <p>Preparo Nicu {SUL_DISPOSITIVO}…</p>}
          {!sulTelefono && locale.fase === 'errore' && (
            <>
              <p>Su questo dispositivo Nicu non è riuscito a partire: per ora ti risponde il server.</p>
              <button type="button" className="tasto-testo" onClick={scegliTelefono}>Riprova</button>
            </>
          )}
          {!sulTelefono && (locale.fase === 'scaricato' || locale.fase === 'pronto') && <p>Nicu è già {SUL_DISPOSITIVO}: sceglilo qui sopra per averlo anche senza connessione.</p>}
          {!sulTelefono && daScaricare && locale.fase !== 'errore' && (
            <p>Ora ti risponde dal nostro server e serve la connessione. Se lo porti {SUL_DISPOSITIVO} ({PESO_MODELLO}, si scarica una volta sola) risponde anche offline.</p>
          )}
        </div>
      )}
    </section>
  )
}

const CONTROLLI = [
  { chiave: 'temperature', etichetta: 'Fantasia', nota: 'temperatura', min: 0.5, max: 1.5, passo: 0.05, decimali: 2 },
  { chiave: 'topP', etichetta: 'Varietà delle parole', nota: 'top-p', min: 0.5, max: 1, passo: 0.01, decimali: 2 },
  { chiave: 'repPenalty', etichetta: 'Anti-ripetizione', nota: 'penalità di ripetizione', min: 1, max: 1.5, passo: 0.05, decimali: 2 },
  { chiave: 'maxNew', etichetta: 'Lunghezza massima', nota: 'token', min: 20, max: 200, passo: 10, decimali: 0 },
] as const

function Curiosi({ chat }: { chat: StatoChat }) {
  const [aperto, setAperto] = useState(false)
  return (
    <section className="sezione" aria-labelledby="curiosi">
      <h3 id="curiosi">
        <button type="button" className="curiosi-tasto" onClick={() => setAperto(a => !a)} aria-expanded={aperto} aria-controls="curiosi-corpo">
          Per i curiosi
          <IconaFreccia aperta={aperto} />
        </button>
      </h3>
      {aperto && (
        <div id="curiosi-corpo" className="curiosi-corpo">
          <p>Qui sotto puoi cambiargli un po' il carattere.</p>
          {CONTROLLI.map(c => {
            const valore = chat.params[c.chiave]
            return (
              <div className="controllo" key={c.chiave}>
                <label htmlFor={`p-${c.chiave}`}>
                  <span>{c.etichetta} <small>{c.nota}</small></span>
                  <output htmlFor={`p-${c.chiave}`}>{valore.toFixed(c.decimali)}</output>
                </label>
                <input
                  id={`p-${c.chiave}`}
                  type="range"
                  min={c.min}
                  max={c.max}
                  step={c.passo}
                  value={valore}
                  onChange={e => azioni.impostaParametri({ ...chat.params, [c.chiave]: parseFloat(e.target.value) })}
                />
              </div>
            )
          })}
          <label className="controllo-memoria">
            <input type="checkbox" checked={chat.memoria} onChange={e => azioni.impostaMemoria(e.target.checked)} />
            Ricorda gli ultimi scambi della conversazione
          </label>
          <button
            type="button"
            className="tasto-testo"
            onClick={() => { azioni.impostaParametri({ ...PARAMETRI_DEFAULT }); azioni.impostaMemoria(true) }}
          >
            Ripristina
          </button>
        </div>
      )}
    </section>
  )
}

interface PropsInfo {
  chat: StatoChat
  consenso: Consenso | null
  onCambiaConsenso: (v: Consenso) => void
  onClose: () => void
}

export function InfoModal({ chat, consenso, onCambiaConsenso, onClose }: PropsInfo) {
  return (
    <Modale titolo="Cos'è Nicu?" onClose={onClose}>
      <div className="modale-testo">
        <p>
          Nicu è un <strong>amico catanese</strong>: ci fai due chiacchiere e ti strappa un sorriso. Qui non si lavora, si ride.
        </p>
        <p>
          Il suo mondo è piccolo: Catania, il mare, la griglia, gli amici. Se gli chiedi qualcosa che non conosce non s'inventa
          niente, ti svicola con una battuta. Prova a chiedergli quanto fa 7 per 8.
        </p>
      </div>
      <DoveVive chat={chat} />
      <Curiosi chat={chat} />
      <section className="sezione firma" aria-label="Chi ha fatto Nicu">
        <p className="firma-testo">
          Ciao, sono Federico: Nicu l'ho costruito io, da zero. È un modello piccolo, circa 20 milioni di parametri e
          24 MB, addestrato solo sui suoi dialoghi.
        </p>
        <p className="link-curiosi">
          Mi trovi su{' '}
          {LINK.map((l, i) => (
            <span key={l.etichetta}>
              {i > 0 && ' · '}
              <a href={l.href} target="_blank" rel="noopener noreferrer">{l.etichetta}</a>
            </span>
          ))}
        </p>
        {consenso && (
          <label className="controllo-memoria">
            <input type="checkbox" checked={consenso === 'si'} onChange={e => onCambiaConsenso(e.target.checked ? 'si' : 'no')} />
            {CONSENSO.interruttore}
          </label>
        )}
        <p className="link-curiosi">
          <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy e condizioni d'uso</a>
        </p>
      </section>
    </Modale>
  )
}
