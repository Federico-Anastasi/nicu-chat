import { MODELLO } from './config.ts'
import { troncaPreservandoCanon } from './prompt.ts'

export interface TensoreOrt {
  readonly data: unknown
}

export interface SessioneOrt {
  readonly inputNames: readonly string[]
  run(feeds: Record<string, TensoreOrt>): Promise<Record<string, TensoreOrt>>
}

export type CostruttoreTensore = new (
  tipo: 'int64' | 'float32',
  dati: BigInt64Array | Float32Array,
  forma: readonly number[],
) => TensoreOrt

export type Cache = Record<string, TensoreOrt>

export interface Passo {
  readonly haKV: boolean
  conCache(nuovi: number[], cache: Cache | null): Promise<{ logits: Float32Array; cache: Cache }>
  senzaCache(ids: number[], tokenCanon: number): Promise<Float32Array>
}

const nomeIn = (i: number, t: 'k' | 'v') => `past_${t}_${i}`
const nomeOut = (i: number, t: 'k' | 'v') => `present_${t}_${i}`

export function creaPasso(sessione: SessioneOrt, Tensore: CostruttoreTensore): Passo {
  const vocab = MODELLO.vocab

  const ingresso = (ids: number[]) => {
    const dati = new BigInt64Array(ids.length)
    for (let i = 0; i < ids.length; i++) dati[i] = BigInt(ids[i])
    return new Tensore('int64', dati, [1, ids.length])
  }

  const ultimi = (out: Record<string, TensoreOrt>, n: number) => {
    const tutti = out['logits'].data as Float32Array
    const da = (n - 1) * vocab
    return tutti.slice(da, da + vocab)
  }

  const cacheVuota = (): Cache => {
    const c: Cache = {}
    for (let i = 0; i < MODELLO.strati; i++)
      for (const t of ['k', 'v'] as const)
        c[nomeIn(i, t)] = new Tensore('float32', new Float32Array(0), [1, MODELLO.teste, 0, MODELLO.dimTesta])
    return c
  }

  return {
    haKV: sessione.inputNames.includes('past_k_0'),

    async conCache(nuovi, cache) {
      const feeds: Cache = { ...(cache ?? cacheVuota()), idx: ingresso(nuovi) }
      const out = await sessione.run(feeds)
      const presente: Cache = {}
      for (let i = 0; i < MODELLO.strati; i++)
        for (const t of ['k', 'v'] as const) presente[nomeIn(i, t)] = out[nomeOut(i, t)]
      return { logits: ultimi(out, nuovi.length), cache: presente }
    },

    async senzaCache(ids, tokenCanon) {
      const fetta = troncaPreservandoCanon(ids, tokenCanon)
      const out = await sessione.run({ idx: ingresso(fetta) })
      return ultimi(out, fetta.length)
    },
  }
}
