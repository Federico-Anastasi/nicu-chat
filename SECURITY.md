# Security

## Reporting a vulnerability

Report it privately with GitHub's "Report a vulnerability" button, in this repository's Security tab. Please don't open a
public issue for a vulnerability.

Only the latest release is supported: fixes ship in a new release.

## What Nicu protects, and what it doesn't

Nicu is a chat with a small language model; it has no accounts and no tools, and the model can only produce text.

- **The inference server** (`infer/`) checks every request before it reaches the model: the body is at most 64 KB, a
  message at most 500 characters, history at most 20 turns of 2,000 characters each, and the sampling parameters are
  clamped to fixed ranges. It sends no CORS headers, so other web pages cannot read its answers from a visitor's browser.
  Each generation has a 20-second limit, by default at most four run at once with eight more waiting, and further requests get a
  "busy" error.
- **Rate limit.** Each client gets 20 requests per minute. The client is identified by a salted hash of its address,
  kept only in memory; the salt is set with `NICU_IP_SALT` (random at each start if not set). The address is taken from
  the first value of the `X-Forwarded-For` header, so the server must run behind a proxy that sets that header itself:
  exposed directly, a client could choose its own identity and sidestep the limit. The server speaks plain HTTP: put TLS
  in the proxy.
- **The server's own log** records, for each request, the time, path, status, outcome, duration and the number of
  tokens, never the text of the messages and never the address.
- **Chats in the web app.** The current chat is saved in the browser's storage on the visitor's device. The app sends a
  finished exchange (the text as typed, the answer, a session identifier, the sampling parameters, the model name and
  whether the device is a phone or a computer) to `/api/log` only after the visitor consents, and the consent can be
  withdrawn at any time. The page does not clean the text, which is why it asks visitors not to write personal data. The
  backend that receives these exchanges is not in this repository, so what happens to them afterwards is described in
  the site's privacy notice (`web/public/privacy.html`), not here.
- **On-device mode.** The model runs in the browser: no text is sent to the inference server while it answers.
- **The model itself** is small and can say wrong or odd things. Nothing it says is verified information.
