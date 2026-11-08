import * as ort from 'onnxruntime-web/wasm'

export function configuraOrt(): void {
  ort.env.wasm.wasmPaths = '/wasm/'
  ort.env.wasm.numThreads = 1
  ort.env.wasm.proxy = false
}

export function creaSessione(buffer: ArrayBuffer): Promise<ort.InferenceSession> {
  return ort.InferenceSession.create(buffer, {
    executionProviders: ['wasm'],
    graphOptimizationLevel: 'all',
  })
}
