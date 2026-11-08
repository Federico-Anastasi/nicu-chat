export const MODELLO = {
  id: 'nicu-L-v11-dpo2-s2-int8',
  file: '/nicu-l-v11-dpo2-s2.int8.onnx',
  fileKV: '/nicu-l-v11-dpo2-s2.kv.int8.onnx',
  tokenizer: '/nicu-l-v11-dpo2-s2.tokenizer.json',
  etichetta: '1.2',
  versione: '2026-10-26b',
  vocab: 6000,
  blocco: 512,
  strati: 15,
  teste: 8,
  dimTesta: 40,
  riservaOutput: 55,
  maxTurniStoria: null as number | null,
  canonAttivo: false,
} as const

export interface GenerationParams {
  temperature: number
  topP: number
  repPenalty: number
  maxNew: number
}

export const PARAMETRI_DEFAULT: GenerationParams = {
  temperature: 1.0,
  topP: 0.92,
  repPenalty: 1.15,
  maxNew: 200,
}

export function urlModello(conCache: boolean): string {
  return (conCache ? MODELLO.fileKV : MODELLO.file) + '?v=' + MODELLO.versione
}
