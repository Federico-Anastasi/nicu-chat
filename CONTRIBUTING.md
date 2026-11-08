# Contributing to Nicu

Thanks for helping. Nicu is a small project: the fastest way to get a change in is to talk about it first.

## Issues

- **Bugs**: open an issue with what you did, what you expected and what happened, the browser and device, and whether
  Nicu was answering from the server or from the device.
- **Security problems**: never in a public issue, see [SECURITY.md](SECURITY.md).
- **Ideas and larger changes**: open an issue before writing code, so we can agree on the direction.
- Don't paste real conversations that contain other people's personal data.
- You can write issues and pull requests in English or Italian.

## Pull requests

- One change per pull request, with a short description of what it does and how you tested it.
- Code, comments and identifiers are in Italian, like the rest of the code; the READMEs and the model card are in
  English. The interface speaks Italian only, because Nicu does.
- The data pipeline and the training are not in this repository, so changes to what the model says can't be made here:
  pull requests are for the chat (`web/`), the server (`infer/`) and the export tool (`tools/`).
- If you change `web/src/core/`, the server and the page must keep producing the same text for the same prompt and
  seed: the checks below enforce it.

## Build and test

Node 24 or later. The model files are not in the repository: download them as described in
[README.md](README.md#run-locally).

```bash
cd web   && npm install && npm run build && npm run verify   # tokenizer, prompt, generation, sampling against references
cd infer && npm install && NICU_TEST=1 PORT=8300 node server.mjs   # leave it running, then in another terminal:
cd infer && npm test                                         # parity with the page, streaming, limits, load
```

## License and name

By contributing you agree that your contribution is licensed under the project's code license, AGPL-3.0-or-later (see
[NOTICE.md](NOTICE.md)). There is no CLA. The model weights are not covered by it. The name and logo are not covered by
the code's license either: a fork or a modified version needs its own name and logo, see [TRADEMARKS.md](TRADEMARKS.md).
