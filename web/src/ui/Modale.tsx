import { useEffect, useId, useRef, type ReactNode } from 'react'
import { IconaChiudi } from './icone'
import { NicuFace } from './NicuFace'

const FOCALIZZABILI = 'a[href], button:not([disabled]), input:not([disabled]), textarea:not([disabled]), [tabindex]:not([tabindex="-1"])'

interface Props {
  titolo: string
  onClose: () => void
  children: ReactNode
  chiudi?: boolean
}

export function Modale({ titolo, onClose, children, chiudi = true }: Props) {
  const idTitolo = useId()
  const foglio = useRef<HTMLDivElement>(null)
  const chiudiRef = useRef(onClose)
  chiudiRef.current = onClose

  useEffect(() => {
    const precedente = document.activeElement as HTMLElement | null
    const elementi = () => [...(foglio.current?.querySelectorAll<HTMLElement>(FOCALIZZABILI) ?? [])]
    const primo = foglio.current?.querySelector<HTMLElement>('[data-focus-iniziale]') ?? elementi()[0] ?? foglio.current
    primo?.focus()

    const tasto = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation()
        chiudiRef.current()
        return
      }
      if (e.key !== 'Tab') return
      const lista = elementi()
      if (!lista.length) return
      const prima = lista[0]
      const ultima = lista[lista.length - 1]
      const attivo = document.activeElement
      if (!foglio.current?.contains(attivo)) {
        e.preventDefault()
        prima.focus()
      } else if (e.shiftKey && attivo === prima) {
        e.preventDefault()
        ultima.focus()
      } else if (!e.shiftKey && attivo === ultima) {
        e.preventDefault()
        prima.focus()
      }
    }
    document.addEventListener('keydown', tasto, true)
    return () => {
      document.removeEventListener('keydown', tasto, true)
      if (precedente?.isConnected) precedente.focus()
    }
  }, [])

  return (
    <div className="modale-sfondo" onMouseDown={e => { if (e.target === e.currentTarget) onClose() }}>
      <div className="modale" ref={foglio} role="dialog" aria-modal="true" aria-labelledby={idTitolo} tabIndex={-1}>
        {chiudi && (
          <button type="button" className="modale-chiudi" onClick={onClose} aria-label="Chiudi">
            <IconaChiudi />
          </button>
        )}
        <div className="modale-corpo">
          <div className="modale-testa">
            <NicuFace umore="happy" size={44} className="modale-volto" />
            <h2 className="modale-titolo" id={idTitolo}>{titolo}</h2>
          </div>
          {children}
        </div>
      </div>
    </div>
  )
}
