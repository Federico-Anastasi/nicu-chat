import { useState, useEffect, useRef, useCallback } from 'react'
import { loadModel, generate, DEFAULT_PARAMS, MODEL_ID, MAX_HISTORY_TURNS } from './lib/inference'
import { loadTokenizer } from './lib/tokenizer'
import { logTurn, newSession } from './lib/logger'
import { shareExchange } from './lib/share'

import type { BPETokenizer } from './lib/tokenizer'
import type { GenerationParams, ExecutionBackend, LoadResult, HistoryTurn } from './lib/inference'

// ---------------------------------------------------------------------------
// Tipi
// ---------------------------------------------------------------------------

type AppStatus = 'loading' | 'ready' | 'generating' | 'error'

interface Message {
  id: number
  role: 'user' | 'nicu'
  text: string
  streaming?: boolean
}

// ---------------------------------------------------------------------------
// Prompt suggeriti — mix di "trabocchetti" (la deviazione è la battuta)
// e prompt in-mondo (dove Nicu è imbattibile).
// ---------------------------------------------------------------------------

const SUGGESTED_PROMPTS = [
  'Ciao Nicu! Chi sei?',
  'Che si mangia di bello a Catania?',
  'Che facciamo stasera?',
  'Com\'è la festa di Sant\'Agata?',
]

// ---------------------------------------------------------------------------
// Link "per i curiosi" nel modal info — solo quelli valorizzati vengono resi.
// ---------------------------------------------------------------------------

// Sullo Space Hugging Face il pubblico è internazionale: una riga in inglese
// avvisa che Nicu parla solo italiano. Sul nostro dominio non appare.
const IS_HF_SPACE =
  typeof window !== 'undefined' && window.location.host.endsWith('.hf.space')

const CURIOUS_LINKS = {
  github: 'https://github.com/Federico-Anastasi/nicu-chat',
  huggingface: 'https://huggingface.co/federico-anastasi/nicu-20m',
  x: 'https://x.com/FedeAnastasi',
}

// ---------------------------------------------------------------------------
// Avatar di Nicu — la faccia del personaggio, usata ovunque (niente più "N").
// ---------------------------------------------------------------------------

// NicuFace — l'avatar-personaggio (PNG). 'idle'/'happy' sono cerchi;
// 'boh' (la spallucciata "non lo so") è quadrata perché le mani escono dal cerchio.
type NicuMood = 'idle' | 'happy' | 'boh'
function NicuFace({ mood = 'idle', size = 40, className }: { mood?: NicuMood; size?: number; className?: string }) {
  const round = mood !== 'boh'
  return (
    <img
      src={`/nicu-${mood}.png`}
      width={size}
      height={size}
      alt="Nicu"
      className={'nicu-face' + (className ? ' ' + className : '')}
      style={{ borderRadius: round ? '50%' : 0, objectFit: 'cover', display: 'block' }}
    />
  )
}

// ---------------------------------------------------------------------------
// Icone SVG (MAI emoji) — stroke = colore corrente del bottone
// ---------------------------------------------------------------------------
const ico = {
  width: 15, height: 15, viewBox: '0 0 24 24', fill: 'none',
  stroke: 'currentColor', strokeWidth: 2, strokeLinecap: 'round' as const,
  strokeLinejoin: 'round' as const, style: { verticalAlign: '-2px', flexShrink: 0 },
}
const IconShare = () => (<svg {...ico}><path d="M4 12v7a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2v-7" /><path d="M12 16V3" /><path d="m7 8 5-5 5 5" /></svg>)
const IconCheck = () => (<svg {...ico}><path d="M20 6 9 17l-5-5" /></svg>)
const IconInfo = () => (<svg {...ico}><circle cx="12" cy="12" r="10" /><path d="M12 16v-4M12 8h.01" /></svg>)
const IconRefresh = () => (<svg {...ico}><path d="M21 12a9 9 0 1 1-3-6.7" /><path d="M21 3v5h-5" /></svg>)
const IconSend = () => (<svg {...ico}><path d="M22 2 11 13" /><path d="M22 2 15 22l-4-9-9-4 20-7z" /></svg>)
const IconClose = () => (<svg {...ico}><path d="M18 6 6 18" /><path d="m6 6 12 12" /></svg>)
const IconChevron = ({ className }: { className?: string }) => (<svg {...ico} className={className}><path d="m6 9 6 6 6-6" /></svg>)

// ---------------------------------------------------------------------------
// Bottone "Condividi" — genera la card immagine e la condivide (WhatsApp/IG)
// ---------------------------------------------------------------------------

function ShareButton({ userText, nicuText }: { userText: string; nicuText: string }) {
  const [state, setState] = useState<'idle' | 'busy' | 'done'>('idle')

  const onClick = async () => {
    if (state === 'busy') return
    setState('busy')
    await shareExchange(userText, nicuText)
    setState('done')
    setTimeout(() => setState('idle'), 2200)
  }

  return (
    <button className="share-btn" onClick={onClick} disabled={state === 'busy'} aria-label="Condividi">
      {state === 'busy'
        ? <span className="share-lbl">Condivido…</span>
        : state === 'done'
        ? <><IconCheck /><span className="share-lbl">Fatto</span></>
        : <><IconShare /><span className="share-lbl">Condividi</span></>}
    </button>
  )
}

// ---------------------------------------------------------------------------
// Componente: Bolla del messaggio
// ---------------------------------------------------------------------------

interface BubbleProps {
  message: Message
  prevUserText?: string
}

function ChatBubble({ message, prevUserText }: BubbleProps) {
  const isNicu = message.role === 'nicu'
  // In streaming senza ancora testo: puntini animati al posto della bolla
  // vuota. Al primo token (text.length > 0) i puntini lasciano subito il
  // posto al testo che arriva via streaming.
  const isTyping = isNicu && !!message.streaming && message.text.length === 0
  const canShare = isNicu && !!prevUserText && !message.streaming && message.text.length > 0
  return (
    <div className={`bubble-row ${isNicu ? 'nicu-row' : 'user-row'}`}>
      {isNicu && <NicuFace mood="idle" size={32} className="avatar-mark" />}
      <div className="bubble-col">
        {isTyping ? (
          <div className="bubble bubble-nicu typing-indicator">
            <span /><span /><span />
          </div>
        ) : (
          <div className={`bubble ${isNicu ? 'bubble-nicu' : 'bubble-user'}`}>
            {message.text}
            {message.streaming && <span className="cursor-blink" />}
          </div>
        )}
        {canShare && <ShareButton userText={prevUserText!} nicuText={message.text} />}
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Componente: Schermata di caricamento
// ---------------------------------------------------------------------------

interface LoadingScreenProps {
  progress: number
  statusMsg: string
}

// Battute catanesi che ruotano durante l'attesa: l'attesa diventa parte
// del personaggio invece di una barra muta che fa rimbalzare l'utente.
const LOADING_QUIPS = [
  'Sto accendendo la griglia…',
  'Chiamo mio cugino, un attimo…',
  'Scendo dall\'Etna, arrivo…',
  'Mi metto la coppola…',
  'Sciacquo le cozze, mbare…',
  'Preparo le polpette di cavallo…',
  'Parcheggio in doppia fila…',
]

function LoadingScreen({ progress, statusMsg }: LoadingScreenProps) {
  const [quip, setQuip] = useState(0)
  useEffect(() => {
    const t = setInterval(() => setQuip(q => (q + 1) % LOADING_QUIPS.length), 2000)
    return () => clearInterval(t)
  }, [])
  return (
    <div className="loading-screen">
      <div className="loading-card">
        <NicuFace mood="boh" size={104} className="loading-mark" />
        <h1 className="loading-title">Nicu</h1>
        <p className="loading-tagline">l'amico catanese che ti strappa un sorriso</p>
        <div className="progress-bar-outer">
          <div
            className="progress-bar-inner"
            style={{ width: `${progress}%` }}
          />
        </div>
        <p className="loading-quip" key={quip}>{LOADING_QUIPS[quip]}</p>
        <p className="loading-note">
          {statusMsg} · si scarica una sola volta, poi resta sul tuo telefono.
        </p>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Componente: Controlli avanzati
// ---------------------------------------------------------------------------

interface ControlsProps {
  params: GenerationParams
  onChange: (p: GenerationParams) => void
  memoryOn: boolean
  onToggleMemory: (v: boolean) => void
}

function AdvancedControlsPanel({ params, onChange, memoryOn, onToggleMemory }: ControlsProps) {
  return (
    <div className="controls-panel">
          <div className="control-row">
            <label style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', cursor: 'pointer' }}>
              <input type="checkbox" checked={memoryOn} onChange={e => onToggleMemory(e.target.checked)} style={{ width: 'auto' }} />
              Memoria della conversazione
            </label>
          </div>
          <div className="control-row">
            <label>Temperatura <span className="val">{params.temperature.toFixed(2)}</span></label>
            <input
              type="range" min="0.1" max="2.0" step="0.05"
              value={params.temperature}
              onChange={e => onChange({ ...params, temperature: parseFloat(e.target.value) })}
            />
          </div>
          <div className="control-row">
            <label>Top-p (nucleo) <span className="val">{params.topP.toFixed(2)}</span></label>
            <input
              type="range" min="0.5" max="1.0" step="0.01"
              value={params.topP}
              onChange={e => onChange({ ...params, topP: parseFloat(e.target.value) })}
            />
          </div>
          <div className="control-row">
            <label>Repetition penalty <span className="val">{params.repPenalty.toFixed(2)}</span></label>
            <input
              type="range" min="1.0" max="2.0" step="0.05"
              value={params.repPenalty}
              onChange={e => onChange({ ...params, repPenalty: parseFloat(e.target.value) })}
            />
          </div>
          <div className="control-row">
            <label>Max token <span className="val">{params.maxNew}</span></label>
            <input
              type="range" min="20" max="300" step="10"
              value={params.maxNew}
              onChange={e => onChange({ ...params, maxNew: parseInt(e.target.value) })}
            />
          </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// Componente: Modal "Cos'è Nicu?" — overlay centrato (sheet su mobile),
// contiene anche le Impostazioni avanzate collassate (niente più fascia
// che sposta il layout).
// ---------------------------------------------------------------------------

interface InfoModalProps extends ControlsProps {
  open: boolean
  onClose: () => void
}

function InfoModal({ open, onClose, params, onChange, memoryOn, onToggleMemory }: InfoModalProps) {
  const [advancedOpen, setAdvancedOpen] = useState(false)

  useEffect(() => {
    if (!open) return
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose() }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [open, onClose])

  if (!open) return null

  const curiousEntries = ([
    CURIOUS_LINKS.github && { label: 'GitHub', href: CURIOUS_LINKS.github },
    CURIOUS_LINKS.huggingface && { label: 'Hugging Face', href: CURIOUS_LINKS.huggingface },
    CURIOUS_LINKS.x && { label: 'X', href: CURIOUS_LINKS.x },
  ].filter(Boolean) as { label: string; href: string }[])

  return (
    <div className="modal-backdrop" onClick={onClose}>
      <div className="modal-sheet" onClick={e => e.stopPropagation()} role="dialog" aria-modal="true" aria-label="Cos'è Nicu?">
        <button className="modal-close" onClick={onClose} aria-label="Chiudi">
          <IconClose />
        </button>
        <div className="modal-content">
          <div className="modal-head">
            <NicuFace mood="happy" size={44} className="modal-mark" />
            <h2 className="modal-title">Cos'è Nicu?</h2>
          </div>
          <div className="modal-copy">
            <p>
              Nicu <strong>non è ChatGPT</strong>: non ti scrive l'email, non ti fa il riassunto.
              Ti fa compagnia e ti fa ridere — tutto qui.
            </p>
            <p>
              Conosce solo il suo piccolo mondo: Catania, il mare, la griglia, gli amici.
              Su tutto il resto <strong>devia senza inventare</strong> — chiedigli la capitale
              d'Italia e ti risponde di polpette di cavallo. È il suo bello.
            </p>
            <p>
              Ed è <strong>tutto tuo</strong>: Nicu vive nel tuo telefono e ti risponde
              anche senza connessione, ovunque sei.
            </p>
          </div>
          <div className="modal-curious">
            <p>
              <strong>Per i curiosi:</strong> Nicu è un'AI minuscola costruita da zero,
              migliaia di volte più piccola di ChatGPT — per questo sta in un telefono.
            </p>
            {curiousEntries.length > 0 && (
              <p className="modal-curious-links">
                {curiousEntries.map((c, i) => (
                  <span key={c.label}>
                    {i > 0 && ' · '}
                    <a href={c.href} target="_blank" rel="noopener noreferrer">{c.label}</a>
                  </span>
                ))}
              </p>
            )}
          </div>
          <div className="modal-advanced">
            <button
              type="button"
              className="modal-advanced-toggle"
              onClick={() => setAdvancedOpen(o => !o)}
              aria-expanded={advancedOpen}
            >
              <IconChevron className={advancedOpen ? 'chevron-open' : ''} />
              Impostazioni avanzate
            </button>
            {advancedOpen && (
              <AdvancedControlsPanel
                params={params}
                onChange={onChange}
                memoryOn={memoryOn}
                onToggleMemory={onToggleMemory}
              />
            )}
          </div>
          <p className="modal-footer-link">
            <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy e condizioni d'uso</a>
          </p>
        </div>
      </div>
    </div>
  )
}

// ---------------------------------------------------------------------------
// PrivacyLine — micro-riga sempre visibile sotto il composer: è l'informativa.
// ---------------------------------------------------------------------------

function PrivacyLine({ className }: { className?: string }) {
  return (
    <p className={'hero-privacy-note' + (className ? ' ' + className : '')}>
      Scrivendo a Nicu accetti che le chat siano salvate per migliorarlo — niente dati personali ·{' '}
      <a href="/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a>
    </p>
  )
}

// ---------------------------------------------------------------------------
// Composer — l'input "a pillola" col bottone tondo dentro
// ---------------------------------------------------------------------------

interface ComposerProps {
  input: string
  onChange: (v: string) => void
  onKeyDown: (e: React.KeyboardEvent<HTMLTextAreaElement>) => void
  onSubmit: (e: React.FormEvent) => void
  generating: boolean
}

function Composer({ input, onChange, onKeyDown, onSubmit, generating }: ComposerProps) {
  const taRef = useRef<HTMLTextAreaElement | null>(null)

  // Auto-resize: cresce con il testo fino a max-height (da CSS), poi scrolla.
  // Si ricalcola a ogni cambio di `input` (anche quando si svuota dopo l'invio).
  useEffect(() => {
    const ta = taRef.current
    if (!ta) return
    ta.style.height = 'auto'
    ta.style.height = `${ta.scrollHeight}px`
  }, [input])

  return (
    <form className="input-form" onSubmit={onSubmit}>
      <textarea
        ref={taRef}
        className="chat-input"
        value={input}
        onChange={e => onChange(e.target.value)}
        onKeyDown={onKeyDown}
        placeholder="Scrivi a Nicu…"
        rows={1}
        disabled={generating}
      />
      <button
        type="submit"
        className="send-btn"
        disabled={generating || !input.trim()}
        aria-label="Invia"
      >
        {generating ? '…' : <IconSend />}
      </button>
    </form>
  )
}

// ---------------------------------------------------------------------------
// App principale
// ---------------------------------------------------------------------------

let msgCounter = 0

export default function App() {
  const [status, setStatus] = useState<AppStatus>('loading')
  const [loadProgress, setLoadProgress] = useState(0)
  const [loadMsg, setLoadMsg] = useState('Inizializzazione…')
  const [errorMsg, setErrorMsg] = useState('')
  const [backend, setBackend] = useState<ExecutionBackend>('unknown')
  // engineMode (worker/mainthread) non è più mostrato in UI; resta solo il log del backend.

  const [messages, setMessages] = useState<Message[]>([])
  const [input, setInput] = useState('')
  const [params, setParams] = useState<GenerationParams>(DEFAULT_PARAMS)
  const [infoOpen, setInfoOpen] = useState(false)
  const [memoryOn, setMemoryOn] = useState(true)   // memoria = passa la storia della chat al modello

  const sessionRef = useRef<LoadResult['session'] | null>(null)
  const tokenizerRef = useRef<BPETokenizer | null>(null)
  const bottomRef = useRef<HTMLDivElement | null>(null)
  const abortRef = useRef<AbortController | null>(null)
  const historyRef = useRef<HistoryTurn[]>([])     // turni precedenti (Utente↔Nicu) per la memoria

  // -------------------------------------------------------------------------
  // Caricamento modello + tokenizer all'avvio
  // -------------------------------------------------------------------------
  useEffect(() => {
    let cancelled = false

    async function init() {
      try {
        // Carica tokenizer (piccolo, quasi immediato)
        const tok = await loadTokenizer('/bpe_synth.json')
        if (cancelled) return
        tokenizerRef.current = tok

        // Carica modello ONNX (38 MB, con progress)
        const { session, backend: be } = await loadModel(
          '/nicu-l-v9-sft.onnx',
          (pct, msg) => {
            if (!cancelled) {
              setLoadProgress(pct)
              setLoadMsg(msg)
            }
          }
        )
        if (cancelled) return

        sessionRef.current = session
        setBackend(be)
        setStatus('ready')
        // Nessun messaggio automatico: è l'utente che apre la conversazione.
        setMessages([])
      } catch (e) {
        if (!cancelled) {
          setErrorMsg(String(e))
          setStatus('error')
        }
      }
    }

    init()
    return () => { cancelled = true }
  }, [])

  // -------------------------------------------------------------------------
  // Auto-scroll
  // -------------------------------------------------------------------------
  useEffect(() => {
    bottomRef.current?.scrollIntoView({ behavior: 'smooth' })
  }, [messages])

  // -------------------------------------------------------------------------
  // Invio messaggio e generazione risposta
  // -------------------------------------------------------------------------
  const sendMessage = useCallback(async (text: string) => {
    if (!text.trim() || status !== 'ready') return
    if (!sessionRef.current || !tokenizerRef.current) return

    setInput('')
    setStatus('generating')

    // Aggiunge il messaggio dell'utente
    const userMsg: Message = { id: ++msgCounter, role: 'user', text: text.trim() }
    const nicuMsg: Message = { id: ++msgCounter, role: 'nicu', text: '', streaming: true }
    setMessages(prev => [...prev, userMsg, nicuMsg])

    // Abort controller per fermare la generazione
    const ctrl = new AbortController()
    abortRef.current = ctrl

    const clean = text.trim()
    let finalText = ''
    try {
      await generate(
        sessionRef.current,
        tokenizerRef.current,
        clean,
        params,
        (partial) => {
          finalText = partial
          setMessages(prev =>
            prev.map(m =>
              m.id === nicuMsg.id ? { ...m, text: partial, streaming: true } : m
            )
          )
        },
        ctrl.signal,
        memoryOn ? historyRef.current : []   // memoria ON → passa la storia; OFF → stateless
      )
    } catch (e) {
      console.error('Errore di generazione:', e)
    } finally {
      // Aggiorna la storia della conversazione (per la memoria del turno successivo)
      historyRef.current = [...historyRef.current, { user: clean, nicu: finalText }]
      // Logga lo scambio (fire-and-forget, non blocca nulla)
      logTurn({
        user: clean,
        nicu: finalText,
        params: {
          ...params,
          memory: memoryOn,
          turns: memoryOn ? Math.min(historyRef.current.length - 1, MAX_HISTORY_TURNS) : 0,
        },
        backend,
        model: MODEL_ID,
      })
      // Rimuove il cursore di streaming
      setMessages(prev =>
        prev.map(m =>
          m.id === nicuMsg.id ? { ...m, streaming: false } : m
        )
      )
      setStatus('ready')
      abortRef.current = null
    }
  }, [status, params, memoryOn])

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault()
    sendMessage(input)
  }

  // Nuova chat: azzera i messaggi e apre una nuova sessione di log (niente reload)
  const resetChat = useCallback(() => {
    abortRef.current?.abort()
    newSession()
    historyRef.current = []            // nuova chat = memoria azzerata
    setMessages([])
    setInput('')
    setStatus('ready')
  }, [])

  const handleKeyDown = (e: React.KeyboardEvent<HTMLTextAreaElement>) => {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      sendMessage(input)
    }
  }

  // -------------------------------------------------------------------------
  // Render schermata di caricamento
  // -------------------------------------------------------------------------
  if (status === 'loading') {
    return <LoadingScreen progress={loadProgress} statusMsg={loadMsg} />
  }

  if (status === 'error') {
    return (
      <div className="loading-screen">
        <div className="loading-card error-card">
          <h2>Errore di caricamento</h2>
          <p className="error-msg">{errorMsg}</p>
          <button onClick={() => window.location.reload()}>Riprova</button>
        </div>
      </div>
    )
  }

  // Stato "vuoto": nessun messaggio → mostra la hero (è l'utente a iniziare).
  const isEmpty = messages.length === 0

  // -------------------------------------------------------------------------
  // Render app principale
  // -------------------------------------------------------------------------
  return (
    <div className="app-root">
      {/* Header */}
      <header className="app-header">
        <div className="header-inner">
          <div className="header-brand">
            <NicuFace mood="idle" size={46} className="header-mark" />
            <div className="header-text">
              <h1 className="header-title">Nicu</h1>
              <p className="header-tagline">l'amico catanese che ti strappa un sorriso</p>
            </div>
          </div>
          <div className="header-actions">
            <button
              className="icon-btn"
              onClick={() => setInfoOpen(true)}
              title="Cos'è Nicu?"
              aria-label="Cos'è Nicu?"
            >
              <IconInfo />
            </button>
            {!isEmpty && (
              <button
                className="icon-btn"
                onClick={resetChat}
                title="Nuova chat"
                aria-label="Nuova chat"
              >
                <IconRefresh />
              </button>
            )}
          </div>
        </div>
      </header>

      <InfoModal
        open={infoOpen}
        onClose={() => setInfoOpen(false)}
        params={params}
        onChange={setParams}
        memoryOn={memoryOn}
        onToggleMemory={setMemoryOn}
      />

      {/* Stato vuoto: tutto raggruppato al centro (logo, claim, input, prompt) */}
      {isEmpty ? (
        <main className="chat-area empty-state">
          <div className="welcome-stack">
            <NicuFace mood="happy" size={104} className="hero-mark" />
            <h2 className="hero-title">
              La prima AI che ti vuole <span className="hero-accent">felice</span>, non produttivo.
            </h2>
            <p className="hero-sub">
              Due chiacchiere, una risata, buona compagnia.
            </p>
            {IS_HF_SPACE && (
              <p className="hero-lang-note">
                🇮🇹 Nicu only speaks Italian — try «Ciao Nicu! Chi sei?»
              </p>
            )}
            <Composer
              input={input}
              onChange={setInput}
              onKeyDown={handleKeyDown}
              onSubmit={handleSubmit}
              generating={status === 'generating'}
            />
            <div className="hero-prompts">
              {SUGGESTED_PROMPTS.map(p => (
                <button key={p} className="suggested-btn" onClick={() => sendMessage(p)}>
                  {p}
                </button>
              ))}
            </div>
            <PrivacyLine />
          </div>
        </main>
      ) : (
        <>
          <main className="chat-area">
            <div className="messages-list">
              {messages.map((m, i) => (
                <ChatBubble
                  key={m.id}
                  message={m}
                  prevUserText={i > 0 && messages[i - 1].role === 'user' ? messages[i - 1].text : undefined}
                />
              ))}
              <div ref={bottomRef} />
            </div>
          </main>

          <footer className="chat-footer">
            <div className="footer-inner">
              <Composer
                input={input}
                onChange={setInput}
                onKeyDown={handleKeyDown}
                onSubmit={handleSubmit}
                generating={status === 'generating'}
              />
              <PrivacyLine className="footer-privacy-note" />
            </div>
          </footer>
        </>
      )}
    </div>
  )
}
