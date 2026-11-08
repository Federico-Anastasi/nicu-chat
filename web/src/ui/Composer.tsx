import { useEffect, useRef, type KeyboardEvent } from 'react'
import { MAX_CARATTERI, caratteri } from '../lib/chat'
import { LINEA_PRIVACY, LINEA_PRIVACY_NO, SOGLIA_CONTATORE } from '../testi'
import { IconaInvia, IconaStop } from './icone'

interface Props {
  valore: string
  onChange: (v: string) => void
  onInvia: () => void
  onStop: () => void
  generando: boolean
  inAttesa: boolean
  vuota: boolean
  salvate: boolean
}

const tastieraVirtuale = () => window.matchMedia('(pointer: coarse)').matches

const tienilFocus = (e: { preventDefault: () => void }) => e.preventDefault()

export function Composer({ valore, onChange, onInvia, onStop, generando, inAttesa, vuota, salvate }: Props) {
  const campo = useRef<HTMLTextAreaElement>(null)
  const lunghezza = caratteri(valore)
  const troppoLungo = lunghezza > MAX_CARATTERI

  useEffect(() => {
    if (vuota && !tastieraVirtuale()) campo.current?.focus()
  }, [vuota])

  useEffect(() => {
    const ta = campo.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [valore])

  const tasto = (e: KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey && !e.nativeEvent.isComposing) {
      e.preventDefault()
      onInvia()
    }
  }

  return (
    <div className="composer">
      <form className="campo" onSubmit={e => { e.preventDefault(); onInvia() }}>
        <textarea
          ref={campo}
          id="messaggio"
          value={valore}
          onChange={e => onChange(e.target.value)}
          onKeyDown={tasto}
          placeholder={generando ? 'Nicu sta scrivendo…' : 'Scrivi a Nicu…'}
          aria-label="Scrivi a Nicu"
          aria-describedby="contatore privacy"
          aria-invalid={troppoLungo}
          enterKeyHint="send"
          autoComplete="off"
          rows={1}
        />
        {generando ? (
          <button type="button" className="invia" onMouseDown={tienilFocus} onClick={onStop} aria-label="Ferma Nicu">
            <IconaStop />
          </button>
        ) : (
          <button type="submit" className="invia" onMouseDown={tienilFocus} disabled={!lunghezza || troppoLungo || inAttesa} aria-label="Invia">
            <IconaInvia />
          </button>
        )}
      </form>
      <p id="contatore" className={`contatore${troppoLungo ? ' troppo' : ''}`} hidden={lunghezza < SOGLIA_CONTATORE} role={troppoLungo ? 'alert' : undefined}>
        {troppoLungo ? `Troppo lungo, mbare: massimo ${MAX_CARATTERI} caratteri. ` : ''}
        {lunghezza}/{MAX_CARATTERI}
      </p>
      <p id="privacy" className="privacy">
        {salvate ? LINEA_PRIVACY : LINEA_PRIVACY_NO} <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a>
      </p>
    </div>
  )
}
