/**
 * tokenizer.ts — ByteLevel BPE tokenizer (puro TS, zero dipendenze).
 *
 * Implementa la stessa logica della libreria HuggingFace `tokenizers` Rust:
 * - Pre-tokenizer ByteLevel con regex GPT-2
 * - Mapping byte → Unicode (identico a GPT-2 / gpt2.py di OpenAI)
 * - BPE con tabella di rank dei merge
 * - Decode: Unicode ByteLevel → byte → stringa UTF-8
 *
 * Test di riferimento (DEVE passare):
 *   encode("Utente: ciao\nNicu:") === [292, 26, 900, 199, 290, 26]
 */

// ---------------------------------------------------------------------------
// 1. Mapping byte ↔ Unicode (stesso di GPT-2)
// ---------------------------------------------------------------------------

/**
 * Costruisce la mappa byte → codice Unicode.
 * I byte "stampabili" (ASCII 33-126, Latin supplement 161-172, 174-255)
 * mappano su sé stessi. I restanti 68 byte mappano su U+0100…U+0143.
 */
function buildByteToUnicode(): Uint16Array {
  const result = new Uint16Array(256)

  // Byte che mappano su sé stessi (già "stampabili" come Unicode)
  const printable = new Set<number>()
  for (let i = 33; i <= 126; i++) printable.add(i)   // ASCII stampabile
  for (let i = 161; i <= 172; i++) printable.add(i)  // Latin supplement
  for (let i = 174; i <= 255; i++) printable.add(i)  // Latin supplement cont.

  for (const b of printable) result[b] = b

  // Byte non-stampabili: mappano su U+0100 + n (n = ordine di comparsa in range(256))
  let n = 0
  for (let b = 0; b < 256; b++) {
    if (!printable.has(b)) {
      result[b] = 0x0100 + n  // a partire da U+0100
      n++
    }
  }

  return result
}

const BYTE_TO_UNI = buildByteToUnicode()

/** Mappa inversa: codice Unicode → byte (costruita una volta) */
const UNI_TO_BYTE: Map<number, number> = (() => {
  const m = new Map<number, number>()
  for (let b = 0; b < 256; b++) m.set(BYTE_TO_UNI[b], b)
  return m
})()

/** Converte una stringa UTF-8 in una stringa ByteLevel (un char per byte) */
function toByteLevelString(text: string): string {
  const bytes = new TextEncoder().encode(text)
  let out = ''
  for (const b of bytes) out += String.fromCharCode(BYTE_TO_UNI[b])
  return out
}

/** Converte una stringa ByteLevel in bytes UTF-8 e poi in stringa */
function fromByteLevelString(byteStr: string): string {
  const bytes = new Uint8Array(byteStr.length)
  for (let i = 0; i < byteStr.length; i++) {
    bytes[i] = UNI_TO_BYTE.get(byteStr.charCodeAt(i)) ?? 0x3F // '?' fallback
  }
  return new TextDecoder('utf-8', { fatal: false }).decode(bytes)
}

// ---------------------------------------------------------------------------
// 2. Pre-tokenizer ByteLevel (regex GPT-2)
// ---------------------------------------------------------------------------

/**
 * Pre-tokenizzazione con la regex di GPT-2.
 * Divide il testo nei "token naturali" della lingua prima di applicare BPE.
 *
 * Unicode property escapes (\p{L}, \p{N}) richiedono il flag 'u' in JS.
 */
const PRE_TOK_RE =
  /('s|'t|'re|'ve|'m|'ll|'d| ?\p{L}+| ?\p{N}+| ?[^\s\p{L}\p{N}]+|\s+(?!\S)|\s+)/gu

function preTok(text: string): string[] {
  return text.match(PRE_TOK_RE) ?? []
}

// ---------------------------------------------------------------------------
// 3. BPE engine
// ---------------------------------------------------------------------------

interface TokenizerJSON {
  added_tokens: Array<{ id: number; content: string; special: boolean }>
  model: {
    type: string
    vocab: Record<string, number>
    /** Merges: array di coppie [token_a, token_b] */
    merges: [string, string][]
  }
}

export class BPETokenizer {
  private readonly vocab: Map<string, number>
  private readonly vocabRev: Map<number, string>
  /** merge_key → rank (usato per trovare il merge con rank più basso) */
  private readonly mergeRank: Map<string, number>
  private readonly eotId: number

  constructor(json: TokenizerJSON) {
    // Vocabolario bidirezionale
    this.vocab = new Map(Object.entries(json.model.vocab))
    this.vocabRev = new Map(
      Object.entries(json.model.vocab).map(([k, v]) => [v, k])
    )

    // Tabella rank dei merge: "a\x00b" → indice (più basso = prima applicato)
    this.mergeRank = new Map(
      json.model.merges.map(([a, b], i) => [`${a}\x00${b}`, i])
    )

    // Token speciale EOT (<|endoftext|>) = id 0
    const eot = json.added_tokens.find(t => t.content === '<|endoftext|>')
    this.eotId = eot?.id ?? 0
  }

  // -------------------------------------------------------------------------
  // BPE su una singola "parola" (stringa ByteLevel già convertita)
  // -------------------------------------------------------------------------
  private applyBPE(chars: string[]): string[] {
    let word = chars
    if (word.length <= 1) return word

    while (true) {
      // Trova il merge con rank minimo nella parola corrente
      let bestRank = Infinity
      let bestIdx = -1

      for (let i = 0; i < word.length - 1; i++) {
        const key = `${word[i]}\x00${word[i + 1]}`
        const rank = this.mergeRank.get(key)
        if (rank !== undefined && rank < bestRank) {
          bestRank = rank
          bestIdx = i
        }
      }

      if (bestIdx === -1) break // nessun merge applicabile

      // Applica il merge: sostituisce la coppia con il token fuso
      const next: string[] = []
      for (let i = 0; i < word.length; i++) {
        if (i === bestIdx) {
          next.push(word[i] + word[i + 1])
          i++ // salta il secondo elemento della coppia
        } else {
          next.push(word[i])
        }
      }
      word = next
    }

    return word
  }

  // -------------------------------------------------------------------------
  // Encode: stringa → array di id
  // -------------------------------------------------------------------------
  encode(text: string): number[] {
    const ids: number[] = []

    for (const segment of preTok(text)) {
      // Converti ogni segmento in ByteLevel e poi in array di char
      const blStr = toByteLevelString(segment)
      // Ogni char è un simbolo BPE iniziale; Array.from gestisce code points
      const chars = Array.from(blStr)

      // Applica BPE
      const tokens = this.applyBPE(chars)

      // Lookup nel vocabolario
      for (const tok of tokens) {
        const id = this.vocab.get(tok)
        if (id !== undefined) ids.push(id)
        // Se non trovato: non dovrebbe succedere con un vocabolario completo BPE
      }
    }

    return ids
  }

  // -------------------------------------------------------------------------
  // Decode: array di id → stringa
  // -------------------------------------------------------------------------
  decode(ids: number[]): string {
    // Concatena i token string
    let blStr = ''
    for (const id of ids) {
      blStr += this.vocabRev.get(id) ?? ''
    }
    // Riconverti da ByteLevel a UTF-8
    return fromByteLevelString(blStr)
  }

  get eotTokenId(): number {
    return this.eotId
  }

  get vocabSize(): number {
    return this.vocab.size
  }
}

// ---------------------------------------------------------------------------
// Factory: carica il JSON del tokenizer da URL (browser) o path
// ---------------------------------------------------------------------------

export async function loadTokenizer(url: string): Promise<BPETokenizer> {
  const resp = await fetch(url)
  if (!resp.ok) throw new Error(`Tokenizer fetch failed: ${resp.status} ${url}`)
  const json = (await resp.json()) as TokenizerJSON
  return new BPETokenizer(json)
}
