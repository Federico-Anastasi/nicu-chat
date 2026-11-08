# Nicu Web — the chat

The chat app of **Nicu** (~20M parameters), live at https://nicu.chat. By
default it answers **from the server** (`../infer/`): visitors start typing
right away without downloading anything. One button ("on your computer / phone
/ tablet") downloads the model and answers **from the device**, even offline.
React 19 + TypeScript + Vite; the interface text and code comments are in
Italian.

## Served model

```
nicu-l-v11-dpo2-s2.tokenizer.json   ByteLevel BPE tokenizer (vocab 6000, pinned to the checkpoint) — in the repo
nicu-l-v11-dpo2-s2.kv.int8.onnx     int8, 20.6M parameters, 15 layers, context 512, with KV cache (~24 MB): default
nicu-l-v11-dpo2-s2.int8.onnx        same model without KV cache: fallback if the cached one fails to start
```

The `.onnx` files are not in the repo: download them from
[Hugging Face](https://huggingface.co/federico-anastasi/nicu-20m) into
`public/` (commands in the top-level README).

**Single source of truth: `src/core/config.ts`** — the model id logged with each
turn, file names, `versione` (a cache-buster to bump whenever an `.onnx` is
regenerated), vocabulary, context, layers/heads/head size for the KV cache,
output reserve, history cap and the default sampling parameters. `src/core/`,
`scripts/verify.mjs`, `../infer/` and the Docker build all read it.

Export: `python ../tools/export_onnx.py --ckpt nicu-L.pt --int8 [--kv-cache]`
(with `do_constant_folding=True`, otherwise int8 does not really quantize).

## Structure

```
src/
├── core/        shared by the page and the server, no browser dependencies
│                config · tokenizer · prompt (token-based window) · sampler (penalty → temperature →
│                top-p, without sorting the whole vocabulary) · genera (loop, stop sequences, truncation) ·
│                passo (one model step, with or without KV cache, for onnxruntime-web or node) · casuale (seeded RNG)
├── lib/
│   ├── chat.ts            chat state (useChat, actions): mode, fallback, persistence, stop/retry, phases
│   ├── motore.ts          remote engine: streaming POST /api/chat (SSE), timeouts, error mapping
│   ├── motoreLocale.ts    the only import() of the local engine: onnxruntime-web loads only when needed
│   ├── inference*.ts      local engine: Web Worker with main-thread fallback
│   ├── cacheModello.ts · modelloLocale.ts   download into Cache Storage with progress, ORT session
│   ├── archivio.ts        localStorage (chat, mode, consent) with try/catch and validation
│   ├── offline.ts         Service Worker registration and new-version notice
│   └── logger.ts · share.ts · ambiente.ts
├── ui/          components (conversation, composer, info panel, modal, states, …)
├── testi.ts     every interface string (claim, suggestions, notices, consent, states)
└── App.tsx
sw.template.js   hand-written Service Worker: the plugin in vite.config.ts compiles it to dist/sw.js on every build
```

## How a message goes

1. The prompt is built from the message and the most recent turns (no cap on
   turns, window computed in tokens). Memory can be switched off in the info
   panel.
2. **Server** (default): `POST /api/chat` with message, history and
   parameters; the server generates with the same core and streams tokens back.
   First event within 8 s, then at most 20 s of silence; after 4 s without
   tokens the state becomes "slow" (with a Stop button).
3. **Device**: same core in a Web Worker with onnxruntime-web; each step yields
   the logits and the sampler picks. Repetition penalty 1.15 **on the current
   turn and generated tokens only, never on the history**; temperature 1.0;
   top-p 0.92. Stops on `<|endoftext|>`, `maxNew`, or `\nUtente:` / `\nNicu:`.
4. **Fallback**: server unreachable, 503 or no first event → if the model is
   already on the device it answers (and says so); for 30 s requests go straight
   to the device. A 429 never falls back. If the local engine cannot start, the
   chat goes back to the server.

## Chat, consent, log

- The current chat is saved on the device and comes back when the page reopens;
  "New chat" clears it, with a 5 s undo.
- Consent is asked once, at the first message, plus a permanent line under the
  input. The legal text is `public/privacy.html`.
- Log: after each completed exchange the page sends `POST /api/log`
  (fire-and-forget) with `model` and `backend` (`server` or `wasm`), only if the
  visitor consented. Stopped or failed exchanges are not logged. The backend that
  receives it is not part of this repository; without one the request fails
  silently. On `*.hf.space` the logger points to `https://nicu.chat` and the page
  only offers the on-device mode.

## First visit

Server mode: ~0.2 MB compressed (JS ~76 KB, CSS, UI images in WebP of 4-13 KB).
The model (~24 MB), ORT's wasm (~10 MB) and the tokenizer are downloaded only
when the on-device mode is chosen, and then stay in Cache Storage.

## onnxruntime-web: pinned to 1.18 (do not upgrade lightly)

Some iPhones/iPads fail with `no available backend found / previous call to
'initWasm()' failed`:
1. **ORT ≥ 1.19 ships only SIMD binaries**: on iOS < 16.4 there is no backend.
   1.18 is the last release with the non-SIMD `ort-wasm.wasm`.
2. **WebGPU must not be the first attempt**: on iOS its init can fail and poison
   the shared WASM runtime.

In force: `import * as ort from 'onnxruntime-web/wasm'` (WASM-only build: ORT picks
SIMD or non-SIMD at runtime), `ort.env.wasm.wasmPaths = '/wasm/'`,
`numThreads = 1` (no SharedArrayBuffer, no COOP/COEP). Upgrading ORT needs an
explicit SIMD check with a fallback, and WebGPU excluded on iOS. Model opset 17.

## Commands

```bash
cd web
npm install                       # copies ORT's .wasm files into public/wasm/ (postinstall)
npm run dev                       # http://localhost:5173
npm run build && npm run verify
# with the real server: in ../infer  PORT=8300 node server.mjs
npx vite preview --port 5200      # /api/chat → :8300 (or NICU_INFER=http://host:port)
```

`scripts/verify.mjs` (Node 24, imports `src/core/` directly) checks against
independent references: config = served files; tokenizer = HuggingFace
`tokenizers` on 1,530 sentences; prompt construction on 51 cases; greedy with
and without cache = onnxruntime Python on 40 prompts; fixed-seed sampling =
reference. The references live in `scripts/fixtures/`; the Python-side ones
(`riferimenti_python.json`) come from the training pipeline, which is not in this
repository, while `node scripts/fixtures/rigenera_campionamento.mjs` regenerates
the fixed-seed sampling reference with the model in `public/`.

## Server headers

No COOP/COEP; only `Cross-Origin-Resource-Policy: same-origin`. `.onnx` files
`immutable`; `/wasm/` `no-cache` (the `.wasm` files have fixed names).
