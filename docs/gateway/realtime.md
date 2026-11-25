# Realtime API over WebSocket (card 30.5)

Live voice applications built on OpenAI's Realtime API work through DiRouter unchanged: point the
SDK's `baseURL` at the gateway and use a DiRouter key. WebRTC is not covered; the browser uses the
WebSocket transport with a client secret.

| Endpoint                             | Purpose                                                                          |
| ------------------------------------ | -------------------------------------------------------------------------------- |
| `GET /v1/realtime?model=…` (upgrade) | The session; events are relayed both ways                                        |
| `POST /v1/realtime/client_secrets`   | GA: a short-lived client secret for a browser (`{ value, expires_at, session }`) |
| `POST /v1/realtime/sessions`         | Beta: the same, shaped as `{ …session, client_secret: { value, expires_at } }`   |

```ts
import OpenAI from 'openai';
import { OpenAIRealtimeWS } from 'openai/realtime/ws';

const client = new OpenAI({
  apiKey: process.env.DIROUTER_KEY,
  baseURL: 'https://api.example.com/v1',
});
const rt = new OpenAIRealtimeWS({ model: 'openai/gpt-realtime' }, client);
rt.on('session.created', () => rt.send({ type: 'response.create' }));
```

## Authentication

- **Server side:** the virtual key as `Authorization: Bearer …` (or `x-api-key`, or Azure's `api-key`).
- **Browser:** a browser cannot set headers on a WebSocket. Your server asks for a client secret
  with its key and hands the `value` (it starts with `ek_`) to the page, which connects with the
  subprotocols `realtime` and `openai-insecure-api-key.<secret>`. The virtual key itself also works
  in that subprotocol, but never ship it to a browser.

```bash
curl https://api.example.com/v1/realtime/client_secrets \
  -H "authorization: Bearer $DIROUTER_KEY" -H 'content-type: application/json' \
  -d '{ "expires_after": { "anchor": "created_at", "seconds": 600 },
        "session": { "type": "realtime", "model": "openai/gpt-realtime", "instructions": "Be brief." } }'
```

A client secret is signed by the gateway (HMAC-SHA256 under a key derived from `KEY_PEPPER`), so
every replica accepts it without shared state. It carries the key ID, the model, its expiry
(10 seconds to 2 hours, 10 minutes by default; the beta endpoint always gives one minute) and the
session configuration, which is sent to the provider as a `session.update` as soon as the session
opens (at most 8 KB). It never contains the virtual key, only opens a session (no other endpoint
accepts it, and it cannot mint another secret), only before it expires, and only while its key is
still enabled. When the secret names a model the URL may leave `model` out, and any other model is
refused. The key's IP allowlist applies when the secret is minted, not when a browser uses it.

## Opening a session

The handshake runs the same checks as any request and answers with an HTTP status, like OpenAI:

| Check                                                    | Refusal                                    |
| -------------------------------------------------------- | ------------------------------------------ |
| Key or client secret                                     | 401                                        |
| `model` missing, or the model has no realtime capability | 400                                        |
| Unknown or forbidden model                               | 404 / 403                                  |
| Gateway draining, or `REALTIME_MAX_SESSIONS` reached     | 503                                        |
| Rate limit (the session counts as one request)           | 429                                        |
| Budget already spent                                     | 429 `budget_exceeded`                      |
| Wallet cannot hold one response's worth                  | 402 `insufficient_credit`                  |
| Key's `maxConcurrency` (each open session holds a slot)  | 429                                        |
| Every target failed                                      | the provider's error class (502, 503, 504) |

A model serves realtime sessions when its `realtime` capability is on and its provider is of type
`openai`, `openai-compatible`, `azure-openai` or `mock`:

| Provider type                   | Upstream                                                                                                                              | Auth               |
| ------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| openai, openai-compatible, mock | `{baseUrl}/realtime?model={upstreamModel}`                                                                                            | Bearer             |
| azure-openai                    | `{baseUrl}/openai/v1/realtime?model={deployment}` (beta: `/openai/realtime?api-version=…&deployment=…`, `options.realtimeApiVersion`) | `api-key` or Entra |

Combos work: targets are tried in order (with the combo's retry policy and fallback classes, the
circuit breakers and the credential/provider/global outbound proxy) until one accepts the
upgrade. A 401 from the provider disables the credential as for chat. **Fallback happens only
before the session exists:** the client socket is upgraded only after a provider has accepted
one, and once it is open a provider failure closes the session (its close code is passed on).

The beta protocol is chosen by the client (`OpenAI-Beta: realtime=v1` or the
`openai-beta.realtime-v1` subprotocol) and passed on to the provider. Events are relayed
unchanged in both directions, except that `session.*` events show DiRouter's model name to the
client and the provider's name upstream.

## Metering and billing

Each `response.done` is metered from its `usage` and becomes one usage event (`inboundApi`
`openai.realtime`, request ID `<session>_<n>`), so a long session is billed as it goes:

- `usage` holds the text (and image) tokens: input, cached input as cache reads, and output.
- `media.audioInputTokens`, `media.audioCachedTokens` and `media.audioOutputTokens` hold the
  audio tokens, priced at the model's `audioInputPerMTok` and `audioOutputPerMTok` (the text rates
  when unset); cached audio is priced at `cacheReadPerMTok`.
- `media.textCostUsd` and `media.audioCostUsd` split the event's `costUsd`, and
  `media.sessionId` groups the events of one session. All of it lands in `request_log.media`.

Model prices and the capability are set in the dashboard's model form, through
`POST/PATCH /orgs/:orgId/models` (`pricing.audioInputPerMTok`, `pricing.audioOutputPerMTok`,
`capabilities.realtime`), or by the catalog sync, which reads LiteLLM's audio token prices for
models named `*realtime*`. Migration `20261126130500_realtime_audio_prices` adds the two columns.

After each response the gateway adds its cost and tokens to the budgets, counts its tokens toward
the rate limit, and charges the wallet: the session keeps a hold large enough for one more
response (8,192 audio tokens in and 4,096 out at the most expensive candidate's sale price); the
hold gives way to the response's actual charge and must then fit again. When a budget, the wallet
or a limit runs out, the client gets an `error` event that says which (`budget_exceeded`,
`insufficient_credit`, `rate_limit_exceeded`) and the session closes with code 1008.

Not metered: the separate input transcription usage some providers report on
`conversation.item.input_audio_transcription.completed` (it is priced by another model).

## Closing

A session is never cut mid-response:

| Cause                                        | What the client sees                                                                           |
| -------------------------------------------- | ---------------------------------------------------------------------------------------------- |
| Client closes                                | The response in progress is cancelled upstream, billed, then the upstream socket closes        |
| `REALTIME_MAX_SESSION_SECONDS` reached       | The response finishes, `error` `session_expired`, close 1000                                   |
| Budget, wallet or limit exhausted            | The response in progress is cancelled and billed, `error` with the reason, close 1008          |
| Drain deadline (`SHUTDOWN_DRAIN_MS`) reached | The response finishes (or is cancelled after 2 s), `error` `gateway_shutting_down`, close 1001 |
| Provider closes                              | The same close code (1011 when it was abnormal)                                                |

During drain `/readyz` turns 503 and new sessions are refused with 503, while open sessions keep
running until the drain deadline. Each session is pinged every 30 seconds in both directions to
keep intermediaries from treating it as idle. The `dirouter_realtime_sessions` gauge counts the
open sessions per replica.

## Traefik

The `/v1/realtime` router passes the upgrade through without compression or retry; see
[traefik.md](../traefik.md).

## Tests

- `apps/gateway/src/realtime.test.ts`: the official SDK (`openai/realtime/ws`) through a TLS
  terminator in front of the gateway; metering split; client secrets (GA and beta, browser
  subprotocols, forgery, re-minting, wrong model); handshake refusals; fallback before the session;
  the key's concurrency cap; client disconnect mid-response; session expiry; the replica cap; drain;
  and, with `INTEGRATION_VALKEY_URL`, budget and wallet exhaustion.
- `apps/mock-provider/src/realtime.test.ts` and `packages/providers/src/realtime.test.ts`.
- `scripts/e2e/sprint-5/30.5.mjs`: a browser-style session through Traefik with a client secret,
  billing in `request_log`, handshake refusals and budget exhaustion.
