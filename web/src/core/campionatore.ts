import type { GenerationParams } from './config.ts'

export type Casuale = () => number

export function penalizza(logits: Float32Array, penalizzati: Iterable<number>, repPenalty: number): void {
  for (const t of penalizzati) {
    logits[t] = logits[t] > 0 ? logits[t] / repPenalty : logits[t] * repPenalty
  }
}

export function softmax(logits: Float32Array, temperatura: number): Float32Array {
  for (let i = 0; i < logits.length; i++) logits[i] /= temperatura
  let max = -Infinity
  for (let i = 0; i < logits.length; i++) if (logits[i] > max) max = logits[i]
  const p = new Float32Array(logits.length)
  let somma = 0
  for (let i = 0; i < logits.length; i++) {
    p[i] = Math.exp(logits[i] - max)
    somma += p[i]
  }
  for (let i = 0; i < p.length; i++) p[i] /= somma
  return p
}

const SOGLIE = [1e-4, 1e-6, 0]

function nucleo(p: Float32Array, topP: number): number[] {
  for (const soglia of SOGLIE) {
    const candidati: number[] = []
    for (let i = 0; i < p.length; i++) if (p[i] >= soglia) candidati.push(i)
    candidati.sort((a, b) => p[b] - p[a])
    let cumulata = 0
    let k = 0
    while (k < candidati.length && cumulata <= topP) cumulata += p[candidati[k++]]
    if (cumulata > topP || soglia === 0) return candidati.slice(0, k)
  }
  return []
}

export function campionaTopP(p: Float32Array, topP: number, casuale: Casuale): number {
  const tenuti = nucleo(p, topP)
  const filtrati = new Float32Array(tenuti.length)
  let somma = 0
  for (let j = 0; j < tenuti.length; j++) {
    filtrati[j] = p[tenuti[j]]
    somma += filtrati[j]
  }
  for (let j = 0; j < tenuti.length; j++) filtrati[j] /= somma
  const r = casuale()
  let acc = 0
  for (let j = 0; j < tenuti.length; j++) {
    if (filtrati[j] === 0) continue
    acc += filtrati[j]
    if (r < acc) return tenuti[j]
  }
  return tenuti[0]
}

export function prossimoToken(
  logits: Float32Array,
  penalizzati: Iterable<number>,
  params: GenerationParams,
  casuale: Casuale,
): number {
  penalizza(logits, penalizzati, params.repPenalty)
  return campionaTopP(softmax(logits, params.temperature), params.topP, casuale)
}
