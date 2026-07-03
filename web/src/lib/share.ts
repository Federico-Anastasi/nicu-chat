// ---------------------------------------------------------------------------
// share.ts — genera una "card" immagine brandizzata di uno scambio con Nicu
// e la condivide (Web Share API con file su mobile → WhatsApp/Instagram/...,
// download PNG come fallback su desktop).
//
// È il motore virale: ogni risposta che fa ridere diventa uno screenshot
// già pronto e brandizzato, senza che l'utente debba ritagliare niente.
//
// Formato 1080x1350 (4:5): header compatto, contenuto centrato verticalmente
// con la risposta di Nicu come "star" (testo grande, auto-scalato), fascia
// brand in basso con una silhouette stilizzata mare+Etna. Nessun numero di
// parametri nel copy, nessun dominio hardcodato (window.location.host).
// ---------------------------------------------------------------------------

// Palette (allineata a index.css)
const SEA_DEEP = '#0a1628'
const SEA_TOP = '#0d1f3a'
const SEA_MID = '#13284a'
const USER_BUBBLE = '#c4520a'
const USER_DARK = '#a04008'
const SEA_LIGHT = '#1a3a5c'
const BAND_DARK = '#071120'
const WHITE = '#f5f5f5'
const MUTED = '#7a9bb5'
const SUN_ORANGE = '#e86a2b'
const SUN_WARM = '#f09040'
const LOGO_BLUE = '#0f2040'

const W = 1080
const H = 1350
const PAD = 80

// header
const HEADER_AVATAR_R = 36
const HEADER_LINE_Y = 132
const CONTENT_TOP = 170

// fascia brand in basso
const BAND_H = 110
const BAND_TOP = H - BAND_H
const CONTENT_BOTTOM = BAND_TOP - 30

// bolle chat (stesso linguaggio dell'app: utente arancio a destra, Nicu a sinistra)
const NICU_AVATAR_R = 36
const BUBBLE_GAP = 36 // tra bolla utente e bolla Nicu
const ANSWER_MAX_CHARS = 420

// Bolla chat con la "codina": l'angolo in basso
// verso il proprio lato (br per l'utente, bl per Nicu) ha raggio piccolo.
function roundRectTail(
  ctx: CanvasRenderingContext2D,
  x: number, y: number, w: number, h: number, r: number, tail: 'br' | 'bl',
) {
  const br = tail === 'br' ? 8 : r
  const bl = tail === 'bl' ? 8 : r
  ctx.beginPath()
  ctx.moveTo(x + r, y)
  ctx.arcTo(x + w, y, x + w, y + h, r)
  ctx.arcTo(x + w, y + h, x, y + h, br)
  ctx.arcTo(x, y + h, x, y, bl)
  ctx.arcTo(x, y, x + w, y, r)
  ctx.closePath()
}

// Disegna il logo: cerchio blu + N arancio gradient (lo stesso del favicon).
function drawLogo(ctx: CanvasRenderingContext2D, cx: number, cy: number, r: number) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.fillStyle = LOGO_BLUE
  ctx.fill()
  const g = ctx.createLinearGradient(cx - r, cy - r, cx + r, cy + r)
  g.addColorStop(0, SUN_ORANGE)
  g.addColorStop(1, SUN_WARM)
  ctx.fillStyle = g
  ctx.font = `900 ${Math.round(r * 1.25)}px system-ui, sans-serif`
  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillText('N', cx, cy + r * 0.08)
  ctx.restore()
}

// Carica un'immagine (avatar-personaggio) una volta, con cache.
const imgCache = new Map<string, Promise<HTMLImageElement>>()
function loadImage(src: string): Promise<HTMLImageElement> {
  let p = imgCache.get(src)
  if (!p) {
    p = new Promise((resolve, reject) => {
      const img = new Image()
      img.onload = () => resolve(img)
      img.onerror = reject
      img.src = src
    })
    imgCache.set(src, p)
  }
  return p
}

// Disegna un avatar-immagine ritagliato a cerchio.
function drawAvatarImg(
  ctx: CanvasRenderingContext2D, img: HTMLImageElement, cx: number, cy: number, r: number,
) {
  ctx.save()
  ctx.beginPath()
  ctx.arc(cx, cy, r, 0, Math.PI * 2)
  ctx.clip()
  ctx.drawImage(img, cx - r, cy - r, r * 2, r * 2)
  ctx.restore()
}

// Spezza il testo in righe che stanno in maxWidth (usa ctx.font corrente).
function wrapLines(
  ctx: CanvasRenderingContext2D, text: string, maxWidth: number,
): string[] {
  const out: string[] = []
  for (const para of text.split('\n')) {
    const words = para.split(' ')
    let line = ''
    for (const word of words) {
      const test = line ? line + ' ' + word : word
      if (ctx.measureText(test).width > maxWidth && line) {
        out.push(line)
        line = word
      } else {
        line = test
      }
    }
    out.push(line)
  }
  return out
}

// Dominio corrente per branding (mai hardcodato): host della pagina, con
// fallback 'nicu.chat' se vuoto o locale (dev/preview).
function currentDomain(): string {
  const host = typeof window !== 'undefined' ? window.location.host : ''
  if (!host || /^localhost|^127\.0\.0\.1/.test(host)) return 'nicu.chat'
  return host
}

// Fascia brand in basso: piatta e pulita — solo dominio e tagline.
function drawBrandBand(ctx: CanvasRenderingContext2D, domain: string) {
  ctx.fillStyle = BAND_DARK
  ctx.fillRect(0, BAND_TOP, W, BAND_H)
  ctx.strokeStyle = SEA_LIGHT
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(0, BAND_TOP)
  ctx.lineTo(W, BAND_TOP)
  ctx.stroke()

  ctx.textAlign = 'center'
  ctx.textBaseline = 'middle'
  ctx.fillStyle = SUN_WARM
  ctx.font = '800 38px system-ui, sans-serif'
  ctx.fillText(domain, W / 2, BAND_TOP + BAND_H / 2)
}

export async function renderCard(userText: string, nicuText: string): Promise<HTMLCanvasElement> {
  // avatar-personaggio: idle nell'header, happy accanto alla risposta.
  // Se non caricano, si ripiega sul logo N.
  let nicuFace: HTMLImageElement | undefined
  let headFace: HTMLImageElement | undefined
  try {
    ;[nicuFace, headFace] = await Promise.all([
      loadImage('/nicu-happy.png'),
      loadImage('/nicu-idle.png'),
    ])
  } catch { /* fallback logo */ }

  const canvas = document.createElement('canvas')
  canvas.width = W
  canvas.height = H
  const ctx = canvas.getContext('2d')!

  // tronca la risposta per non far esplodere la card
  const answerText = nicuText.length > ANSWER_MAX_CHARS
    ? nicuText.slice(0, ANSWER_MAX_CHARS).trimEnd() + '…'
    : nicuText

  // --- fase 1: misura (nessun disegno) --------------------------------
  // Bolla utente: arancio, a destra, come nell'app.
  const userFont = '600 40px system-ui, sans-serif'
  const userLineH = 54
  const userInnerPad = 32
  const userMaxW = Math.round(W * 0.66)
  ctx.font = userFont
  const userLines = wrapLines(ctx, userText, userMaxW - userInnerPad * 2)
  const userTextW = Math.max(...userLines.map(l => ctx.measureText(l).width))
  const userBubbleW = Math.min(userMaxW, userTextW + userInnerPad * 2)
  const userBubbleH = userLines.length * userLineH + userInnerPad * 2 - (userLineH - 48)
  const userBubbleX = W - PAD - userBubbleW

  // Bolla Nicu: a sinistra con l'avatar, testo grande auto-scalato.
  const bubbleX = PAD + NICU_AVATAR_R * 2 + 20
  const bubbleMaxW = W - PAD - bubbleX
  const bubbleInnerPad = 40
  const availableForAnswer = (CONTENT_BOTTOM - CONTENT_TOP) - userBubbleH - BUBBLE_GAP

  const candidateSizes = [52, 48, 44, 40, 36, 32, 28]
  let answerSize = candidateSizes[candidateSizes.length - 1]
  let answerLineH = Math.round(answerSize * 1.3)
  let answerLines: string[] = []
  let bubbleH = 0
  let bubbleW = 0
  for (const size of candidateSizes) {
    ctx.font = `600 ${size}px system-ui, sans-serif`
    const lines = wrapLines(ctx, answerText, bubbleMaxW - bubbleInnerPad * 2)
    const lineH = Math.round(size * 1.3)
    const textW = Math.max(...lines.map(l => ctx.measureText(l).width))
    const h = Math.max(lines.length * lineH + bubbleInnerPad * 2 - (lineH - Math.round(size * 1.15)), NICU_AVATAR_R * 2 + 24)
    answerSize = size
    answerLineH = lineH
    answerLines = lines
    bubbleH = h
    bubbleW = Math.min(bubbleMaxW, textW + bubbleInnerPad * 2)
    if (h <= availableForAnswer) break
  }

  const totalBlockH = userBubbleH + BUBBLE_GAP + bubbleH
  const startY = CONTENT_TOP + Math.max(0, ((CONTENT_BOTTOM - CONTENT_TOP) - totalBlockH) / 2)
  const userBubbleY = startY
  const bubbleY = startY + userBubbleH + BUBBLE_GAP

  // --- fase 2: disegno --------------------------------------------------

  // sfondo: gradiente verticale scuro, pulito — nessun elemento figurativo
  const bg = ctx.createLinearGradient(0, 0, 0, H)
  bg.addColorStop(0, SEA_DEEP)
  bg.addColorStop(1, SEA_TOP)
  ctx.fillStyle = bg
  ctx.fillRect(0, 0, W, H)

  // header compatto
  const headerAvatarCx = PAD + HEADER_AVATAR_R
  const headerAvatarCy = 64
  if (headFace) drawAvatarImg(ctx, headFace, headerAvatarCx, headerAvatarCy, HEADER_AVATAR_R)
  else drawLogo(ctx, headerAvatarCx, headerAvatarCy, HEADER_AVATAR_R)

  const headerTextX = headerAvatarCx + HEADER_AVATAR_R + 20
  ctx.fillStyle = WHITE
  ctx.textAlign = 'left'
  ctx.textBaseline = 'middle'
  ctx.font = '800 40px system-ui, sans-serif'
  ctx.fillText('Nicu', headerTextX, 54)
  ctx.fillStyle = MUTED
  ctx.font = 'italic 22px system-ui, sans-serif'
  ctx.fillText("l'amico catanese che ti strappa un sorriso", headerTextX, 88)

  ctx.strokeStyle = SEA_LIGHT
  ctx.lineWidth = 2
  ctx.beginPath()
  ctx.moveTo(PAD, HEADER_LINE_Y)
  ctx.lineTo(W - PAD, HEADER_LINE_Y)
  ctx.stroke()

  // bolla utente: arancio, in alto a destra, con la codina (come nell'app)
  const ug = ctx.createLinearGradient(userBubbleX, userBubbleY, userBubbleX + userBubbleW, userBubbleY + userBubbleH)
  ug.addColorStop(0, USER_BUBBLE)
  ug.addColorStop(1, USER_DARK)
  roundRectTail(ctx, userBubbleX, userBubbleY, userBubbleW, userBubbleH, 28, 'br')
  ctx.fillStyle = ug
  ctx.fill()
  ctx.font = userFont
  ctx.fillStyle = '#ffffff'
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let uy = userBubbleY + userInnerPad
  for (const l of userLines) {
    ctx.fillText(l, userBubbleX + userInnerPad, uy)
    uy += userLineH
  }

  // bolla Nicu: a sinistra, avatar in basso accanto alla bolla (come nell'app)
  const avatarCx = PAD + NICU_AVATAR_R
  const avatarCy = bubbleY + bubbleH - NICU_AVATAR_R
  if (nicuFace) drawAvatarImg(ctx, nicuFace, avatarCx, avatarCy, NICU_AVATAR_R)
  else drawLogo(ctx, avatarCx, avatarCy, NICU_AVATAR_R)

  roundRectTail(ctx, bubbleX, bubbleY, bubbleW, bubbleH, 28, 'bl')
  ctx.fillStyle = SEA_MID
  ctx.fill()
  ctx.strokeStyle = SEA_LIGHT
  ctx.lineWidth = 2
  ctx.stroke()

  ctx.font = `600 ${answerSize}px system-ui, sans-serif`
  ctx.fillStyle = WHITE
  ctx.textAlign = 'left'
  ctx.textBaseline = 'top'
  let ty = bubbleY + bubbleInnerPad
  for (const l of answerLines) {
    ctx.fillText(l, bubbleX + bubbleInnerPad, ty)
    ty += answerLineH
  }

  // fascia brand in basso: silhouette mare+Etna + dominio (mai hardcodato)
  drawBrandBand(ctx, currentDomain())

  return canvas
}

function canvasToBlob(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob(b => (b ? resolve(b) : reject(new Error('toBlob failed'))), 'image/png')
  })
}

export type ShareOutcome = 'shared' | 'downloaded' | 'error'

export async function shareExchange(userText: string, nicuText: string): Promise<ShareOutcome> {
  try {
    const canvas = await renderCard(userText, nicuText)
    const blob = await canvasToBlob(canvas)
    const file = new File([blob], 'nicu.png', { type: 'image/png' })

    const nav = navigator as Navigator & {
      canShare?: (data?: ShareData) => boolean
    }
    if (nav.share && nav.canShare && nav.canShare({ files: [file] })) {
      await nav.share({
        files: [file],
        title: 'Nicu',
        text: `Guarda cosa mi ha detto Nicu — ${currentDomain()}`,
      })
      return 'shared'
    }

    // fallback desktop: download del PNG
    const url = URL.createObjectURL(blob)
    const a = document.createElement('a')
    a.href = url
    a.download = 'nicu.png'
    document.body.appendChild(a)
    a.click()
    a.remove()
    setTimeout(() => URL.revokeObjectURL(url), 1000)
    return 'downloaded'
  } catch (e) {
    // l'utente che annulla lo share lancia AbortError: non è un errore vero
    if (e instanceof DOMException && e.name === 'AbortError') return 'shared'
    console.error('share error:', e)
    return 'error'
  }
}
