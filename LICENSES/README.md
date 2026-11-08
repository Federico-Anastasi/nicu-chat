# Third-party licenses

What the product carries from other projects, with the license text of each in this folder. The list comes from the
lockfiles (`web/package-lock.json`, `infer/package-lock.json`) and from the built bundle. Nicu's own code is
AGPL-3.0-or-later (`../LICENSE`); see `../NOTICE.md`.

## In the web bundle (what a visitor's browser downloads)

| Package | Version | License | Text |
|---|---|---|---|
| [react](https://github.com/facebook/react), react-dom, scheduler | 19.2.7 / 19.2.7 / 0.27.0 | MIT (Meta Platforms) | `react-MIT.txt` |
| [onnxruntime-web](https://github.com/microsoft/onnxruntime) and onnxruntime-common, with the `.wasm` binaries served from `/wasm/` | 1.18.0 | MIT (Microsoft) | `onnxruntime-MIT.txt` |
| Components inside ONNX Runtime's binaries | | various, listed by ONNX Runtime | `onnxruntime-ThirdPartyNotices.txt` |
| [flatbuffers](https://github.com/google/flatbuffers) (inside onnxruntime-web) | 1.12.0 | Apache-2.0 | `flatbuffers-Apache-2.0.txt` |
| [long](https://github.com/dcodeIO/long.js) (inside onnxruntime-web) | 5.3.2 | Apache-2.0 | `long-Apache-2.0.txt` |
| [protobufjs](https://github.com/protobufjs/protobuf.js) (inside onnxruntime-web) | 7.6.4 | BSD-3-Clause | `protobufjs-BSD-3-Clause.txt` |
| @protobufjs/* modules (aspromise, base64, codegen, eventemitter, fetch, float, path, pool, utf8) | see lockfile | BSD-3-Clause | `protobufjs-modules-BSD-3-Clause.txt` |
| [platform](https://github.com/bestiejs/platform.js) (inside onnxruntime-web) | 1.3.6 | MIT | `platform-MIT.txt` |
| [guid-typescript](https://github.com/NicolasDeveloper/guid-typescript) (inside onnxruntime-web) | 1.0.9 | ISC, as declared in its `package.json` | the package ships no license text |

`@types/node` and `undici-types` appear in the web lockfile as type definitions only and are not bundled.

## In the inference server (`infer/`, also what the Docker image installs)

| Package | Version | License | Text |
|---|---|---|---|
| [onnxruntime-node](https://github.com/microsoft/onnxruntime) and onnxruntime-common | 1.18.0 | MIT (Microsoft) | `onnxruntime-MIT.txt` |
| tar | 7.5.22 | BlueOak-1.0.0 | `tar-BlueOak-1.0.0.txt` |
| minipass, yallist | 7.1.3, 5.0.0 | BlueOak-1.0.0 | `minipass-BlueOak-1.0.0.txt`, `yallist-BlueOak-1.0.0.txt` |
| chownr | 3.0.0 | BlueOak-1.0.0 | `chownr-license.txt` |
| minizlib | 3.1.0 | MIT | `minizlib-MIT.txt` |
| @isaacs/fs-minipass | 4.0.1 | ISC | `fs-minipass-ISC.txt` |

`tar` and its dependencies are used by `onnxruntime-node` when it installs.

## Only to build or test

Vite, TypeScript, `@vitejs/plugin-react` and the type packages are installed by `npm install` in `web/` but are not
part of what is served. `scripts/verify.mjs` and `infer/test.mjs` use `onnxruntime-node` as above.

## Not here

The model weights are not third-party code but a separate work of the author, under CC-BY-NC-4.0: see `../NOTICE.md`.
