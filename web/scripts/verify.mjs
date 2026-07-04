/**
 * verify.mjs — verifica end-to-end del tokenizer e dell'inferenza greedy sul
 * modello ATTUALMENTE servito da `public/` (`nicu-l-sft-v10.tokenizer.json` +
 * `nicu-l-sft-v10.onnx`, vocab 6000, block_size 512).
 *
 * ⚠️ I valori attesi qui sotto NON sono una parità con l'export Python
 * (`sample_synth.py`): sono una BASELINE DI REGRESSIONE presa eseguendo QUESTO
 * stesso tokenizer JS + `onnxruntime-node` su questo `.onnx`, il
 * 2026-07-02 (vedi HANDOFF). Servono a rilevare rotture accidentali (bump di
 * onnxruntime-web/-node, refactor del tokenizer, file `.onnx`/`.json`
 * sostituiti con un altro modello a parità di nome, ecc.), NON a certificare
 * la correttezza matematica assoluta rispetto a PyTorch. Se cambi
 * modello/tokenizer di proposito, rigenera questi valori con lo stesso
 * script (vedi il campo `encode`/`greedy` stampati qui sotto) e aggiornali.
 *
 * Uso:  node scripts/verify.mjs
 * Deps: onnxruntime-node (devDependency)
 * Exit code: 0 se tutti i test passano, 1 altrimenti (usato da deploy/deploy_web.sh
 * per bloccare un deploy con tokenizer/modello rotti).
 */

import { readFileSync, existsSync } from 'fs'
import { join, dirname } from 'path'
import { fileURLToPath } from 'url'
import * as ort from 'onnxruntime-node'

const __dirname = dirname(fileURLToPath(import.meta.url))
const WEB_ROOT = join(__dirname, '..')       // projects/nicu/web
const PUB_DIR = join(WEB_ROOT, 'public')

// ============================================================================
// 1. Tokenizer — ByteLevel BPE (reimplementazione pura JS, stessa logica del browser)
// ============================================================================

/** Mappa byte → codice Unicode (identica a GPT-2 / gpt2.py) */
function buildByteToUnicode() {
  const result = new Uint16Array(256)
  const printable = new Set()
  for (let i = 33; i <= 126; i++) printable.add(i)
  for (let i = 161; i <= 172; i++) printable.add(i)
  for (let i = 174; i <= 255; i++) printable.add(i)

  for (const b of printable) result[b] = b

  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!printable.has(b)) {
      result[b] = 0x0100 + n
      n++
    }
  }
  return result
}

const BYTE_TO_UNI = buildByteToUnicode()

const UNI_TO_BYTE = new Map()
for (let b = 0; b < 256; b++) UNI_TO_BYTE.set(BYTE_TO_UNI[b], b)

const encoder = new TextEncoder()
const decoder = new TextDecoder('utf-8', { fatal: false })

function toByteLevelString(text) {
  const bytes = encoder.encode(text)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(BYTE_TO_UNI[b])
  return out
}

function fromByteLevelString(byteStr) {
  const bytes = new Uint8Array(byteStr.length)
  for (let i = 0; i < byteStr.length; i++) {
    bytes[i] = UNI_TO_BYTE.get(byteStr.charCodeAt(i)) ?? 63
  }
  return decoder.decode(bytes)
}

// Pre-tokenizer regex GPT-2
const PRE_TOK_RE = /('s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+)/gu

function preTok(text) {
  return text.match(PRE_TOK_RE) ?? []
}

function buildTokenizer(tokJson) {
  const vocab = new Map(Object.entries(tokJson.model.vocab))
  const vocabRev = new Map(Object.entries(tokJson.model.vocab).map(([k, v]) => [v, k]))

  // merges: array di coppie [a, b] → rank
  const mergeRank = new Map(
    tokJson.model.merges.map(([a, b], i) => [`${a}\x00${b}`, i])
  )

  const eotTok = tokJson.added_tokens.find(t => t.content === '<|endoftext|>')
  const eotId = eotTok?.id ?? 0

  function applyBPE(chars) {
    let word = chars
    if (word.length <= 1) return word

    while (true) {
      let bestRank = Infinity
      let bestIdx = -1

      for (let i = 0; i < word.length - 1; i++) {
        const key = `${word[i]}\x00${word[i + 1]}`
        const rank = mergeRank.get(key)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          bestIdx = i
        }
      }

      if (bestIdx === -1) break

      const next = []
      for (let i = 0; i < word.length; i++) {
        if (i === bestIdx) {
          next.push(word[i] + word[i + 1])
          i++
        } else {
          next.push(word[i])
        }
      }
      word = next
    }

    return word
  }

  return {
    eotId,
    encode(text) {
      const ids = []
      for (const seg of preTok(text)) {
        const blStr = toByteLevelString(seg)
        const chars = Array.from(blStr)
        const tokens = applyBPE(chars)
        for (const tok of tokens) {
          const id = vocab.get(tok)
          if (id !== undefined) ids.push(id)
        }
      }
      return ids
    },
    decode(ids) {
      let blStr = ''
      for (const id of ids) blStr += vocabRev.get(id) ?? ''
      return fromByteLevelString(blStr)
    },
  }
}

// ============================================================================
// 2. Greedy inference con onnxruntime-node
// ============================================================================

const BLOCK_SIZE = 512   // nicu-M-v9b: contesto 512
const VOCAB_SIZE = 6000  // nicu-L-sft-v10: BPE 6k (tokenizer pinnato per-ckpt)

async function runStep(session, ids) {
  const slice = ids.length > BLOCK_SIZE ? ids.slice(ids.length - BLOCK_SIZE) : ids
  const seqLen = slice.length

  const inputData = new BigInt64Array(seqLen)
  for (let i = 0; i < seqLen; i++) inputData[i] = BigInt(slice[i])
  const inputTensor = new ort.Tensor('int64', inputData, [1, seqLen])

  const outputs = await session.run({ idx: inputTensor })
  const logitsAll = outputs['logits'].data
  const offset = (seqLen - 1) * VOCAB_SIZE
  return logitsAll.slice(offset, offset + VOCAB_SIZE)
}

function argmax(arr) {
  let best = 0
  for (let i = 1; i < arr.length; i++) {
    if (arr[i] > arr[best]) best = i
  }
  return best
}

async function greedyGenerate(session, tokenizer, promptStr, maxNew) {
  const promptIds = tokenizer.encode(promptStr)
  const allIds = [...promptIds]
  const generatedIds = []

  for (let step = 0; step < maxNew; step++) {
    const logits = await runStep(session, allIds)
    const nextId = argmax(logits)
    if (nextId === tokenizer.eotId) break
    allIds.push(nextId)
    generatedIds.push(nextId)
  }

  return generatedIds
}

// ============================================================================
// 3. Esecuzione test
// ============================================================================

function arrEq(a, b) {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false
  return true
}

function pass(label, ok, detail) {
  const icon = ok ? '[PASS]' : '[FAIL]'
  console.log(`${icon}  ${label}`)
  if (detail) console.log(`     ${detail}`)
  return ok
}

async function main() {
  console.log('='.repeat(60))
  console.log('  Nicu — verifica invarianti (tokenizer + modello serviti)')
  console.log('='.repeat(60))
  console.log()

  const results = []

  // Carica tokenizer
  const tokPath = join(PUB_DIR, 'nicu-l-sft-v10.tokenizer.json')
  console.log(`[1/3] Carico tokenizer: ${tokPath}`)
  if (!existsSync(tokPath)) {
    console.error(`  File non trovato: ${tokPath}`)
    process.exit(1)
  }
  const tokJson = JSON.parse(readFileSync(tokPath, 'utf8'))
  const tokenizer = buildTokenizer(tokJson)

  results.push(pass(
    'vocab size == 6000',
    Object.keys(tokJson.model.vocab).length === 6000,
    `ottenuto: ${Object.keys(tokJson.model.vocab).length}`
  ))

  // -------------------------------------------------------------------------
  // TEST: encode (baseline di regressione — vedi commento in testa al file)
  // -------------------------------------------------------------------------
  const ENC_INPUT    = 'Utente: ciao\nNicu:'
  const ENC_EXPECTED = [287, 26, 972, 199, 285, 26]

  const encResult = tokenizer.encode(ENC_INPUT)

  console.log()
  console.log(`[TEST] encode("${ENC_INPUT}")`)
  console.log(`  atteso:  [${ENC_EXPECTED.join(', ')}]`)
  console.log(`  ottenuto:[${encResult.join(', ')}]`)
  results.push(pass('encode ids', arrEq(encResult, ENC_EXPECTED)))

  // Verifica anche il decode round-trip
  const decoded = tokenizer.decode(ENC_EXPECTED)
  console.log()
  console.log(`[TEST] decode([${ENC_EXPECTED.join(', ')}])`)
  console.log(`  atteso:  "${ENC_INPUT}"`)
  console.log(`  ottenuto:"${decoded}"`)
  results.push(pass('decode round-trip', decoded === ENC_INPUT))

  // -------------------------------------------------------------------------
  // TEST: greedy generate (baseline di regressione — non parità Python)
  // -------------------------------------------------------------------------
  const MODEL_PATH = join(PUB_DIR, 'nicu-l-sft-v10.int8.onnx')
  console.log()
  console.log(`[2/3] Carico modello ONNX: ${MODEL_PATH}`)
  if (!existsSync(MODEL_PATH)) {
    console.error(`  File non trovato: ${MODEL_PATH}`)
    process.exit(1)
  }
  const session = await ort.InferenceSession.create(MODEL_PATH, {
    executionProviders: ['cpu'],
  })

  const GREEDY_PROMPT   = 'Utente: come ti chiami?\nNicu:'
  const GREEDY_EXPECTED = [938, 12, 289, 663, 12, 1074, 1910, 281, 1657, 289, 438, 296, 780, 14, 576, 598, 320, 300, 353, 4764, 12, 312, 2066, 514]
  const GREEDY_TEXT     = ' Nicu, di Catania, amico semplice che vive di mare e amici. La griglia è la mia arte, il resto lo'

  console.log()
  console.log(`[3/3] Greedy decode (max 24 token): "${GREEDY_PROMPT}"`)
  const genIds = await greedyGenerate(session, tokenizer, GREEDY_PROMPT, 24)
  const genText = tokenizer.decode(genIds)

  console.log(`  atteso ids:  [${GREEDY_EXPECTED.join(', ')}]`)
  console.log(`  ottenuto ids:[${genIds.join(', ')}]`)
  results.push(pass('greedy ids', arrEq(genIds, GREEDY_EXPECTED)))

  console.log()
  console.log(`  atteso testo:  "${GREEDY_TEXT}"`)
  console.log(`  ottenuto testo:"${genText}"`)
  results.push(pass('greedy testo', genText === GREEDY_TEXT))

  // -------------------------------------------------------------------------
  // Sommario
  // -------------------------------------------------------------------------
  console.log()
  console.log('='.repeat(60))
  const allOk = results.every(Boolean)
  if (allOk) {
    console.log('  TUTTI I TEST PASSANO — app pronta.')
    console.log('='.repeat(60))
  } else {
    console.log('  ATTENZIONE: uno o più test falliti. Controlla tokenizer/modello.')
    console.log('='.repeat(60))
    process.exit(1)
  }
}

main().catch(e => {
  console.error('Errore fatale:', e)
  process.exit(1)
})
