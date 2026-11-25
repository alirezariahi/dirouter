---
'@dirouter/gateway': minor
'@dirouter/mock-provider': minor
'@dirouter/contracts': minor
'@dirouter/providers': minor
'@dirouter/model-catalog': minor
'@dirouter/db': minor
'@dirouter/control-api': minor
'@dirouter/dashboard': minor
---

Realtime API over WebSocket: `GET /v1/realtime?model=…` relays OpenAI Realtime sessions to
OpenAI, OpenAI-compatible and Azure providers, authenticated with a virtual key (header or the
`openai-insecure-api-key.` subprotocol) or a short-lived client secret from
`POST /v1/realtime/client_secrets` (beta: `/v1/realtime/sessions`) for browsers. Targets fall back
only before the session is established. Every response is billed as it finishes, with text and
audio tokens priced apart (new `audioInputPerMTok` and `audioOutputPerMTok` model prices and the
`realtime` capability, migration `20261126130500_realtime_audio_prices`) and the split recorded in
the request log. Budgets, the wallet and rate limits are enforced during the session, which closes
with a clear error event when one runs out; `REALTIME_MAX_SESSION_SECONDS` and
`REALTIME_MAX_SESSIONS` cap its length and the sessions per replica. Drain, expiry and client
disconnects let the response in progress finish or cancel and bill it before the close frame.
The mock provider gains a Realtime endpoint and Traefik a WebSocket router for `/v1/realtime`.
