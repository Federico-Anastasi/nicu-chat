# Licensing

Copyright (C) 2026 Federico Anastasi.

Nicu's code is free software: you can use it, study it, change it and share it. If you distribute a modified version, or
let people use one over a network, you must offer its source code under the same license. The model weights are a
separate work with a non-commercial license.

| What | License |
|---|---|
| The code: `web/`, `infer/`, `tools/`, `assets/gen_diagrams.py`, and everything else not listed below | [AGPL-3.0-or-later](LICENSE) |
| The model weights (on [Hugging Face](https://huggingface.co/federico-anastasi/nicu-20m)) and the tokenizer that belongs to them (`web/public/nicu-l-v11-dpo2-s2.tokenizer.json`) | CC-BY-NC-4.0: non-commercial use, attribution required, see [MODEL_CARD.md](MODEL_CARD.md) |
| Third-party code that ends up in the web bundle or the server | their own licenses, listed below |

The name "Nicu" and the character's artwork used as logo are covered by separate rules: see
[TRADEMARKS.md](TRADEMARKS.md).

The weights are not distributed with the code and are not covered by the AGPL: running or modifying the code does not
change the weights' license, and the weights' license does not restrict the code.

## Source code

The complete corresponding source of what runs at https://nicu.chat is this repository:
https://github.com/Federico-Anastasi/nicu-chat. The chat's information panel links to it. The backend that stores chats
when a visitor consents to it, and the data and training pipeline, are not part of what runs in the visitor's browser or
in `infer/`, and are not in this repository.

## Third-party components

These keep their original licenses; the texts are in [`LICENSES/`](LICENSES/), and the full list of what ends up in the
web bundle and in the server is in [`LICENSES/README.md`](LICENSES/README.md). The main ones:

| Component | Where it ends up | License |
|---|---|---|
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-web` 1.18.0, with its `.wasm` binaries) | web bundle and `/wasm/` files of the site | MIT |
| [ONNX Runtime](https://github.com/microsoft/onnxruntime) (`onnxruntime-node` 1.18.0) | inference server | MIT |
| [React](https://github.com/facebook/react) and `react-dom` 19 | web bundle | MIT |

The programs used only to build or test (Vite, TypeScript, the React plugin) are not distributed with the product.
