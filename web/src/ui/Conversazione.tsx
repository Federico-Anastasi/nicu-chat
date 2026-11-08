import { useEffect, useRef, useState } from 'react'
import { MODELLO } from '../core/config'
import { IS_HF_SPACE } from '../lib/ambiente'
import { azioni } from '../lib/chat'
import type { Messaggio, StatoChat } from '../lib/chat'
import { shareExchange } from '../lib/share'
import {
  CLAIM, SOTTOCLAIM, SUGGERIMENTI, SUL_DISPOSITIVO, TESTO_FERMATO, TESTO_INTERROTTA, TESTO_LENTO, testoGuasto,
  type GuastoVisibile,
} from '../testi'
import { IconaCondividi, IconaGiu, IconaOk } from './icone'
import { NicuFace } from './NicuFace'
import { useDopo, useSecondi } from './tempo'

const RITARDO_PUNTINI_MS = 300
const GUASTI: GuastoVisibile[] = ['pieno', 'limite', 'offline', 'errore']
const VICINO_AL_FONDO = 80

const riduciMovimento = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches

type EsitoCondivisione = 'idle' | 'busy' | 'shared' | 'downloaded' | 'error'
const ETICHETTA_CONDIVISIONE: Record<Exclude<EsitoCondivisione, 'idle'>, string> = {
  busy: 'Preparo…',
  shared: 'Immagine pronta',
  downloaded: 'Salvata',
  error: 'Non ci sono riuscito',
}

function Condividi({ domanda, risposta }: { domanda: string; risposta: string }) {
  const [esito, setEsito] = useState<EsitoCondivisione>('idle')
  const timer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined)
  useEffect(() => () => clearTimeout(timer.current), [])

  const onClick = async () => {
    if (esito === 'busy') return
    clearTimeout(timer.current)
    setEsito('busy')
    const r = await shareExchange(domanda, risposta)
    setEsito(r === 'annullato' ? 'idle' : r)
    if (r !== 'annullato') timer.current = setTimeout(() => setEsito('idle'), 2800)
  }

  return (
    <button type="button" className="condividi" onClick={onClick} disabled={esito === 'busy'}>
      {esito === 'shared' || esito === 'downloaded' ? <IconaOk /> : <IconaCondividi />}
      <span aria-live="polite">{esito === 'idle' ? 'Condividi' : ETICHETTA_CONDIVISIONE[esito]}</span>
    </button>
  )
}

function Puntini() {
  return (
    <div className="bolla bolla-nicu puntini" aria-hidden="true">
      <span /><span /><span />
    </div>
  )
}

interface BollaProps {
  messaggio: Messaggio
  domanda?: string
  ultimo: boolean
  chat: StatoChat
  guasto: GuastoVisibile | null
  secondi: number
  onApriTelefono: () => void
}

function Bolla({ messaggio, domanda, ultimo, chat, guasto, secondi, onApriTelefono }: BollaProps) {
  const nicu = messaggio.role === 'nicu'
  const scrive = messaggio.stato === 'scrive'
  const fallita = messaggio.stato === 'errore' || messaggio.stato === 'interrotto'
  const attesa = nicu && scrive && !messaggio.text
  const mostraPuntini = useDopo(attesa, RITARDO_PUNTINI_MS)
  if (attesa && !mostraPuntini) return null

  const guastoAttivo = ultimo && messaggio.stato === 'errore' ? guasto ?? 'errore' : null
  const scaduto = guastoAttivo !== null && !GUASTI.includes(chat.fase as GuastoVisibile)
  const testoFallita = messaggio.stato === 'errore'
    ? testoGuasto(guastoAttivo ?? 'errore', secondi, scaduto)
    : TESTO_FERMATO
  const testo = messaggio.text || (fallita ? testoFallita : '')
  const nota = fallita && messaggio.text ? (ultimo ? testoFallita : TESTO_INTERROTTA) : ''
  const notaFissa = guastoAttivo ? testoGuasto(guastoAttivo, 0, scaduto) : nota
  const puoRiprovare = ultimo && fallita && chat.puoiRiprovare
  const attendeLimite = guastoAttivo === 'limite' && !scaduto
  const condividi = nicu && !!domanda && messaggio.stato === 'ok' && !!messaggio.text

  return (
    <div className={`riga ${nicu ? 'riga-nicu' : 'riga-utente'}`}>
      {nicu && <NicuFace umore="idle" size={36} className="avatar" />}
      <div className="colonna">
        <span className="sr">{nicu ? 'Nicu' : 'Tu'}:</span>
        {attesa ? (
          <>
            <Puntini />
            {chat.fase === 'lento' && (
              <p className="stato-lento" role="status">
                {TESTO_LENTO}
                <button type="button" className="tasto-testo" onClick={azioni.ferma}>Stop</button>
              </p>
            )}
          </>
        ) : (
          <div
            className={`bolla ${nicu ? 'bolla-nicu' : 'bolla-utente'}${fallita && !messaggio.text ? ' bolla-errore' : ''}`}
            data-ai-generated={nicu && messaggio.text ? 'true' : undefined}
            data-ai-model={nicu && messaggio.text ? MODELLO.id : undefined}
          >
            {guastoAttivo && !messaggio.text ? (
              <>
                <span aria-hidden="true">{testo}</span>
                <span className="sr">{notaFissa}</span>
              </>
            ) : testo}
            {scrive && <span className="cursore" aria-hidden="true" />}
          </div>
        )}
        {nota && (
          <p className="esito">
            <span aria-hidden={!!guastoAttivo}>{nota}</span>
            {guastoAttivo && <span className="sr">{notaFissa}</span>}
          </p>
        )}
        {condividi && <Condividi domanda={domanda!} risposta={messaggio.text} />}
        {puoRiprovare && (
          <div className="azioni-bolla">
            <button type="button" className="tasto" onClick={azioni.riprova} disabled={attendeLimite} aria-label="Riprova">
              <span aria-hidden="true">{attendeLimite ? `Riprova tra ${secondi} s` : 'Riprova'}</span>
            </button>
            {chat.offertaTelefono && (
              <button type="button" className="tasto-testo" onClick={onApriTelefono}>Portalo {SUL_DISPOSITIVO}</button>
            )}
          </div>
        )}
      </div>
    </div>
  )
}

interface Props {
  chat: StatoChat
  onInvia: (testo: string) => void
  onApriTelefono: () => void
  inviato: number
}

export function Conversazione({ chat, onInvia, onApriTelefono, inviato }: Props) {
  const area = useRef<HTMLDivElement>(null)
  const contenuto = useRef<HTMLDivElement>(null)
  const fissato = useRef(chat.messaggi.length > 0)
  const ultimaPosizione = useRef(0)
  const [inFondo, setInFondo] = useState(true)
  const secondi = useSecondi(chat.riprovaAlle)
  const guasto = useRef<GuastoVisibile | null>(null)
  const vuota = chat.messaggi.length === 0
  const ultimo = chat.messaggi[chat.messaggi.length - 1]
  const generando = chat.fase === 'scrive' || chat.fase === 'lento'

  if (GUASTI.includes(chat.fase as GuastoVisibile)) guasto.current = chat.fase as GuastoVisibile
  else if (ultimo?.stato !== 'errore') guasto.current = null

  const vaInFondo = (morbido: boolean) => {
    area.current?.scrollTo({ top: area.current.scrollHeight, behavior: morbido && !riduciMovimento() ? 'smooth' : 'instant' })
  }

  useEffect(() => {
    const a = area.current
    const c = contenuto.current
    if (!a || !c) return
    const osservatore = new ResizeObserver(() => {
      if (!fissato.current) return
      vaInFondo(false)
      setInFondo(true)
    })
    osservatore.observe(c)
    osservatore.observe(a)
    return () => osservatore.disconnect()
  }, [])

  useEffect(() => {
    if (inviato === 0) return
    fissato.current = true
    vaInFondo(false)
  }, [inviato])

  useEffect(() => {
    if (!vuota) {
      fissato.current = true
      return
    }
    fissato.current = false
    area.current?.scrollTo({ top: 0, behavior: 'instant' })
  }, [vuota])

  const alScorrimento = () => {
    const a = area.current
    if (!a) return
    const vicino = a.scrollHeight - a.scrollTop - a.clientHeight < VICINO_AL_FONDO
    const risale = a.scrollTop < ultimaPosizione.current - 2
    ultimaPosizione.current = a.scrollTop
    if (vicino) fissato.current = true
    else if (risale) fissato.current = false
    setInFondo(vicino)
  }

  return (
    <div className="chat-wrap">
      <div className="chat-area" ref={area} onScroll={alScorrimento}>
        <div className={`contenuto${vuota ? ' vuota' : ''}`} ref={contenuto}>
          {vuota && (
            <header className="hero">
              <NicuFace umore="happy" size={96} className="hero-volto" />
              <h2 className="hero-titolo">
                {CLAIM.inizio}<span className="accento">{CLAIM.accento}</span>{CLAIM.fine}
              </h2>
              <p className="hero-sotto">{SOTTOCLAIM}</p>
              {IS_HF_SPACE && <p className="hero-lingua">Nicu only speaks Italian: try «Come va, Nicu?»</p>}
            </header>
          )}

          <div className="messaggi" role="log" aria-live="polite" aria-relevant="additions text" aria-label="Conversazione con Nicu" aria-busy={generando}>
            {chat.messaggi.map((m, i) => (
              <Bolla
                key={m.id}
                messaggio={m}
                domanda={i > 0 && chat.messaggi[i - 1].role === 'user' ? chat.messaggi[i - 1].text : undefined}
                ultimo={i === chat.messaggi.length - 1}
                chat={chat}
                guasto={guasto.current}
                secondi={secondi}
                onApriTelefono={onApriTelefono}
              />
            ))}
          </div>

          {vuota && (
            <div className="suggerimenti">
              {SUGGERIMENTI.map(s => (
                <button key={s} type="button" className="suggerimento" onClick={() => onInvia(s)}>{s}</button>
              ))}
            </div>
          )}
        </div>
      </div>
      {!vuota && !inFondo && (
        <button type="button" className="vai-giu" onClick={() => { fissato.current = true; vaInFondo(true) }} aria-label="Vai in fondo alla chat">
          <IconaGiu />
        </button>
      )}
    </div>
  )
}
