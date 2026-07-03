# Nicu Web — Sicilian toy-AI that runs on your phone

Chat interface for **Nicu**, a ~20M-parameter toy-AI that runs **entirely on
your device** (browser/phone): inference is fully client-side, no model
server involved.

> **Live:** https://nicu.chat

## Active model

```
bpe_synth.json       →  ByteLevel BPE tokenizer (vocab 6000)
nicu-l-v9-sft.onnx   →  nanoGPT fp32, 20.6M params (15 layers), block_size 512 (~84 MB)
onnxruntime-web@1.18 →  ONNX engine, WASM-only build (no WebGPU) — see "onnxruntime-web: version pinned" below
```

> `MODEL_ID` (in `src/lib/inference.ts`) is the single source of truth for
> the model name. Export ONNX from a checkpoint with
> `python tools/export_onnx.py --ckpt <checkpoint.pt>` (reads vocab/block_size
> from the checkpoint config — if those change, update `BLOCK_SIZE`/`VOCAB_SIZE`
> in `inference.ts` accordingly).

## How it works (per message)

1. **Conversation memory** (toggle, default ON): with the toggle on, Nicu
   receives recent history as `"Utente: …\nNicu: …\nUtente: <msg>\nNicu:"`;
   with it off, just the current message. Text is tokenized with the ByteLevel
   BPE tokenizer into an array of ids.
2. Each autoregressive step feeds all ids to the model (truncated to
   `block_size` 512) and reads `logits[0, last, :]` (shape `[6000]`).
3. Sampling: repetition penalty **1.15** → temperature **1.0** → softmax →
   nucleus top-p **0.92** → multinomial sampling.
4. **Stop** on `<|endoftext|>` (id 0), on `max token`, or on a stop-sequence
   (`\nUtente:` / `\nNicu:`) so the model can't invent a fake continued
   dialogue inside its own reply.
5. Streaming decode — the chat bubble updates token by token.

The model only knows its small world (Catania, the sea, the grill, friends).
On everything else it **deflects instead of making things up** — that's the
character, not a bug.

## Quick start

```bash
cd web
npm install                      # copies ORT's .wasm binaries into public/wasm/ (postinstall)
# download the .onnx model into public/ (see the main README for the Hugging Face link)
npm run dev                      # http://localhost:5173 — inference included
npm run build && npm run preview # production build + preview (http://localhost:4173)
```

## onnxruntime-web: pinned to 1.18 (do not casually upgrade)

**`onnxruntime-web` is pinned to `1.18.0` on purpose.** Don't bump it without
reading this first.

Background: some iPhones/iPads used to fail with
`no available backend found / previous call to 'initWasm()' failed` — on
**iOS < 16.4** (no WASM SIMD) and on modern iOS under memory pressure. Two
causes:
1. **ORT ≥ 1.19 ships SIMD-only binaries** (no non-SIMD fallback) → on iOS
   < 16.4 there is **no usable backend** → error. **1.18.x is the last
   version that ships the non-SIMD `ort-wasm.wasm`**; 1.19 removed it.
2. Older code tried **WebGPU first**; on iOS 18 `navigator.gpu` exists, but
   its init (inside the ~26.8 MB JSEP build) could fail under memory
   pressure and **poison** the shared WASM runtime (a memoized `aborted`
   flag) — the WASM fallback then returned the same memoized error.

Fix (in `src/lib/inference.ts` / `inference.worker.ts` /
`inference.mainthread.ts`):
- **`import * as ort from 'onnxruntime-web/wasm'`** — a WASM-only build. ORT
  picks the binary at runtime: `ort-wasm-simd.wasm` on SIMD-capable devices,
  **`ort-wasm.wasm` (non-SIMD) on iOS < 16.4**. No WebGPU/JSEP → no
  poisoning, a smaller binary (~10 MB instead of ~26.8), smaller JS bundle
  (~359 KB vs ~622 KB).
- `ort.env.wasm.wasmPaths = '/wasm/'` (string-prefix form; ORT appends the
  chosen filename). `numThreads = 1` (no SharedArrayBuffer / COOP-COEP
  required, so it works without cross-origin isolation headers).

**If you ever want to upgrade ORT or re-enable WebGPU:** either stay on a
version that ships a non-SIMD binary, or add an explicit WASM-SIMD capability
probe with a fallback path — otherwise the iOS bug returns. WebGPU should
still be gated off on iOS regardless (unreliable there, and its init can
poison the WASM runtime). Model opset = 17 (`tools/export_onnx.py`), loadable
by ORT up to opset 21.

## Inference off the main thread (Web Worker)

Inference runs in a **Web Worker** (`src/lib/inference.worker.ts`), not on
the main thread: previously, during generation, the browser wouldn't paint or
animate anything (a very visible "frozen page" on slower iPads/iPhones).

- `src/lib/inference.ts` — public entry point (`loadModel`, `generate`,
  `DEFAULT_PARAMS`, `MODEL_ID`, …), proxies to the worker via `postMessage`.
  `App.tsx` doesn't know whether the worker or the main thread is behind it.
- `src/lib/inference.worker.ts` — where the ORT import, the session, the
  tokenizer, and the generation loop live (same WASM-only 1.18 config as
  above). Yields control (`setTimeout(…, 0)`) after every token so a queued
  `abort` gets processed between tokens.
- `src/lib/inference.mainthread.ts` — the original main-thread path, kept as
  a **fallback** used only if the Worker fails to start or doesn't respond
  within `WORKER_INIT_TIMEOUT_MS` (20 s). Functionally identical, just without
  the separate thread.
- Protocol: main→worker `{type:'load'|'generate'|'abort', …}`, worker→main
  `{type:'progress'|'ready'|'token'|'done'|'error', …}` (see the types in
  `inference.worker.ts`).

## UI (src/App.tsx)

- Full-width layout (edge-to-edge header/footer, ~820px centered column).
- Grouped empty state: logo, headline, pill-shaped input, suggested prompts.
- Header: brand on the left, two icon buttons on the right — info (opens the
  "What is Nicu?" modal, which also holds the collapsed advanced settings and
  the privacy link) and new chat (only shown once a conversation exists).
- Share card (`src/lib/share.ts`): every reply has a "Share" button that
  renders a chat-style branded PNG (user bubble + Nicu bubble) and uses the
  Web Share API (or downloads on desktop).
- `NicuFace`: the character's face with 3 expressions (`idle`, `happy`,
  `boh` = the "I don't know" shrug), used across the header, chat bubbles,
  hero, share card, and loading screen. Assets in `public/`.

## Download sizes (first load)

| File                 | Size    |
|----------------------|---------|
| model `.onnx`        | ~84 MB  |
| `bpe_synth.json`     | ~0.4 MB |
| ORT WASM binary       | ~10 MB  |
| app JS + CSS         | ~0.5 MB |

The model and tokenizer are cached (Cache Storage in the worker, with
automatic cleanup of stale versions on every successful load) — after the
first visit nothing re-downloads. The WASM-only build means ORT only
downloads a single binary (~10 MB, vs ~27 MB for the JSEP/WebGPU build).

## Structure

```
web/
├── public/
│   ├── nicu-l-v9-sft.onnx        model (not committed — download from Hugging Face)
│   ├── bpe_synth.json            ByteLevel BPE tokenizer (vocab 6000)
│   ├── nicu-idle/happy/boh.png   character avatar (3 expressions)
│   ├── favicon.png, apple-touch-icon.png, icon-192/512.png
│   ├── og.png                    social preview image
│   ├── manifest.webmanifest
│   └── wasm/                     ORT 1.18 .wasm binaries (generated by npm install)
├── src/
│   ├── lib/
│   │   ├── tokenizer.ts             ByteLevel BPE, pure TypeScript
│   │   ├── inference.ts             public proxy to the worker (MODEL_ID, DEFAULT_PARAMS…)
│   │   ├── inference.worker.ts      ONNX + sampling + generation, inside a Web Worker
│   │   ├── inference.mainthread.ts  main-thread fallback (if the worker fails to start)
│   │   ├── logger.ts                POST /api/log (optional — see below)
│   │   └── share.ts                 canvas-based share card
│   └── App.tsx                  React UI
└── vite.config.ts
```

## Logging

`src/lib/logger.ts` fire-and-forget-POSTs each exchange to `/api/log`. This
is how the live site (nicu.chat) collects conversations to improve
the model — it's disclosed to users via the privacy line in the UI. There is
no backend included in this repo; without one, logging just fails silently
(harmless), including in local dev.

> `scripts/verify.mjs` checks the tokenizer/model invariants of whatever is
> currently in `public/` (`bpe_synth.json` vocab 6000, model block 512): the
> expected values are a JS-side regression baseline (tokenizer +
> onnxruntime-node), not a parity check against the Python export — it needs
> the `.onnx` file present in `public/` to run, and should be regenerated if
> you swap in a different model/tokenizer.
