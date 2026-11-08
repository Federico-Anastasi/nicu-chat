import { IS_HF_SPACE } from './ambiente.ts'

// La pagina è già l'ultima versione se il suo script principale sta nella shell del Service Worker appena attivato.
async function paginaGiaAggiornata(): Promise<boolean> {
  const script = document.querySelector<HTMLScriptElement>('script[type="module"][src]')?.getAttribute('src')
  if (!script) return false
  for (const nome of (await caches.keys()).filter(n => n.startsWith('nicu-shell-'))) {
    if (await (await caches.open(nome)).match(script)) return true
  }
  return false
}

// Solo in produzione/preview. `suNuovaVersione` scatta quando un Service Worker nuovo prende il posto di uno già attivo.
export function registraServiceWorker(suNuovaVersione: () => void): void {
  if (!import.meta.env.PROD || IS_HF_SPACE || !('serviceWorker' in navigator)) return
  const giaControllata = !!navigator.serviceWorker.controller
  navigator.serviceWorker.addEventListener('controllerchange', () => {
    if (giaControllata) void paginaGiaAggiornata().then(ok => ok || suNuovaVersione(), suNuovaVersione)
  })
  window.addEventListener('load', () => {
    navigator.serviceWorker
      .register('/sw.js')
      .then(reg => {
        document.addEventListener('visibilitychange', () => {
          if (document.visibilityState === 'visible') void reg.update().catch(() => undefined)
        })
      })
      .catch(e => console.warn('[sw] registrazione fallita:', e))
  })
}
