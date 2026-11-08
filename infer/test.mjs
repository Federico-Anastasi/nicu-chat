import http from 'node:http'
import { readFileSync } from 'node:fs'
import { execFileSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'
import os from 'node:os'
import * as ort from 'onnxruntime-node'
import { MODELLO, PARAMETRI_DEFAULT } from '../web/src/core/config.ts'
import { BPETokenizer } from '../web/src/core/tokenizer.ts'
import { creaPasso } from '../web/src/core/passo.ts'
import { genera } from '../web/src/core/genera.ts'
import { conSeme } from '../web/src/core/casuale.ts'

const arg = (nome, def) => {
  const a = process.argv.find(x => x.startsWith(`--${nome}=`))
  return a ? a.slice(nome.length + 3) : def
}
const URL_BASE = new URL(arg('url', 'http://127.0.0.1:8300'))
const PID = arg('pid') ? Number(arg('pid')) : null
const SEZIONI = new Set(arg('sezioni', '1,2,3,4,5,6,7').split(',').map(Number))
const UTENTI = Number(arg('utenti', 40))
const DURATA_REALE = Number(arg('durata', 120))

const pub = f => fileURLToPath(new URL(`../web/public${f}`, import.meta.url))
const casi = JSON.parse(readFileSync(fileURLToPath(new URL('../web/scripts/fixtures/casi.json', import.meta.url)), 'utf8')).casi

const agente = new http.Agent({ keepAlive: true, maxSockets: Infinity })
const dormi = ms => new Promise(r => setTimeout(r, ms))
const ms = t => `${t.toFixed(0)} ms`
const mediana = a => perc(a, 50)
function perc(a, p) {
  if (!a.length) return NaN
  const s = [...a].sort((x, y) => x - y)
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))]
}

let fallimenti = 0
function esito(nome, ok, dettaglio = '') {
  if (!ok) fallimenti++
  console.log(`${ok ? '[PASS]' : '[FAIL]'}  ${nome}${dettaglio ? `  -- ${dettaglio}` : ''}`)
}
const info = testo => console.log(`        ${testo}`)
const titolo = t => console.log(`\n== ${t}`)

let contatoreIp = 0
const ipNuovo = () => `10.${(contatoreIp >> 16) & 255}.${(contatoreIp >> 8) & 255}.${contatoreIp++ & 255}`

function chiama({ metodo = 'POST', path = '/api/chat', corpo, crudo, ip = ipNuovo(), intestazioni = {}, chunked = false, distruggiAlToken = 0 } = {}) {
  return new Promise(resolve => {
    const t0 = performance.now()
    const dati = crudo ?? (corpo === undefined ? undefined : JSON.stringify(corpo))
    const h = { 'X-Forwarded-For': ip, ...intestazioni }
    if (dati !== undefined) {
      h['Content-Type'] = 'application/json'
      if (!chunked) h['Content-Length'] = Buffer.byteLength(dati)
    }
    const r = { stato: 0, intestazioni: {}, eventi: [], commenti: [], testo: '', json: null, t0, tFine: 0, errore: null }
    let buffer = ''
    const req = http.request({ host: URL_BASE.hostname, port: URL_BASE.port, path, method: metodo, headers: h, agent: agente }, res => {
      r.stato = res.statusCode
      r.intestazioni = res.headers
      res.setEncoding('utf8')
      res.on('data', c => {
        const t = performance.now() - t0
        r.testo += c
        buffer += c
        let i
        while ((i = buffer.indexOf('\n\n')) >= 0) {
          const blocco = buffer.slice(0, i)
          buffer = buffer.slice(i + 2)
          if (blocco.startsWith(':')) r.commenti.push({ at: t, testo: blocco })
          else if (blocco.startsWith('data: ')) {
            r.eventi.push({ ...JSON.parse(blocco.slice(6)), at: t })
            if (distruggiAlToken && r.eventi.filter(e => e.t === 'token').length >= distruggiAlToken) {
              r.tFine = t
              req.destroy()
              return resolve(r)
            }
          }
        }
      })
      res.on('end', () => {
        r.tFine = performance.now() - t0
        if (res.headers['content-type']?.startsWith('application/json')) {
          try {
            r.json = JSON.parse(r.testo)
          } catch {}
        }
        resolve(r)
      })
      res.on('error', e => {
        r.errore = e.message
        r.tFine = performance.now() - t0
        resolve(r)
      })
    })
    req.on('error', e => {
      r.errore = e.message
      r.tFine = performance.now() - t0
      resolve(r)
    })
    if (dati !== undefined) {
      if (chunked) {
        const pezzo = 8192
        for (let i = 0; i < dati.length; i += pezzo) req.write(dati.slice(i, i + pezzo))
      } else req.write(dati)
    }
    req.end()
  })
}

const salute = async () => (await chiama({ metodo: 'GET', path: '/api/chat/health' })).json
const token = r => r.eventi.filter(e => e.t === 'token')
const finale = r => r.eventi.find(e => e.t === 'done' || e.t === 'error')

const tok = new BPETokenizer(JSON.parse(readFileSync(pub(MODELLO.tokenizer), 'utf8')))
const sessione = await ort.InferenceSession.create(pub(MODELLO.fileKV), { executionProviders: ['cpu'], intraOpNumThreads: 1, interOpNumThreads: 1 })
const passo = creaPasso(sessione, ort.Tensor)

async function locale(c, params, seme) {
  const parziali = []
  const testo = await genera(passo, tok, { userMsg: c.userMsg, history: c.history, params }, { casuale: conSeme(seme), onToken: p => parziali.push(p) })
  return { testo, parziali }
}

const LIM = { temperature: [0.5, 1.5], topP: [0.5, 1], repPenalty: [1, 1.5], maxNew: [1, 200] }
const clampa = p => {
  const o = { ...PARAMETRI_DEFAULT }
  for (const [k, [lo, hi]] of Object.entries(LIM)) if (p[k] !== undefined) o[k] = Math.min(hi, Math.max(lo, p[k]))
  o.maxNew = Math.floor(o.maxNew)
  return o
}

function figli(pid) {
  if (process.platform === 'win32') {
    const cmd = `Get-CimInstance Win32_PerfFormattedData_PerfProc_Process | Where-Object { $_.Name -like 'node*' -and ($_.IDProcess -eq ${pid} -or $_.CreatingProcessID -eq ${pid}) } | ForEach-Object { "$($_.IDProcess) $($_.CreatingProcessID) $($_.WorkingSet) $($_.WorkingSetPrivate)" }`
    return execFileSync('powershell', ['-NoProfile', '-Command', cmd], { encoding: 'utf8' })
      .trim().split(/\r?\n/).filter(Boolean).map(l => l.split(' ').map(Number))
  }
  const out = execFileSync('ps', ['-e', '-o', 'pid=,ppid=,rss='], { encoding: 'utf8' }).trim().split('\n')
  return out.map(l => l.trim().split(/\s+/).map(Number)).filter(([p, pp]) => p === pid || pp === pid).map(([p, pp, rss]) => [p, pp, rss * 1024, rss * 1024])
}
function memoria() {
  if (!PID) return null
  const righe = figli(PID)
  const mb = x => x / 1048576
  const principale = righe.find(r => r[0] === PID)
  const workers = righe.filter(r => r[0] !== PID)
  return {
    principale: mb(principale?.[2] ?? 0),
    workers: workers.map(r => mb(r[2])),
    totale: mb(righe.reduce((a, r) => a + r[2], 0)),
    privato: mb(righe.reduce((a, r) => a + r[3], 0)),
  }
}
const descriviMem = m => `principale ${m.principale.toFixed(0)} MB + ${m.workers.length} worker (${m.workers.map(x => x.toFixed(0)).join('/')} MB) = ${m.totale.toFixed(0)} MB (di cui privati ${m.privato.toFixed(0)} MB)`

console.log(`server ${URL_BASE.origin}  |  CPU locale: ${os.cpus()[0].model.trim()} (${os.cpus().length} thread)  |  node ${process.version}`)
const s0 = await salute()
if (!s0?.ok) {
  console.error('server non raggiungibile o non sano')
  process.exit(2)
}
const SLOT = s0.slot
info(`health: ${JSON.stringify(s0)}`)
const memRiposo = memoria()
if (memRiposo) info(`memoria a riposo: ${descriviMem(memRiposo)}`)

if (SEZIONI.has(1)) {
  titolo('1. Parita col nucleo (51 casi x 2 serie di parametri, a seme fisso, in-process contro server)')
  const serie = [
    { nome: 'parametri sito (T=1, topP=.92, rep=1.15, maxNew=40)', raw: { temperature: 1, topP: 0.92, repPenalty: 1.15, maxNew: 40 } },
    { nome: 'parametri del brief (T=1, topP=0, rep=1, maxNew=40; il server limita topP a .5)', raw: { temperature: 1, topP: 0, repPenalty: 1, maxNew: 40 } },
  ]
  for (const { nome, raw } of serie) {
    let uguali = 0, parzialiDiversi = 0, primoDiverso = '', validi = 0, oltreLimite = 0
    for (let i = 0; i < casi.length; i++) {
      const c = casi[i]
      const seme = 1000 + i
      if (Array.from(c.userMsg.trim()).length > 500) {
        const r = await chiama({ corpo: { message: c.userMsg, history: c.history, params: raw, seme } })
        if (r.stato === 400 && r.json?.error === 'bad_request') oltreLimite++
        else primoDiverso ||= `caso ${i} oltre 500 caratteri non respinto (${r.stato})`
        continue
      }
      validi++
      const atteso = await locale(c, clampa(raw), seme)
      const r = await chiama({ corpo: { message: c.userMsg, history: c.history, params: raw, seme } })
      const fin = finale(r)
      const partServer = token(r).map(e => e.text)
      const stessiParziali = partServer.length === atteso.parziali.length && partServer.every((p, k) => p === atteso.parziali[k])
      if (fin?.t === 'done' && fin.text === atteso.testo) uguali++
      else if (!primoDiverso) primoDiverso = `caso ${i}: server=${JSON.stringify(fin)} locale=${JSON.stringify(atteso.testo)}`
      if (!stessiParziali) parzialiDiversi++
    }
    esito(`${nome}: risposta finale`, uguali === validi && validi + oltreLimite === casi.length, `${uguali}/${validi} identiche; ${oltreLimite} caso/i oltre i 500 caratteri correttamente respinti con 400 ${primoDiverso}`)
    esito(`${nome}: sequenza dei parziali token per token`, parzialiDiversi === 0, `${validi - parzialiDiversi}/${validi} identiche`)
  }
}

if (SEZIONI.has(2)) {
  titolo('2. Streaming vero')
  const campioni = []
  let intestazioniOk = true, aperturaPrima = true
  for (let i = 0; i < 15; i++) {
    const c = casi[i]
    const r = await chiama({ corpo: { message: c.userMsg, history: c.history } })
    const t = token(r)
    const hdr = r.intestazioni
    intestazioniOk &&= r.stato === 200 && hdr['content-type'] === 'text/event-stream; charset=utf-8' && hdr['cache-control'] === 'no-cache, no-transform' &&
      hdr['x-accel-buffering'] === 'no' && hdr.connection === 'keep-alive'
    aperturaPrima &&= r.commenti.length > 0 && r.commenti[0].testo === ': ok' && r.commenti[0].at <= t[0].at
    const distinti = new Set(t.map(e => Math.round(e.at))).size
    campioni.push({ ttft: t[0].at, apertura: r.commenti[0].at, totale: r.tFine, n: t.length, distinti })
  }
  esito('intestazioni SSE e commento di apertura `: ok` prima del primo token', intestazioniOk && aperturaPrima)
  const lunghi = campioni.filter(x => x.n >= 15)
  info(`primo token: p50 ${ms(mediana(campioni.map(x => x.ttft)))}  ·  risposta completa: p50 ${ms(mediana(campioni.map(x => x.totale)))}  ·  token per risposta: p50 ${mediana(campioni.map(x => x.n))}`)
  info(`apertura dello stream (commento): p50 ${ms(mediana(campioni.map(x => x.apertura)))}  ·  istanti di arrivo distinti per risposta: p50 ${mediana(campioni.map(x => x.distinti))} su ${mediana(campioni.map(x => x.n))} token`)
  esito('il primo token arriva molto prima della fine (risposte da >=15 token)', lunghi.length > 0 && lunghi.every(x => x.ttft < 0.5 * x.totale),
    `${lunghi.length} risposte; rapporto primo-token/totale p50 ${(mediana(lunghi.map(x => x.ttft / x.totale))).toFixed(2)}, max ${Math.max(...lunghi.map(x => x.ttft / x.totale)).toFixed(2)}`)
  esito('i token arrivano in momenti diversi (non un blocco unico)', lunghi.every(x => x.distinti >= 0.6 * x.n), `distinti/token p50 ${mediana(lunghi.map(x => x.distinti / x.n)).toFixed(2)}`)
}

if (SEZIONI.has(3)) {
  titolo('3. Validazione e metodi')
  const ok = { message: 'ciao' }
  const lungo = n => 'a'.repeat(n)
  const casiVal = [
    ['messaggio vuoto', { corpo: { message: '' } }, 400, 'bad_request'],
    ['messaggio di soli spazi', { corpo: { message: '   \n ' } }, 400, 'bad_request'],
    ['messaggio assente', { corpo: { history: [] } }, 400, 'bad_request'],
    ['messaggio numerico', { corpo: { message: 5 } }, 400, 'bad_request'],
    ['501 caratteri', { corpo: { message: lungo(501) } }, 400, 'bad_request'],
    ['500 caratteri (limite)', { corpo: { message: lungo(500), params: { maxNew: 1 } } }, 200],
    ['500 caratteri + spazi ai bordi (trim)', { corpo: { message: ` ${lungo(500)} `, params: { maxNew: 1 } } }, 200],
    ['history non array', { corpo: { ...ok, history: 'x' } }, 400, 'bad_request'],
    ['history con elemento senza nicu', { corpo: { ...ok, history: [{ user: 'a' }] } }, 400, 'bad_request'],
    ['history con elemento non oggetto', { corpo: { ...ok, history: [1] } }, 400, 'bad_request'],
    ['history con campo numerico', { corpo: { ...ok, history: [{ user: 'a', nicu: 3 }] } }, 400, 'bad_request'],
    ['history da 21 elementi', { corpo: { ...ok, history: Array(21).fill({ user: 'a', nicu: 'b' }) } }, 400, 'bad_request'],
    ['history da 20 elementi (limite)', { corpo: { ...ok, params: { maxNew: 1 }, history: Array(20).fill({ user: 'a', nicu: 'b' }) } }, 200],
    ['history con campo da 2001 caratteri', { corpo: { ...ok, history: [{ user: lungo(2001), nicu: 'b' }] } }, 400, 'bad_request'],
    ['history con campo da 2000 caratteri (limite)', { corpo: { ...ok, params: { maxNew: 1 }, history: [{ user: lungo(2000), nicu: lungo(2000) }] } }, 200],
    ['params non oggetto', { corpo: { ...ok, params: 'x' } }, 400, 'bad_request'],
    ['params con valore non numerico', { corpo: { ...ok, params: { temperature: 'calda' } } }, 400, 'bad_request'],
    ['session da 65 caratteri', { corpo: { ...ok, session: lungo(65) } }, 400, 'bad_request'],
    ['session da 64 caratteri (limite)', { corpo: { ...ok, params: { maxNew: 1 }, session: lungo(64) } }, 200],
    ['session non stringa', { corpo: { ...ok, session: 12 } }, 400, 'bad_request'],
    ['corpo non JSON', { crudo: 'non e json{' }, 400, 'bad_request'],
    ['corpo vuoto', { crudo: '' }, 400, 'bad_request'],
    ['corpo JSON ma array', { crudo: '[1,2]' }, 400, 'bad_request'],
    ['corpo da 70 KB (Content-Length)', { crudo: JSON.stringify({ message: 'ciao', x: lungo(70 * 1024) }) }, 413, 'payload_too_large'],
    ['corpo da 70 KB (chunked, senza Content-Length)', { crudo: JSON.stringify({ message: 'ciao', x: lungo(70 * 1024) }), chunked: true }, 413, 'payload_too_large'],
    ['corpo da 3 MB', { crudo: JSON.stringify({ message: 'ciao', x: lungo(3 * 1024 * 1024) }) }, 413, 'payload_too_large'],
    ['GET /api/chat', { metodo: 'GET' }, 405, 'method_not_allowed'],
    ['PUT /api/chat', { metodo: 'PUT', corpo: ok }, 405, 'method_not_allowed'],
    ['DELETE /api/chat', { metodo: 'DELETE' }, 405, 'method_not_allowed'],
    ['POST /api/chat/health', { path: '/api/chat/health', corpo: ok }, 405, 'method_not_allowed'],
    ['GET su percorso ignoto', { metodo: 'GET', path: '/api/altro' }, 404, 'not_found'],
  ]
  for (const [nome, opz, stato, codice] of casiVal) {
    const r = await chiama(opz)
    const ok = r.stato === stato && (codice ? r.json?.error === codice : r.eventi.at(-1)?.t === 'done')
    esito(nome, ok, `${r.stato}${r.json ? ' ' + JSON.stringify(r.json) : ''}${r.errore ? ' errore: ' + r.errore : ''}${ok ? '' : ` (atteso ${stato}${codice ? ' ' + codice : ''})`}`)
  }
  const r405 = await chiama({ metodo: 'GET' })
  esito('405 con header Allow: POST', r405.intestazioni.allow === 'POST', r405.intestazioni.allow)

  const estremi = { temperature: 99, topP: 0, repPenalty: 9, maxNew: 100000 }
  const bassi = { temperature: -3, topP: 7, repPenalty: 0, maxNew: -5 }
  for (const [nome, raw] of [['sopra/sotto i limiti (T=99, topP=0, rep=9, maxNew=1e5)', estremi], ['all\'opposto (T=-3, topP=7, rep=0, maxNew=-5)', bassi]]) {
    const c = casi[3]
    const atteso = await locale(c, clampa(raw), 77)
    const r = await chiama({ corpo: { message: c.userMsg, history: c.history, params: raw, seme: 77 } })
    esito(`clamp dei parametri ${nome}`, finale(r)?.text === atteso.testo && r.stato === 200,
      `parametri applicati ${JSON.stringify(clampa(raw))}, ${token(r).length} token`)
  }
  const r1 = await chiama({ corpo: { message: 'ciao Nicu', params: { maxNew: 0 } } })
  esito('maxNew=0 portato a 1: al piu un token', token(r1).length <= 1 && finale(r1)?.t === 'done', `${token(r1).length} token`)
  const rd = await chiama({ corpo: { message: 'ciao Nicu', params: null, history: null, session: null } })
  esito('params/history/session null = mancanti', rd.stato === 200 && finale(rd)?.t === 'done')
  const h = await salute()
  esito('health: forma della risposta', h.ok === true && h.model === MODELLO.id && Number.isInteger(h.attivi) && Number.isInteger(h.in_coda) && h.slot === SLOT, JSON.stringify(h))
  const rh = await chiama({ metodo: 'GET', path: '/api/chat/health' })
  esito('assenza di intestazioni CORS', !Object.keys(rh.intestazioni).some(k => k.startsWith('access-control')))
}

if (SEZIONI.has(4)) {
  titolo('4. Rate limit e server occupato')
  const ip = 'rl-test-1'
  const stati = []
  for (let i = 0; i < 21; i++) stati.push((await chiama({ ip, corpo: { message: 'ciao', params: { maxNew: 1 } } })))
  const prime = stati.slice(0, 20).filter(r => r.stato === 200).length
  const r21 = stati[20]
  const ra = Number(r21.intestazioni['retry-after'])
  esito('le prime 20 richieste in un minuto passano', prime === 20, `${prime}/20`)
  esito('la 21a riceve 429 rate_limit con Retry-After', r21.stato === 429 && r21.json?.error === 'rate_limit' && ra >= 1 && ra <= 60, `${r21.stato} ${JSON.stringify(r21.json)} Retry-After=${ra}`)
  const altroIp = await chiama({ ip: 'rl-test-2', corpo: { message: 'ciao', params: { maxNew: 1 } } })
  esito('un altro IP non e toccato', altroIp.stato === 200)
  const xffPrimo = await chiama({ ip: 'rl-test-1, 9.9.9.9', corpo: { message: 'ciao', params: { maxNew: 1 } } })
  esito('X-Forwarded-For: conta il primo valore (stesso primo = limitato)', xffPrimo.stato === 429, String(xffPrimo.stato))
  const xffAltro = await chiama({ ip: 'rl-test-3, rl-test-1', corpo: { message: 'ciao', params: { maxNew: 1 } } })
  esito('X-Forwarded-For: il secondo valore e ignorato', xffAltro.stato === 200, String(xffAltro.stato))
  const senzaXff = await chiama({ ip: '', intestazioni: { 'X-Forwarded-For': '' }, corpo: { message: 'ciao', params: { maxNew: 1 } } })
  esito('senza X-Forwarded-For si usa l\'IP del socket', senzaXff.stato === 200, String(senzaXff.stato))
  const t429 = performance.now()
  info(`attendo ${ra + 1} s per vedere la finestra scorrere...`)
  await dormi((ra + 1) * 1000)
  const dopo = await chiama({ ip, corpo: { message: 'ciao', params: { maxNew: 1 } } })
  esito('trascorso Retry-After lo stesso IP passa di nuovo', dopo.stato === 200, `${dopo.stato} dopo ${((performance.now() - t429) / 1000).toFixed(1)} s`)

  const N = 40
  const t0 = performance.now()
  const rr = await Promise.all(Array.from({ length: N }, (_, i) => chiama({ corpo: { message: casi[i % casi.length].userMsg, history: casi[i % casi.length].history } })))
  const okN = rr.filter(r => r.stato === 200 && finale(r)?.t === 'done'), busy = rr.filter(r => r.stato === 503)
  const altri = rr.filter(r => r.stato !== 200 && r.stato !== 503)
  const conRetry = busy.every(r => r.json?.error === 'busy' && Number(r.intestazioni['retry-after']) >= 1)
  esito(`${N} richieste simultanee: gli ammessi sono slot+coda, il resto 503 busy con Retry-After`, busy.length > 0 && conRetry && altri.length === 0 && okN.length >= SLOT,
    `${okN.length} servite, ${busy.length} respinte con 503, altri ${altri.length}; ultimo servito dopo ${ms(Math.max(...okN.map(r => r.tFine)))}`)
  await dormi(100)
  const h = await salute()
  esito('dopo il picco slot e coda tornano vuoti', h.attivi === 0 && h.in_coda === 0, JSON.stringify(h))
}

if (SEZIONI.has(5)) {
  titolo('5. Disconnessione del client')
  const lunga = { temperature: 1.5, topP: 1, repPenalty: 1, maxNew: 200 }
  const messaggioLungo = 'raccontami una storia lunga su Catania'
  let seme = 0, base = null
  for (let s = 1; s <= 40; s++) {
    const r = await chiama({ corpo: { message: messaggioLungo, params: lunga, seme: s } })
    if (!base || token(r).length > token(base).length) {
      base = r
      seme = s
    }
  }
  if (token(base).length < 40) esito('trovare una generazione lunga per il test', false, `nessun seme sopra 40 token (massimo ${token(base).length})`)
  else {
    info(`generazione di riferimento (seme ${seme}): ${token(base).length} token in ${ms(base.tFine)}`)
    const p = chiama({ corpo: { message: messaggioLungo, params: lunga, seme }, distruggiAlToken: 5 })
    const r = await p
    const t0 = performance.now()
    let h = await salute(), liberoDopo = null
    const attiviSubito = h.attivi
    while (performance.now() - t0 < 3000) {
      h = await salute()
      if (h.attivi === 0) {
        liberoDopo = performance.now() - t0
        break
      }
      await dormi(2)
    }
    esito('client scollegato a meta: lo slot torna libero subito, non a fine generazione', liberoDopo !== null && liberoDopo < base.tFine / 3,
      `slot occupati subito dopo la chiusura: ${attiviSubito}; liberi dopo ${liberoDopo === null ? '>3000' : liberoDopo.toFixed(0)} ms (generazione completa: ${ms(base.tFine)}, scollegato dopo ${ms(r.tFine)})`)
  }

  const lungaCorpo = { message: messaggioLungo, params: lunga, seme }
  const N = SLOT + 3
  const clienti = Array.from({ length: N }, () => {
    const ip = ipNuovo()
    return { ip, req: chiamaDistruggibile({ ip, corpo: lungaCorpo }) }
  })
  let stato = null
  for (let i = 0; i < 100; i++) {
    stato = await salute()
    if (stato.attivi === SLOT && stato.in_coda === 3) break
    await dormi(5)
  }
  esito(`${SLOT} generazioni attive + 3 in coda`, stato.attivi === SLOT && stato.in_coda === 3, JSON.stringify(stato))
  for (const c of clienti.slice(SLOT)) c.req.destroy()
  await dormi(50)
  stato = await salute()
  esito('3 client in coda si scollegano: la coda si svuota', stato.in_coda === 0 && stato.attivi >= 0, JSON.stringify(stato))
  for (const c of clienti.slice(0, SLOT)) c.req.destroy()
  const t1 = performance.now()
  let libero = null
  while (performance.now() - t1 < 3000) {
    stato = await salute()
    if (stato.attivi === 0 && stato.in_coda === 0) {
      libero = performance.now() - t1
      break
    }
    await dormi(2)
  }
  esito(`${SLOT} client attivi si scollegano: tutti gli slot tornano liberi`, libero !== null, libero === null ? JSON.stringify(stato) : `liberi dopo ${libero.toFixed(0)} ms`)
  const dopo = await chiama({ corpo: { message: 'ciao Nicu' } })
  esito('il servizio risponde normalmente dopo le disconnessioni', dopo.stato === 200 && finale(dopo)?.t === 'done')
}

function chiamaDistruggibile({ ip, corpo }) {
  const dati = JSON.stringify(corpo)
  const req = http.request({
    host: URL_BASE.hostname, port: URL_BASE.port, path: '/api/chat', method: 'POST',
    headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(dati), 'X-Forwarded-For': ip },
    agent: false,
  }, res => res.resume())
  req.on('error', () => {})
  req.end(dati)
  return req
}

async function carico({ nome, utenti, intervalloS, durataS, campionaMemoria }) {
  const utentiRis = []
  const risultati = []
  const fine = performance.now() + durataS * 1000
  const messaggi = casi.map(c => c.userMsg).filter(m => Array.from(m.trim()).length <= 500)
  let picco = null
  const timerMem = campionaMemoria && PID ? setInterval(() => {
    const m = memoria()
    if (!picco || m.privato > picco.privato) picco = m
  }, 2000) : null
  const t0 = performance.now()
  await Promise.all(Array.from({ length: utenti }, async (_, u) => {
    const ip = ipNuovo()
    const storia = []
    await dormi(Math.random() * intervalloS * 1000)
    for (let k = 0; performance.now() < fine; k++) {
      const inizio = performance.now()
      const message = messaggi[(u * 7 + k) % messaggi.length]
      const r = await chiama({ ip, corpo: { message, history: storia.slice(-3), session: `u${u}` } })
      const fin = finale(r)
      const t = token(r)
      risultati.push({ stato: r.stato, ok: r.stato === 200 && fin?.t === 'done', n: t.length, ttft: t[0]?.at, totale: r.tFine, causa: `${r.stato} ${r.errore ?? ''} ${r.json ? JSON.stringify(r.json) : ''} ${fin?.t === 'error' ? 'evento error ' + fin.code : ''}`.trim() })
      if (fin?.t === 'done') storia.push({ user: message, nicu: fin.text })
      const prossimo = inizio + intervalloS * 1000 * (0.8 + 0.4 * Math.random())
      const attesa = prossimo - performance.now()
      if (attesa > 0) await dormi(attesa)
    }
  }))
  const durata = (performance.now() - t0) / 1000
  if (timerMem) clearInterval(timerMem)
  const buoni = risultati.filter(r => r.ok)
  const tokTot = buoni.reduce((a, r) => a + r.n, 0)
  const errori = risultati.filter(r => !r.ok)
  const per503 = errori.filter(r => r.stato === 503).length
  const ttft = buoni.map(r => r.ttft), tot = buoni.map(r => r.totale)
  console.log(`   ${nome}: ${utenti} utenti, un messaggio ogni ~${intervalloS} s, ${durataS} s di invio (${durata.toFixed(0)} s con il completamento)`)
  const cause = {}
  for (const e of errori) cause[e.causa] = (cause[e.causa] ?? 0) + 1
  if (errori.length) info(`cause degli errori: ${JSON.stringify(cause)}`)
  info(`richieste ${risultati.length} (${(risultati.length / durata).toFixed(1)}/s), riuscite ${buoni.length}, errori ${errori.length} (di cui 503: ${per503}, altri: ${errori.length - per503})`)
  info(`primo token: p50 ${ms(perc(ttft, 50))} · p95 ${ms(perc(ttft, 95))} · max ${ms(Math.max(...ttft))}`)
  info(`risposta completa: p50 ${ms(perc(tot, 50))} · p95 ${ms(perc(tot, 95))} · max ${ms(Math.max(...tot))}`)
  info(`token/s aggregati: ${(tokTot / durata).toFixed(0)} medi su tutta la prova · token per risposta p50 ${perc(buoni.map(r => r.n), 50)}`)
  if (picco) info(`memoria al picco: ${descriviMem(picco)}`)
  return { risultati, buoni, errori, ttft, tot, durata, tokTot, picco }
}

let ultimoPicco = null
if (SEZIONI.has(6)) {
  titolo('6. Carico')
  const reale = await carico({ nome: 'REALE', utenti: UTENTI, intervalloS: 20, durataS: DURATA_REALE, campionaMemoria: true })
  esito('carico reale: nessun errore', reale.errori.length === 0, `${reale.errori.length} errori su ${reale.risultati.length}`)
  esito('carico reale: primo token p95 < 400 ms (obiettivo del piano)', perc(reale.ttft, 95) < 400, ms(perc(reale.ttft, 95)))
  const x5 = await carico({ nome: 'ACCELERATO x5', utenti: UTENTI, intervalloS: 4, durataS: 40, campionaMemoria: true })
  info(`(un messaggio ogni 4 s per utente: ${UTENTI / 4} richieste/s offerte)`)
  const x10 = await carico({ nome: 'STRESS x10', utenti: UTENTI, intervalloS: 2, durataS: 40, campionaMemoria: true })
  info(`(un messaggio ogni 2 s per utente: ${UTENTI / 2} richieste/s offerte)`)
  ultimoPicco = [reale.picco, x5.picco, x10.picco].filter(Boolean).sort((a, b) => b.privato - a.privato)[0] ?? null
  await dormi(300)
  const h = await salute()
  esito('dopo il carico slot e coda sono vuoti', h.attivi === 0 && h.in_coda === 0, JSON.stringify(h))
}

if (SEZIONI.has(7)) {
  titolo('7. Memoria')
  if (!PID) info('passa --pid=<pid del server> per misurare la memoria (RSS su Linux, working set su Windows)')
  else {
    const m = memoria()
    info(`a riposo (inizio collaudo): ${memRiposo ? descriviMem(memRiposo) : '-'}`)
    info(`a riposo (ora, dopo il collaudo): ${descriviMem(m)}`)
    if (ultimoPicco) info(`sotto carico (picco campionato ogni 2 s): ${descriviMem(ultimoPicco)}`)
    const peggio = Math.max(m.privato, ultimoPicco?.privato ?? 0)
    esito('memoria privata totale sotto il limite di 1 GB del container', peggio < 1024, `${peggio.toFixed(0)} MB`)
  }
}

console.log(fallimenti ? `\n${fallimenti} CONTROLLI FALLITI` : '\nTUTTI I CONTROLLI PASSANO')
agente.destroy()
process.exit(fallimenti ? 1 : 0)
