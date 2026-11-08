import * as ort from 'onnxruntime-node'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { MODELLO } from '../web/src/core/config.ts'
import { BPETokenizer } from '../web/src/core/tokenizer.ts'
import { creaPasso } from '../web/src/core/passo.ts'
import { genera } from '../web/src/core/genera.ts'
import { conSeme } from '../web/src/core/casuale.ts'

const pub = f => fileURLToPath(new URL(`../web/public${f}`, import.meta.url))

const tok = new BPETokenizer(JSON.parse(readFileSync(pub(MODELLO.tokenizer), 'utf8')))
const sessione = await ort.InferenceSession.create(pub(MODELLO.fileKV), {
  executionProviders: ['cpu'],
  intraOpNumThreads: 1,
  interOpNumThreads: 1,
})
const passo = creaPasso(sessione, ort.Tensor)
if (!passo.haKV) throw new Error('il modello caricato non ha la cache KV')

const params = { temperature: 1, topP: 0.92, repPenalty: 1.15, maxNew: 4 }
await genera(passo, tok, { userMsg: 'ciao', history: [], params })

let corrente = null
const annullate = new Set()

process.on('message', async m => {
  if (m.cancel !== undefined) {
    if (m.cancel === corrente) annullate.add(m.cancel)
    return
  }
  const { id, userMsg, history, params, seme } = m
  corrente = id
  try {
    const testo = await genera(passo, tok, { userMsg, history, params }, {
      casuale: seme === undefined ? undefined : conSeme(seme),
      onToken: text => process.send({ id, t: 'token', text }),
      interrotta: () => annullate.has(id),
    })
    process.send({ id, t: 'done', text: testo })
  } catch (e) {
    console.error(`worker ${process.pid}: ${e.message}`)
    process.send({ id, t: 'error' })
  } finally {
    annullate.delete(id)
    corrente = null
  }
})

process.on('disconnect', () => process.exit(0))
process.send({ ready: true })
