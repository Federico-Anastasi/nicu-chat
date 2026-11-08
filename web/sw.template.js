// Service Worker scritto a mano: i tre segnaposto a doppio trattino basso li riempie il plugin di vite.config.ts a ogni build.
const CACHE_SHELL = 'nicu-shell-__BUILD__'
const CACHE_LOCALE = 'nicu-locale-ort__ORT__'
const CACHE_MODELLO = 'nicu-model-v1'
const PRECACHE = __PRECACHE__
const NAVIGAZIONE_MS = 3000

self.addEventListener('install', event => {
  event.waitUntil(
    caches.open(CACHE_SHELL).then(cache => cache.addAll(PRECACHE)).then(() => self.skipWaiting()),
  )
})

self.addEventListener('activate', event => {
  event.waitUntil(
    caches
      .keys()
      .then(nomi =>
        Promise.all(
          nomi
            .filter(n => (n.startsWith('nicu-shell-') && n !== CACHE_SHELL) || (n.startsWith('nicu-locale-') && n !== CACHE_LOCALE))
            .map(n => caches.delete(n)),
        ),
      )
      .then(() => self.clients.claim()),
  )
})

async function primaLaCache(richiesta, nome) {
  const cache = await caches.open(nome)
  const trovata = await cache.match(richiesta)
  if (trovata) return trovata
  const risposta = await fetch(richiesta)
  if (risposta.status === 200) cache.put(richiesta, risposta.clone())
  return risposta
}

async function dallaCacheDelModello(richiesta) {
  const cache = await caches.open(CACHE_MODELLO)
  return (await cache.match(richiesta)) || fetch(richiesta)
}

// Rete per prima (la pagina è sempre l'ultima versione); se manca o è lenta, la shell salvata.
async function navigazione(richiesta) {
  const salvata = () => caches.open(CACHE_SHELL).then(c => c.match('/index.html'))
  try {
    const risposta = await Promise.race([
      fetch(richiesta),
      new Promise((_, rifiuta) => setTimeout(rifiuta, NAVIGAZIONE_MS)),
    ])
    if (risposta.ok) return risposta
    return (await salvata()) || risposta
  } catch {
    return (await salvata()) || Response.error()
  }
}

self.addEventListener('fetch', event => {
  const richiesta = event.request
  if (richiesta.method !== 'GET') return
  const url = new URL(richiesta.url)
  if (url.origin !== self.location.origin) return
  const percorso = url.pathname
  if (percorso.startsWith('/api/')) return

  if (richiesta.mode === 'navigate') {
    if (percorso === '/' || percorso === '/index.html') event.respondWith(navigazione(richiesta))
  } else if (percorso.startsWith('/assets/') || PRECACHE.includes(percorso)) {
    event.respondWith(primaLaCache(richiesta, CACHE_SHELL))
  } else if (percorso.startsWith('/wasm/') || percorso.endsWith('.tokenizer.json')) {
    event.respondWith(primaLaCache(richiesta, CACHE_LOCALE))
  } else if (percorso.endsWith('.onnx')) {
    event.respondWith(dallaCacheDelModello(richiesta))
  }
})
