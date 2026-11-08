import { useEffect, useState } from 'react'

export function useSecondi(scadenza: number | null): number {
  const [ora, setOra] = useState(() => Date.now())
  useEffect(() => {
    if (scadenza === null) return
    setOra(Date.now())
    const t = setInterval(() => setOra(Date.now()), 500)
    return () => clearInterval(t)
  }, [scadenza])
  return scadenza === null ? 0 : Math.max(0, Math.ceil((scadenza - ora) / 1000))
}

export function useDopo(attivo: boolean, ms: number): boolean {
  const [scaduto, setScaduto] = useState(false)
  useEffect(() => {
    if (!attivo) {
      setScaduto(false)
      return
    }
    const t = setTimeout(() => setScaduto(true), ms)
    return () => clearTimeout(t)
  }, [attivo, ms])
  return attivo && scaduto
}
