import { readFileSync, writeFileSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as ort from 'onnxruntime-node'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..', '..')
const FIX = join(WEB, 'scripts', 'fixtures')
const core = f => import(pathToFileURL(join(WEB, 'src', 'core', f)).href)
const { MODELLO } = await core('config.ts')
const { BPETokenizer } = await core('tokenizer.ts')
const { creaPasso } = await core('passo.ts')
const { genera } = await core('genera.ts')
const { conSeme } = await core('casuale.ts')

const pub = f => join(WEB, 'public', f.replace(/^\//, ''))
const tok = new BPETokenizer(JSON.parse(readFileSync(pub(MODELLO.tokenizer), 'utf8')))
const sKV = await ort.InferenceSession.create(pub(MODELLO.fileKV), { executionProviders: ['cpu'], intraOpNumThreads: 1 })
const passo = creaPasso(sKV, ort.Tensor)
const file = join(FIX, 'casi.json')
const casi = JSON.parse(readFileSync(file, 'utf8'))
casi.campionamento_kv = await Promise.all(casi.campionamento_kv.map(async ({ caso, seme }) => {
  const c = casi.casi[caso]
  const testo = await genera(passo, tok, { userMsg: c.userMsg, history: c.history, params: casi.params }, { casuale: conSeme(seme) })
  return { caso, seme, testo }
}))
writeFileSync(file, JSON.stringify(casi, null, 1))
console.log(`campionamento rigenerato con ${MODELLO.id}: ${casi.campionamento_kv.length} risposte`)
