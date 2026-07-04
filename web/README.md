# Nicu Web — toy-AI catanese che gira sul telefono

Interfaccia chat per **Nicu**, una toy-AI da **~20M di parametri** che gira
**interamente sul dispositivo** (browser/telefono): l'**inferenza** è tutta
client-side, nessun server di modello. (Gli scambi sono comunque loggati sul
backend — vedi §"Logging conversazioni".)

> **LIVE:** https://nicu.chat (deploy: `../deploy/README.md`; il vecchio
> nicu.mango-dev.space fa 301, con /api/* ancora attivo per lo Space HF).
> Posizionamento e tono di voce: vedi memoria `nicu-brand-voice`.

## Modello attivo

```
nicu-l-sft-v10.tokenizer.json →  tokenizer ByteLevel BPE (vocab 6000, pin per-ckpt)
nicu-l-sft-v10.onnx           →  nanoGPT fp32, 20,6M param (15 strati), block_size 512  (~84 MB)
onnxruntime-web@1.18 →  motore ONNX, build WASM-only (NO WebGPU) — vedi §"onnxruntime-web: versione bloccata"
```

> Lo `MODEL_ID` (in `src/lib/inference.ts`, ora `nicu-L-sft-v10`) è la fonte unica del nome modello:
> va loggato a ogni turno e va tenuto allineato al file `.onnx` servito.
> Export ONNX da un checkpoint: `python ../export_onnx.py --ckpt out/nicu-L-sft-v10.pt`
> (legge vocab/block_size dalla cfg del checkpoint — **se cambiano, aggiorna
> `BLOCK_SIZE`/`VOCAB_SIZE` in `inference.ts`**).

## Come funziona (per messaggio)

1. **Memoria conversazione (toggle, default ON):** col toggle attivo Nicu riceve
   la storia recente `"Utente: …\nNicu: …\nUtente: <msg>\nNicu:"`; col toggle OFF
   solo il messaggio corrente. → tokenizer ByteLevel BPE → array di id. (La memoria
   ON è stata riabilitata sulla famiglia L, che regge il multiturno; sui nano più
   piccoli amplificava la ripetizione delle "mosse" — vedi `nicu-stateless-decision`.)
2. Ogni step autoregressivo: tutti gli id al modello (troncati a `block_size`
   512), si prende `logits[0, last, :]` (shape `[6000]`).
3. Sampling: repetition_penalty **1.15** → temperatura **1.0** → softmax →
   top_p nucleus **0.92** → campionamento multinomiale. (Default in
   `DEFAULT_PARAMS`, tarati con uno sweep: 1.0/1.15 = miglior compromesso
   colore/coerenza; sotto 0.5 spento, sopra 1.3 sgrammatica, penalità >1.5 storce.)
4. **Stop** su `<|endoftext|>` (id 0), su `max token`, oppure su **stop-sequence**
   `\nUtente:` / `\nNicu:` (evita che il modello si auto-inventi un finto dialogo
   dentro la risposta).
5. Decodifica in streaming (la bolla si aggiorna token per token).

Il modello conosce solo il suo piccolo mondo (Catania, mare, griglia, amici).
Su tutto il resto **devia senza inventare** — è il suo carattere, non un bug.

## Logging conversazioni

Ogni scambio è inviato (fire-and-forget) a `POST /api/log` col campo `model`
(= `MODEL_ID`), così nel DB del backend le conversazioni sono distinguibili per
versione di modello. Su host `*.hf.space` (lo Space demo) il logger punta in
assoluto a `https://nicu.chat` (CORS lato backend); il server salva anche
l'`origin` per distinguere sito vs Space. In dev/preview senza backend
fallisce in silenzio.

## Avvio rapido

```bash
cd projects/nicu/web
npm install                      # copia i binari .wasm di ORT in public/wasm/ (postinstall)
npm run dev                      # http://localhost:5173 — inferenza INCLUSA
npm run build && npm run preview # build + anteprima di produzione (http://localhost:4173)
# preview sulla LAN (test su telefono vero): npm run preview -- --host --port 4174
```

> ℹ️ **`npm run dev` ora testa anche l'inferenza.** ORT 1.18 carica i `.wasm`
> direttamente (niente glue `.mjs` con `import()` dinamico, che su 1.19+ il dev
> server Vite rifiutava da `/public`). Era questo il motivo per cui prima serviva
> `build`+`preview`; con la 1.18 non è più necessario.

## Consenso e privacy

Niente card né modal: sotto il composer c'è una **micro-riga sempre visibile**
(`PrivacyLine` in App.tsx) — "Scrivendo a Nicu accetti che le chat siano salvate
per migliorarlo — niente dati personali · Privacy". L'uso della chat vale come
accettazione (informativa persistente, meglio di un avviso una-tantum). Il testo
legale completo sta nella pagina statica `public/privacy.html` (nessun router,
stile piatto da documento), linkata dalla riga e dal pannello "Cos'è Nicu?".

## onnxruntime-web: versione bloccata a 1.18 (⚠️ NON aggiornare alla leggera)

**`onnxruntime-web` è pinnato a `1.18.0` di proposito. Non bumparlo senza rileggere questo.**

Contesto (bug risolto il 2026-07-01): alcuni iPhone/iPad davano
`no available backend found / previous call to 'initWasm()' failed` — su
**iOS < 16.4** (niente WASM SIMD) e su iOS moderni sotto pressione di memoria.
Due cause:
1. **ORT ≥ 1.19 spedisce SOLO binari SIMD** (niente fallback non-SIMD) → su iOS
   < 16.4 (iPad 15.5, iPhone non aggiornati) **nessun backend** → errore. La
   **1.18.x è l'ultima con `ort-wasm.wasm` non-SIMD**; 1.19 lo ha rimosso.
2. Il vecchio codice provava **WebGPU per primo**; su iOS 18 `navigator.gpu`
   esiste, ma la sua init (nella build JSEP da 26,8 MB) falliva sotto pressione
   di memoria e **avvelenava** il runtime WASM condiviso (flag `aborted`
   memoizzato) → il fallback wasm restituiva l'errore memoizzato.

Fix (in `src/lib/inference.ts`):
- **`import * as ort from 'onnxruntime-web/wasm'`** — build WASM-only. ORT sceglie
  il binario a runtime: `ort-wasm-simd.wasm` sui device con SIMD, **`ort-wasm.wasm`
  (non-SIMD) su iOS < 16.4**. Niente WebGPU/JSEP → niente avvelenamento, binario
  più leggero (~10 MB invece di 26,8), bundle JS più piccolo (359 vs 622 KB).
- `ort.env.wasm.wasmPaths = '/wasm/'` (forma string-prefix; ORT vi aggiunge il
  nome del file scelto). `numThreads = 1` (niente SharedArrayBuffer/COOP-COEP).

**Se un domani vuoi aggiornare ORT o riattivare WebGPU:** o resti su una versione
con binario non-SIMD, o aggiungi un capability-check (probe WASM SIMD) + un
fallback esplicito, altrimenti il bug iOS torna. WebGPU va comunque **gated fuori
su iOS** (lì è assente/inaffidabile e la sua init può avvelenare il wasm).
Opset del modello = 17 (`export_onnx.py`), caricabile fino a ORT ≤ opset 21.

## Inferenza fuori dal main thread (Web Worker)

L'inferenza gira in un **Web Worker** (`src/lib/inference.worker.ts`), non più
sul main thread: prima, durante la generazione, il browser non dipingeva/
animava niente ("pagina bloccata", molto evidente su iPad/iPhone lenti).

- `src/lib/inference.ts` — punto d'ingresso pubblico (stesse firme di sempre:
  `loadModel`, `generate`, `DEFAULT_PARAMS`, `MODEL_ID`…), fa da **proxy**
  verso il worker via `postMessage`. App.tsx non sa se dietro c'è il worker o
  il main thread.
- `src/lib/inference.worker.ts` — vive qui l'import ORT (stessa config
  wasm-only 1.18, vedi sotto), la sessione, il tokenizer, il loop di
  generazione. Cede il controllo (`setTimeout(…, 0)`) a ogni token, così un
  `abort` in coda viene processato tra un token e l'altro.
- `src/lib/inference.mainthread.ts` — il vecchio percorso main-thread,
  invariato: **fallback** usato se il Worker non si crea o non risponde entro
  20 s (vedi `WORKER_INIT_TIMEOUT_MS` in `inference.ts`). Stesso identico
  risultato funzionale, solo senza thread separato.
- Protocollo: main→worker `{type:'load'|'generate'|'abort', …}`, worker→main
  `{type:'progress'|'ready'|'token'|'done'|'error', …}` (vedi i tipi in
  `inference.worker.ts`).
- Istanziato con `new Worker(new URL('./inference.worker.ts', import.meta.url),
  {type:'module'})` — Vite lo bundla come chunk separato; Safari 15+ supporta i
  module worker (iPad target 15.5, ok).

## UI (src/App.tsx)

- **Full-width** come le grandi chat (header/footer edge-to-edge, contenuto
  centrato in colonna ~820px).
- **Stato vuoto raggruppato** al centro: logo, headline, **input a pillola**
  (bottone tondo dentro), prompt-trabocchetto.
- **Header** una riga: brand a sinistra, a destra due bottoni-icona — ⓘ apre il
  **modal "Cos'è Nicu?"** (overlay: copy per l'utente medio senza numeri,
  "Per i curiosi" con link GitHub/HF/X da `CURIOUS_LINKS`, "Impostazioni
  avanzate" collassate con parametri+memoria, link privacy) e ↻ Nuova chat
  (solo quando esiste una conversazione). Su `*.hf.space` la hero mostra una
  riga in inglese "Nicu only speaks Italian".
- **Share-card** (`src/lib/share.ts`): ogni risposta ha "Condividi" → PNG 4:5
  in stile chat (bolla utente arancio con codina + bolla Nicu con avatar,
  contenuto centrato, fascia brand col solo dominio da `location.host`) e usa
  Web Share (WhatsApp/IG su mobile) o download su desktop.
- **Avatar-personaggio** (`NicuFace`, non più la "N"): il volto di Nicu con 3
  espressioni, usato ovunque — `idle` (header + bolle chat), `happy` (hero +
  share-card), `boh` = spallucciata "non lo so" (loading). Asset in `public/`:
  `nicu-idle.png` / `nicu-happy.png` (cerchio) e `nicu-boh.png` (quadrata, le mani
  escono dal cerchio). Favicon/PWA icons e `og.png` rigenerati dal volto `idle`/`happy`.

## Dimensioni download (prima apertura)

| File                 | Dimensione |
|----------------------|-----------|
| `nicu-l-sft-v10.onnx` | ~84 MB   |
| `nicu-l-sft-v10.tokenizer.json` | ~0,4 MB |
| WASM ORT (1 binario) | ~10 MB    |
| JS + CSS app         | ~0,5 MB   |

Modello + tokenizer cache-ati (`Cache-Control` immutable lato nginx + Cache
Storage nel worker, con cleanup automatico delle versioni vecchie a ogni load
riuscito) → dalla seconda visita non si riscaricano. Con la build WASM-only
ORT scarica **un solo** binario (~10 MB, non i 27 MB della JSEP). **gzip ON**
(2026-07-02) su wasm/js/css/json lato nginx. **Perf da migliorare:** l'int8
~10 MB del modello (`export_onnx.py --int8`) taglierebbe altri ~28 MB.

## Struttura

```
web/
├── public/
│   ├── nicu-l-sft-v10.onnx  modello ONNX (fp32, 20,6M param, vocab 6k, block 512)
│   ├── nicu-l-sft-v10.tokenizer.json  tokenizer ByteLevel BPE (vocab 6000, pin per-ckpt)
│   ├── nicu-idle/happy/boh.png  avatar-personaggio (le 3 espressioni)
│   ├── favicon.png, apple-touch-icon.png, icon-192/512.png  icone dal volto idle
│   ├── og.png               anteprima social (volto happy + claim, 1200×630)
│   ├── manifest.webmanifest icone PWA, wasm/ …
│   └── wasm/                binari .wasm di ORT 1.18 (copiati da setup-wasm)
├── src/
│   ├── lib/
│   │   ├── tokenizer.ts          ByteLevel BPE puro TypeScript
│   │   ├── inference.ts          proxy pubblico verso il worker (MODEL_ID, DEFAULT_PARAMS…)
│   │   ├── inference.worker.ts   ONNX + sampling + generazione, dentro un Web Worker
│   │   ├── inference.mainthread.ts  fallback main-thread (se il worker non parte)
│   │   ├── logger.ts             POST /api/log (con model)
│   │   └── share.ts              share-card su canvas
│   └── App.tsx              UI React (full-width, pillola, share)
└── vite.config.ts
```

> `scripts/verify.mjs` valida gli invarianti del tokenizer/modello ATTUALMENTE
> serviti (`nicu-l-sft-v10.tokenizer.json` vocab 6000, `nicu-l-sft-v10.onnx` block 512): i valori
> attesi sono una baseline di regressione JS (tokenizer + onnxruntime-node),
> non una parità con l'export Python — rigenerali se cambi modello/tokenizer.

## Header server (nginx/Caddy)

**Niente COOP/COEP** (rimossi: single-thread, niente SharedArrayBuffer → gira
anche su iOS Safari). Solo `Cross-Origin-Resource-Policy: same-origin`. `.onnx`
`immutable`; `/wasm/` servito `no-cache` (così un cambio versione ORT non lascia
binari stantii in cache — i file `.wasm` hanno nome fisso). Config in
`../deploy/web/nginx.conf`.
