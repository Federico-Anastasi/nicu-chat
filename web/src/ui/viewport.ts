import { useEffect } from 'react'

// Sulle tastiere che non ridimensionano la pagina (iOS) l'app segue l'area visibile, così il campo non resta coperto.
export function useAltezzaVisibile() {
  useEffect(() => {
    const vv = window.visualViewport
    if (!vv) return
    const radice = document.documentElement
    const aggiorna = () => {
      if (vv.scale > 1.01) return
      radice.style.setProperty('--altezza-app', `${Math.round(vv.height)}px`)
      radice.style.setProperty('--scarto-app', `${Math.round(vv.offsetTop)}px`)
      if (vv.offsetTop > 0) window.scrollTo(0, 0)
    }
    aggiorna()
    vv.addEventListener('resize', aggiorna)
    window.addEventListener('resize', aggiorna)
    vv.addEventListener('scroll', aggiorna)
    return () => {
      vv.removeEventListener('resize', aggiorna)
      window.removeEventListener('resize', aggiorna)
      vv.removeEventListener('scroll', aggiorna)
      radice.style.removeProperty('--altezza-app')
      radice.style.removeProperty('--scarto-app')
    }
  }, [])
}
