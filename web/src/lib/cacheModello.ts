import { urlModello } from '../core/config.ts'

export type Avanzamento = (pct: number, msg: string) => void

export const CACHE_MODELLO = 'nicu-model-v1'
const PESO_ATTESO = 24_000_000
const WASM_ATTESO = 10_000_000

const PROVA_SIMD = [
  0, 97, 115, 109, 1, 0, 0, 0, 1, 4, 1, 96, 0, 0, 3, 2, 1, 0, 10, 30, 1, 28, 0, 65, 0, 253, 15, 253, 12, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 253, 186, 1, 26, 11,
]

export async function modelloInCache(): Promise<boolean> {
  try {
    const cache = await caches.open(CACHE_MODELLO)
    return !!((await cache.match(urlModello(true))) || (await cache.match(urlModello(false))))
  } catch {
    return false
  }
}

async function leggiCorpo(resp: Response, atteso: number, avanza: (ricevuti: number, totale: number) => void): Promise<ArrayBuffer> {
  const lunghezza = parseInt(resp.headers.get('content-length') ?? '')
  const totale = lunghezza > 0 ? lunghezza : atteso
  const reader = resp.body!.getReader()
  const pezzi: Uint8Array[] = []
  let ricevuti = 0
  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    pezzi.push(value)
    ricevuti += value.byteLength
    avanza(ricevuti, totale)
  }
  const buf = new Uint8Array(ricevuti)
  let off = 0
  for (const p of pezzi) {
    buf.set(p, off)
    off += p.byteLength
  }
  return buf.buffer
}

const mb = (n: number) => (n / 1_000_000).toFixed(1)

export async function scaricaModello(url: string, avanza: Avanzamento): Promise<ArrayBuffer> {
  try {
    let resp: Response
    let daCache = false
    let salvataggio: Promise<void> = Promise.resolve()
    try {
      const cache = await caches.open(CACHE_MODELLO)
      const hit = await cache.match(url)
      if (hit) {
        resp = hit
        daCache = true
      } else {
        const net = await fetch(url)
        if (!net.ok) throw new Error(`HTTP ${net.status}`)
        salvataggio = cache.put(url, net.clone()).catch(() => undefined)
        resp = net
      }
    } catch {
      resp = await fetch(url)
      if (!resp.ok) throw new Error(`HTTP ${resp.status}`)
    }

    if (daCache) avanza(10, 'Carico Nicu dalla cache… (già scaricato)')
    const corpo = await leggiCorpo(resp, PESO_ATTESO, (r, t) =>
      avanza(Math.min(90, Math.round((r / t) * 90)), `Scarico Nicu… ${mb(r)} / ${mb(t)} MB`),
    )
    await salvataggio
    return corpo
  } catch (e) {
    throw new Error(`Impossibile scaricare il modello: ${e}`)
  }
}

// Il WASM (~10 MB) si scarica qui, con avanzamento: dentro la creazione della sessione ORT sarebbe un'attesa muta.
// Se fallisce non è un errore: ORT riprova per conto suo e riporta quello vero.
export async function precaricaWasm(avanza: Avanzamento): Promise<void> {
  const simd = WebAssembly.validate(new Uint8Array(PROVA_SIMD))
  const url = `/wasm/${simd ? 'ort-wasm-simd.wasm' : 'ort-wasm.wasm'}`
  try {
    const resp = await fetch(url)
    if (!resp.ok) return
    await leggiCorpo(resp, WASM_ATTESO, (r, t) => avanza(Math.min(99, Math.round((r / t) * 100)), `Scarico il motore… ${mb(r)} / ${mb(t)} MB`))
  } catch {
    return
  }
}

export async function pulisciVersioniVecchie(urlTenuto: string): Promise<void> {
  try {
    const cache = await caches.open(CACHE_MODELLO)
    const tenuto = new URL(urlTenuto, self.location.origin).toString()
    for (const req of await cache.keys()) if (req.url !== tenuto) await cache.delete(req)
  } catch {
    return
  }
}
