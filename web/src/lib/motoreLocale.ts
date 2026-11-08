import { urlModello } from '../core/config.ts'
import { ErroreMotore, type Motore } from './motore.ts'

// L'unico punto che importa il runtime ONNX: sempre dinamico, così la prima visita in modalità server non lo scarica.
export async function caricaMotoreLocale(avanza: (pct: number, msg: string) => void, segnale: AbortSignal): Promise<Motore> {
  const inferenza = await import('./inference')
  // `?kv=0` = modello senza cache (diagnosi). A ogni rigenerazione del .onnx va alzata MODELLO.versione.
  const conCache = new URLSearchParams(location.search).get('kv') !== '0'
  const sessione = await inferenza.loadModel(urlModello(conCache), avanza, segnale)
  return {
    tipo: 'wasm',
    async genera(r) {
      try {
        return await inferenza.generate(sessione, r.messaggio, r.params, r.onToken, r.segnale, r.storia)
      } catch (e) {
        throw new ErroreMotore('locale', null, String(e))
      }
    },
  }
}
