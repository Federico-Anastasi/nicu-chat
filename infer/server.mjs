import { createServer } from 'node:http'
import { fork } from 'node:child_process'
import { createHash, randomBytes } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { MODELLO, PARAMETRI_DEFAULT } from '../web/src/core/config.ts'
import { BPETokenizer } from '../web/src/core/tokenizer.ts'

function intEnv(nome, predefinito, minimo) {
  const v = process.env[nome]
  if (v === undefined || v === '') return predefinito
  const n = Number(v)
  if (!Number.isInteger(n) || n < minimo) throw new Error(`${nome}=${v}: atteso un intero >= ${minimo}`)
  return n
}

const PORT = intEnv('PORT', 8300, 1)
const SLOT = intEnv('NICU_SLOT', 4, 1)
const CODA = intEnv('NICU_CODA', 8, 0)
const TEST = process.env.NICU_TEST === '1'
const SALE = process.env.NICU_IP_SALT || randomBytes(16).toString('hex')

const tok = new BPETokenizer(JSON.parse(readFileSync(fileURLToPath(new URL(`../web/public${MODELLO.tokenizer}`, import.meta.url)), 'utf8')))
const MAX_CORPO = 64 * 1024
const MAX_MESSAGGIO = 500
// Oltre questi token il turno sfora il contesto e ogni token generato rifà il prefill: solo input patologici ci arrivano.
const MAX_TOKEN_TURNO = 300
const MAX_STORIA = 20
const MAX_CAMPO_STORIA = 2000
const MAX_SESSIONE = 64
const LIMITE_RICHIESTE = 20
const FINESTRA_MS = 60_000
const TIMEOUT_MS = 20_000
const GRAZIA_MS = 2_000
const DRENAGGIO_MS = 8_000

const LIMITI = {
  temperature: [0.5, 1.5],
  topP: [0.5, 1],
  repPenalty: [1, 1.5],
  maxNew: [1, 200],
}

class ErroreHttp extends Error {
  constructor(stato, codice, extra = {}) {
    super(codice)
    this.stato = stato
    this.codice = codice
    this.extra = extra
  }
}

const adesso = () => performance.now()
const isObj = x => x !== null && typeof x === 'object' && !Array.isArray(x)
const lunghezza = s => Array.from(s).length

function leggiParams(p) {
  const out = { ...PARAMETRI_DEFAULT }
  if (p === undefined || p === null) return out
  if (!isObj(p)) throw new ErroreHttp(400, 'bad_request')
  for (const [k, [lo, hi]] of Object.entries(LIMITI)) {
    if (p[k] === undefined) continue
    if (typeof p[k] !== 'number' || !Number.isFinite(p[k])) throw new ErroreHttp(400, 'bad_request')
    out[k] = Math.min(hi, Math.max(lo, p[k]))
  }
  out.maxNew = Math.floor(out.maxNew)
  return out
}

function leggiStoria(h) {
  if (h === undefined || h === null) return []
  if (!Array.isArray(h) || h.length > MAX_STORIA) throw new ErroreHttp(400, 'bad_request')
  return h.map(t => {
    if (!isObj(t) || typeof t.user !== 'string' || typeof t.nicu !== 'string') throw new ErroreHttp(400, 'bad_request')
    if (t.user.length > MAX_CAMPO_STORIA || t.nicu.length > MAX_CAMPO_STORIA) throw new ErroreHttp(400, 'bad_request')
    return { user: t.user, nicu: t.nicu }
  })
}

function leggiRichiesta(corpo) {
  let b
  try {
    b = JSON.parse(corpo.toString('utf8'))
  } catch {
    throw new ErroreHttp(400, 'bad_request')
  }
  if (!isObj(b) || typeof b.message !== 'string') throw new ErroreHttp(400, 'bad_request')
  const userMsg = b.message.trim()
  const n = lunghezza(userMsg)
  if (n < 1 || n > MAX_MESSAGGIO) throw new ErroreHttp(400, 'bad_request')
  if (tok.encode(`Utente: ${userMsg}
Nicu:`).length > MAX_TOKEN_TURNO) throw new ErroreHttp(400, 'too_long')
  if (b.session !== undefined && b.session !== null && (typeof b.session !== 'string' || b.session.length > MAX_SESSIONE))
    throw new ErroreHttp(400, 'bad_request')
  const richiesta = { userMsg, history: leggiStoria(b.history), params: leggiParams(b.params) }
  if (TEST && Number.isInteger(b.seme)) richiesta.seme = b.seme
  return richiesta
}

function leggiCorpo(req) {
  return new Promise((ok, ko) => {
    const dichiarata = Number(req.headers['content-length'])
    if (dichiarata > MAX_CORPO) return ko(new ErroreHttp(413, 'payload_too_large', { chiudi: true }))
    const parti = []
    let n = 0
    let finito = false
    req.on('data', c => {
      if (finito) return
      n += c.length
      if (n > MAX_CORPO) {
        finito = true
        return ko(new ErroreHttp(413, 'payload_too_large', { chiudi: true }))
      }
      parti.push(c)
    })
    req.on('end', () => !finito && ok(Buffer.concat(parti)))
    req.on('error', ko)
  })
}

const richiesteIp = new Map()

function hashIp(req) {
  const xff = req.headers['x-forwarded-for']
  const primo = typeof xff === 'string' ? xff.split(',')[0].trim() : ''
  const ip = primo || req.socket.remoteAddress || ''
  return createHash('sha256').update(SALE).update(ip).digest('hex').slice(0, 16)
}

function controllaRateLimit(chiave) {
  const t = Date.now()
  const recenti = (richiesteIp.get(chiave) ?? []).filter(x => t - x < FINESTRA_MS)
  if (recenti.length >= LIMITE_RICHIESTE) {
    richiesteIp.set(chiave, recenti)
    throw new ErroreHttp(429, 'rate_limit', { retryAfter: Math.max(1, Math.ceil((recenti[0] + FINESTRA_MS - t) / 1000)) })
  }
  recenti.push(t)
  richiesteIp.set(chiave, recenti)
}

setInterval(() => {
  const t = Date.now()
  for (const [k, v] of richiesteIp) if (t - v[v.length - 1] >= FINESTRA_MS) richiesteIp.delete(k)
}, FINESTRA_MS).unref()

const workers = []
const coda = []
let chiusura = false
let prossimoId = 0

function avviaWorker(w, primoAvvio) {
  w.pronto = false
  w.job = null
  w.proc = fork(new URL('./worker.mjs', import.meta.url), { stdio: ['ignore', 'inherit', 'inherit', 'ipc'] })
  w.proc.on('message', m => gestisciMessaggio(w, m))
  w.proc.on('exit', (codice, segnale) => {
    if (chiusura) return
    console.error(`worker ${w.proc.pid} terminato (codice=${codice} segnale=${segnale})`)
    if (!w.pronto && primoAvvio) process.exit(1)
    w.pronto = false
    if (w.job) concludi(w.job, { t: 'error', code: 'internal' }, 'errore')
    setTimeout(() => !chiusura && avviaWorker(w, false), 500)
  })
}

function gestisciMessaggio(w, m) {
  if (m.ready) {
    w.pronto = true
    avvia()
    return
  }
  const job = w.job
  if (!job || job.id !== m.id) return
  if (m.t === 'token') {
    job.ctx.token++
    job.ctx.ttft ??= adesso() - job.t0
    scrivi(job, { t: 'token', text: m.text })
  } else if (m.t === 'done') {
    concludi(job, { t: 'done', text: m.text, ai_generated: true, model: MODELLO.id }, 'ok')
  } else {
    concludi(job, { t: 'error', code: 'internal' }, 'errore')
  }
}

function scrivi(job, evento) {
  if (job.chiuso) return
  job.res.write(`data: ${JSON.stringify(evento)}\n\n`)
}

function chiudiStream(job, evento, esito) {
  if (job.chiuso) return
  job.chiuso = true
  job.ctx.esito = esito
  job.res.end(`data: ${JSON.stringify(evento)}\n\n`)
}

function concludi(job, evento, esito) {
  chiudiStream(job, evento, esito)
  libera(job)
}

function libera(job) {
  const w = job.w
  if (!w || w.job !== job) return
  clearTimeout(job.timer)
  clearTimeout(job.grazia)
  w.job = null
  avvia()
}

function annulla(job, esito) {
  if (job.w) {
    job.w.proc.send({ cancel: job.id })
    return
  }
  const i = coda.indexOf(job)
  if (i >= 0) coda.splice(i, 1)
  job.ctx.esito = esito
}

function scaduto(job) {
  chiudiStream(job, { t: 'error', code: 'internal' }, 'timeout')
  job.w.proc.send({ cancel: job.id })
  job.grazia = setTimeout(() => job.w.proc.kill('SIGKILL'), GRAZIA_MS)
}

function avvia() {
  while (coda.length) {
    const w = workers.find(x => x.pronto && !x.job)
    if (!w) return
    const job = coda.shift()
    job.w = w
    w.job = job
    job.ctx.codaMs = Math.round(adesso() - job.t0)
    job.t0 = adesso()
    w.proc.send({ id: job.id, ...job.payload })
    job.timer = setTimeout(() => scaduto(job), TIMEOUT_MS)
  }
}

const attivi = () => workers.filter(w => w.job).length

function json(res, stato, corpo, intestazioni = {}) {
  const testo = JSON.stringify(corpo)
  res.writeHead(stato, {
    'Content-Type': 'application/json; charset=utf-8',
    'Cache-Control': 'no-store',
    'Content-Length': Buffer.byteLength(testo),
    ...intestazioni,
  })
  res.end(testo)
}

function riga(ctx, stato) {
  const campi = [new Date().toISOString(), ctx.metodo, ctx.percorso, stato, ctx.esito ?? 'ok', `dur=${Math.round(adesso() - ctx.t0)}ms`]
  if (ctx.codaMs !== undefined) campi.push(`coda=${ctx.codaMs}ms`)
  if (ctx.token !== undefined) campi.push(`ttft=${ctx.ttft === undefined ? '-' : Math.round(ctx.ttft) + 'ms'}`, `tok=${ctx.token}`)
  console.log(campi.join(' '))
}

async function chat(req, res, ctx) {
  controllaRateLimit(hashIp(req))
  const richiesta = leggiRichiesta(await leggiCorpo(req))
  if (chiusura || attivi() + coda.length >= SLOT + CODA) throw new ErroreHttp(503, 'busy', { retryAfter: 2 })

  ctx.token = 0
  const job = { id: ++prossimoId, res, ctx, payload: richiesta, t0: adesso(), w: null }
  res.on('close', () => {
    if (job.chiuso) return
    job.chiuso = true
    ctx.esito = 'client'
    annulla(job, 'client')
  })

  res.writeHead(200, {
    'Content-Type': 'text/event-stream; charset=utf-8',
    'Cache-Control': 'no-cache, no-transform',
    'X-Accel-Buffering': 'no',
    Connection: 'keep-alive',
  })
  res.write(': ok\n\n')
  req.socket.setNoDelay(true)
  coda.push(job)
  avvia()
}

async function gestisci(req, res, ctx) {
  const percorso = new URL(req.url, 'http://x').pathname
  ctx.percorso = percorso
  if (percorso === '/api/chat/health') {
    ctx.silenzioso = true
    if (req.method !== 'GET') throw new ErroreHttp(405, 'method_not_allowed', { allow: 'GET' })
    return json(res, 200, { ok: true, model: MODELLO.id, attivi: attivi(), in_coda: coda.length, slot: SLOT })
  }
  if (percorso !== '/api/chat') throw new ErroreHttp(404, 'not_found')
  if (req.method !== 'POST') throw new ErroreHttp(405, 'method_not_allowed', { allow: 'POST' })
  await chat(req, res, ctx)
}

const server = createServer((req, res) => {
  const ctx = { metodo: req.method, percorso: '-', t0: adesso() }
  res.on('close', () => {
    if (!res.writableFinished && !ctx.esito) ctx.esito = 'client'
    if (!ctx.silenzioso) riga(ctx, res.statusCode)
  })
  gestisci(req, res, ctx).catch(e => {
    const noto = e instanceof ErroreHttp
    if (!noto) console.error(`errore interno: ${e.stack}`)
    const err = noto ? e : new ErroreHttp(500, 'internal')
    ctx.esito ??= err.codice
    if (res.headersSent) return res.destroy()
    const intestazioni = {}
    if (err.extra.retryAfter) intestazioni['Retry-After'] = String(err.extra.retryAfter)
    if (err.extra.allow) intestazioni.Allow = err.extra.allow
    if (err.extra.chiudi) intestazioni.Connection = 'close'
    json(res, err.stato, { error: err.codice }, intestazioni)
    if (err.extra.chiudi) req.resume()
  })
})
server.keepAliveTimeout = 125_000
server.headersTimeout = 20_000
server.requestTimeout = 20_000

async function arresta() {
  if (chiusura) return
  chiusura = true
  console.log('chiusura: niente nuove richieste, attendo le generazioni in corso')
  server.close()
  const limite = Date.now() + DRENAGGIO_MS
  while ((attivi() || coda.length) && Date.now() < limite) await new Promise(r => setTimeout(r, 50))
  for (const w of workers) w.proc.kill('SIGKILL')
  console.log('chiuso')
  process.exit(0)
}
process.on('SIGTERM', arresta)
process.on('SIGINT', arresta)

for (let i = 0; i < SLOT; i++) {
  const w = {}
  workers.push(w)
  avviaWorker(w, true)
}
await new Promise(r => {
  const t = setInterval(() => workers.every(w => w.pronto) && (clearInterval(t), r()), 20)
})
server.listen(PORT, () => console.log(`nicu-infer ${MODELLO.id} su :${PORT} pid=${process.pid} slot=${SLOT} coda=${CODA}${TEST ? ' TEST' : ''}`))
