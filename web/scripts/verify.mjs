import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath, pathToFileURL } from 'url'
import * as ort from 'onnxruntime-node'

const WEB = join(dirname(fileURLToPath(import.meta.url)), '..')
const PUB = join(WEB, 'public')
const FIX = join(WEB, 'scripts', 'fixtures')
const core = f => import(pathToFileURL(join(WEB, 'src', 'core', f)).href)

const { MODELLO } = await core('config.ts')
const { BPETokenizer } = await core('tokenizer.ts')
const { costruisciPrompt } = await core('prompt.ts')
const { creaPasso } = await core('passo.ts')
const { genera } = await core('genera.ts')
const { conSeme } = await core('casuale.ts')

const esiti = []
function controlla(nome, ok, dettaglio = '') {
  esiti.push(ok)
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ${nome}${dettaglio ? `  — ${dettaglio}` : ''}`)
}

const percorso = f => join(PUB, f.replace(/^\//, ''))
for (const f of [MODELLO.tokenizer, MODELLO.file, MODELLO.fileKV]) {
  if (!existsSync(percorso(f))) {
    console.error(`[FAIL]  file mancante: ${f}`)
    process.exit(1)
  }
}

const tokJson = JSON.parse(readFileSync(percorso(MODELLO.tokenizer), 'utf8'))
const tok = new BPETokenizer(tokJson)
const rif = JSON.parse(readFileSync(join(FIX, 'riferimenti_python.json'), 'utf8'))
const casi = JSON.parse(readFileSync(join(FIX, 'casi.json'), 'utf8'))

console.log(`riferimenti: ${rif.generato_da}\n`)

controlla('vocabolario del tokenizer = config', Object.keys(tokJson.model.vocab).length === MODELLO.vocab,
  `${Object.keys(tokJson.model.vocab).length} vs ${MODELLO.vocab}`)

const opz = { executionProviders: ['cpu'], intraOpNumThreads: 1 }
const sPiatto = await ort.InferenceSession.create(percorso(MODELLO.file), opz)
const sKV = await ort.InferenceSession.create(percorso(MODELLO.fileKV), opz)
const passi = { piatto: creaPasso(sPiatto, ort.Tensor), kv: creaPasso(sKV, ort.Tensor) }
const nPast = sKV.inputNames.filter(n => n.startsWith('past_k_')).length
controlla('modello con cache: strati = config', passi.kv.haKV && nPast === MODELLO.strati, `${nPast} vs ${MODELLO.strati}`)
controlla('modello semplice: senza cache', !passi.piatto.haKV)

let diffEnc = 0, diffDec = 0, primo = ''
for (const { testo, ids } of rif.tokenizer) {
  const mio = tok.encode(testo)
  if (mio.length !== ids.length || mio.some((x, i) => x !== ids[i])) {
    diffEnc++
    primo ||= JSON.stringify(testo).slice(0, 60)
  }
  if (!testo.startsWith('﻿') && tok.decode(ids) !== testo) diffDec++
}
controlla(`tokenizer = HuggingFace su ${rif.tokenizer.length} frasi`, diffEnc === 0, diffEnc ? `${diffEnc} diverse, es. ${primo}` : '')
controlla('decode(encode(x)) = x', diffDec === 0, diffDec ? `${diffDec} diverse` : '')

let diffPrompt = 0
for (const c of casi.casi) {
  const p = costruisciPrompt(c.userMsg, c.history, s => tok.encode(s), null)
  if (p.testo !== c.prompt || p.turniTenuti !== c.turniTenuti) diffPrompt++
}
controlla(`costruzione del prompt su ${casi.casi.length} casi`, diffPrompt === 0, diffPrompt ? `${diffPrompt} diversi` : '')

function argmax(a) {
  let m = 0
  for (let i = 1; i < a.length; i++) if (a[i] > a[m]) m = i
  return m
}

async function greedy(passo, ids, maxNew) {
  const tutti = [...ids]
  const gen = []
  let cache = null
  let inv = ids
  for (let i = 0; i < maxNew; i++) {
    let logits
    if (passo.haKV) {
      const r = await passo.conCache(inv, cache)
      logits = r.logits
      cache = r.cache
    } else logits = await passo.senzaCache(tutti, 0)
    const t = argmax(logits)
    if (t === tok.eotTokenId) break
    gen.push(t)
    tutti.push(t)
    inv = [t]
  }
  return gen
}

for (const via of ['piatto', 'kv']) {
  let diversi = 0, uguali = 0
  for (const g of rif.greedy) {
    const mio = await greedy(passi[via], tok.encode(g.prompt), rif.max_new)
    if (mio.length === g[via].length && mio.every((x, i) => x === g[via][i])) uguali++
    else diversi++
  }
  controlla(`greedy ${via === 'kv' ? 'con cache' : 'senza cache'} = onnxruntime Python (${rif.greedy.length} prompt)`, diversi === 0, `${uguali} uguali, ${diversi} diversi`)
}

let diffCamp = 0
for (const r of casi.campionamento_kv) {
  const c = casi.casi[r.caso]
  const testo = await genera(passi.kv, tok, { userMsg: c.userMsg, history: c.history, params: casi.params }, { casuale: conSeme(r.seme) })
  if (testo !== r.testo) diffCamp++
}
controlla(`campionamento a seme fisso = riferimento (${casi.campionamento_kv.length} risposte)`, diffCamp === 0, diffCamp ? `${diffCamp} diverse` : '')

const ok = esiti.every(Boolean)
console.log(ok ? '\nTUTTI I TEST PASSANO' : '\nTEST FALLITI: deploy bloccato')
process.exit(ok ? 0 : 1)
